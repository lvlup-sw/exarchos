import type { ToolResult } from '../../format.js';
import { isStale } from '../checkpoint.js';
import { listStateFiles } from '../state-store.js';
import type { ListInput } from '../types.js';

// ─── handleList ─────────────────────────────────────────────────────────────

export async function handleList(
  _input: ListInput,
  stateDir: string,
): Promise<ToolResult> {
  const { valid: entries, corrupt } = await listStateFiles(stateDir);

  const data = entries.map((entry) => ({
    featureId: entry.featureId,
    workflowType: entry.state.workflowType,
    phase: entry.state.phase,
    stateFile: entry.stateFile,
    stale: isStale(entry.state._checkpoint),
    // Expose `_checkpoint` so downstream consumers (e.g. prune-stale-workflows
    // `extractListEntries`) can read `lastActivityTimestamp` directly. Before
    // this field was added the prune handler saw every non-terminal workflow
    // as maximally stale because the fallback was `new Date(0)`.
    _checkpoint: entry.state._checkpoint,
  }));

  return {
    success: true,
    data,
    ...(corrupt.length > 0 && {
      warnings: corrupt.map((c) => `Corrupt state file: ${c.featureId} — ${c.error}`),
    }),
  };
}
