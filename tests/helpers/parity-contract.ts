/**
 * The parity contract. It declares, for each action, the envelope fields that must be
 * equal between the CLI transport and the MCP `tools/call` transport.
 */

/** How to compare the CLI result and the MCP result of one action. */
export type ParitySpec = {
  /** The action key, such as `workflow.describe`. It is the same for both transports. */
  action: string;
  /** Dot-paths whose values must be equal across transports after `normalize`. */
  fieldsRequiringEquality: string[];
  /**
   * Dot-paths that can differ, such as `_transport.requestId`. `assertParity` does not
   * read the list. It records each exception for a reader.
   */
  fieldsAllowedToDiffer: string[];
};

/**
 * The contract entries. Add an action when a parity test needs it.
 * `exarchos_view` has no describe, event-log or rehydrate action. Those actions are
 * `exarchos_workflow.describe`, `exarchos_event.query` and `exarchos_workflow.rehydrate`.
 */
export const PARITY_CONTRACT: ParitySpec[] = [
  {
    action: 'workflow.describe',
    /**
     * The envelope holds the workflow document under `data`, and `resolveDotPath` takes
     * literal paths. Thus each path starts with `data.`.
     */
    fieldsRequiringEquality: ['data.phase', 'data.featureId', 'data.tasks'],
    fieldsAllowedToDiffer: ['_transport.requestId'],
  },
  {
    action: 'event.query',
    /**
     * `data` is `{ events, page }`. After `normalize`, the `sequence` and the `timestamp`
     * of each event are placeholders, so `data` compares cleanly.
     */
    fieldsRequiringEquality: ['success', 'data', 'next_actions'],
    /** `_perf` values change between runs, and `_meta` can hold advisory keys of one transport. */
    fieldsAllowedToDiffer: ['_transport.requestId', '_meta', '_perf'],
  },
  {
    action: 'workflow.rehydrate',
    /**
     * `data` is the rehydration document (see `src/workflow/rehydrate.ts`).
     * `data.taskProgress` is the task list that the projection folds from the task events.
     * `data.projectionSequence` is the sequence of the last folded event. `normalize` does
     * not replace it, so the comparison is on the real number. A difference after the same
     * events shows a projection that is not deterministic.
     */
    fieldsRequiringEquality: [
      'success',
      'data.workflowState',
      'data.taskProgress',
      'data.projectionSequence',
    ],
    /**
     * `_cacheHints` holds advisory cache metadata. The reconstruction invariant covers
     * only the projection.
     */
    fieldsAllowedToDiffer: [
      '_transport.requestId',
      '_meta',
      '_perf',
      '_cacheHints',
    ],
  },
];

/**
 * Resolves a dot-path such as `data.featureId` against a value. The `found` flag
 * separates a missing path from a path whose value is `undefined`.
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
 * Throws if the CLI envelope and the MCP envelope differ on a required path of `spec`.
 * Each required path must exist on both sides. The comparison is on the JSON text of the
 * two values, so key order counts and the caller must normalize both envelopes first.
 * The error names the first path that is missing or different.
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
