/**
 * Parity contract — the declarative source-of-truth for CLI ↔ MCP
 * envelope equality, per design §4.3.
 *
 * Each `ParitySpec` describes how to compare the result of an action
 * called over the CLI transport with the result of the same action
 * called over the MCP `tools/call` transport:
 *
 *   - `action`            — fully qualified action key, e.g.
 *                           `workflow.describe`. Stable across
 *                           transports (the CLI subcommand path and the
 *                           MCP tool name compose to the same key).
 *   - `fieldsRequiringEquality` — dot-paths that must deep-equal across
 *                           transports after `normalize` has been
 *                           applied. Mismatch is a parity bug.
 *   - `fieldsAllowedToDiffer`   — dot-paths that may differ legitimately,
 *                           e.g. `_transport.requestId` (one is a
 *                           commander request id, the other is an MCP
 *                           request id). Listed explicitly so a future
 *                           reader can audit the carve-outs.
 */
export type ParitySpec = {
  action: string;
  fieldsRequiringEquality: string[];
  fieldsAllowedToDiffer: string[];
};

/**
 * Live contract entries. Add new actions as parity tests need them.
 *
 * Mid-flight correction note (2026-05-05): the original design proposed
 * `view.describe`, `view.event_log`, `view.rehydrate`. Those actions do
 * not exist on `exarchos_view`. The corrected mapping is:
 *   - describe → `exarchos_workflow.describe`
 *   - event log → `exarchos_event.query`
 *   - rehydrate → `exarchos_workflow.rehydrate`
 * See plan §"Mid-flight correction" for the full migration table.
 */
export const PARITY_CONTRACT: ParitySpec[] = [
  {
    action: 'workflow.describe',
    // The CLI/MCP envelope wraps the workflow document under `data` —
    // see `wf status --json` and `exarchos_workflow.get` outputs. The
    // parity check uses literal dot-paths (resolveDotPath in this
    // file), so the leading `data.` is required.
    fieldsRequiringEquality: ['data.phase', 'data.featureId', 'data.tasks'],
    fieldsAllowedToDiffer: ['_transport.requestId'],
  },
  {
    action: 'event.query',
    // `event query --stream <id>` (CLI) and `exarchos_event.query` (MCP)
    // both return the canonical result envelope:
    //   { success, data: [...events], next_actions, _meta, _perf }
    // The user-meaningful core is the events array under `data` plus
    // the boolean `success` and empty `next_actions`. After
    // `normalize`, per-event `sequence` and `timestamp` are replaced
    // with placeholders so the events array deep-compares cleanly.
    // `_meta` and `_perf` are intentionally NOT required: `_perf.ms`
    // and `_perf.bytes`/`_perf.tokens` are non-deterministic across
    // runs, and `_meta` may carry transport-specific advisory keys.
    fieldsRequiringEquality: ['success', 'data', 'next_actions'],
    fieldsAllowedToDiffer: ['_transport.requestId', '_meta', '_perf'],
  },
  {
    action: 'workflow.rehydrate',
    // `wf rehydrate --feature-id <id>` (CLI) and `exarchos_workflow.rehydrate`
    // (MCP) both return the canonical result envelope:
    //   { success, data: <RehydrationDocument>, next_actions, _meta,
    //     _perf, _cacheHints }
    // where the rehydration document is `{ v, projectionSequence,
    // behavioralGuidance, workflowState, taskProgress, decisions,
    // artifacts, blockers }` (see
    // `src/workflow/rehydrate.ts`).
    //
    // Required-equality dot-paths cover:
    //   - `success`              — boolean status; both must succeed.
    //   - `data.workflowState`   — canonical workflow state record
    //                              (featureId, phase, workflowType).
    //                              The single most user-meaningful slice
    //                              of the document.
    //   - `data.taskProgress`    — derived task list folded from
    //                              `task.assigned` / `task.completed`
    //                              events. Order and per-task fields
    //                              must agree across transports.
    //   - `data.projectionSequence` — sequence number of the last event
    //                              folded into the projection. After the
    //                              same N events on both sides this MUST
    //                              equal — divergence here flags a
    //                              projection-determinism bug. NOT
    //                              normalized away (`projectionSequence`
    //                              is not in `SEQUENCE_KEYS`), so we get
    //                              real numeric equality, not placeholder
    //                              equality.
    //
    // `_cacheHints` is allowed to differ: it carries advisory caching
    // metadata (`ttl`, `position`) that is transport-shape-stable today
    // but is not part of the load-bearing reconstructability invariant —
    // F6.1 only requires the projection itself reconstruct identically.
    fieldsRequiringEquality: [
      'success',
      'data.workflowState',
      'data.taskProgress',
      'data.projectionSequence',
    ],
    fieldsAllowedToDiffer: [
      '_transport.requestId',
      '_meta',
      '_perf',
      '_cacheHints',
    ],
  },
];

/**
 * Resolve a dot-path (e.g. `data.featureId`) against a value. Returns
 * `{ found: true, value }` or `{ found: false }` so callers can
 * distinguish a missing path from a present-but-undefined value.
 */
function resolveDotPath(
  source: unknown,
  dotPath: string,
): { found: true; value: unknown } | { found: false } {
  const parts = dotPath.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false };
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return { found: true, value: cursor };
}

/**
 * Assert that two envelopes (one from CLI, one from MCP) match according
 * to a `ParitySpec`. Throws an `Error` whose message includes the
 * offending dot-path on first divergence so vitest's failure renderer
 * shows the diff inline.
 *
 * Allowed-to-differ paths are not checked; required paths must be
 * present on both sides and `===`/deep-equal after normalization. We
 * use a structural string compare via JSON for complex values to keep
 * the helper dependency-free.
 */
export function assertParity(
  cliResult: unknown,
  mcpResult: unknown,
  spec: ParitySpec,
): void {
  for (const dotPath of spec.fieldsRequiringEquality) {
    const cli = resolveDotPath(cliResult, dotPath);
    const mcp = resolveDotPath(mcpResult, dotPath);

    if (!cli.found || !mcp.found) {
      const missing: string[] = [];
      if (!cli.found) missing.push('cli');
      if (!mcp.found) missing.push('mcp');
      throw new Error(
        `parity violation [${spec.action}]: required field "${dotPath}" missing from ` +
          `${missing.join(' and ')}`,
      );
    }

    const cliJson = JSON.stringify(cli.value);
    const mcpJson = JSON.stringify(mcp.value);
    if (cliJson !== mcpJson) {
      throw new Error(
        `parity violation [${spec.action}]: required field "${dotPath}" differs — ` +
          `cli=${cliJson} mcp=${mcpJson}`,
      );
    }
  }
}
