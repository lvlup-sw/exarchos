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
