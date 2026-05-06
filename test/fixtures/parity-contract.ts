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
    fieldsRequiringEquality: ['phase', 'featureId', 'tasks'],
    fieldsAllowedToDiffer: ['_transport.requestId'],
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
