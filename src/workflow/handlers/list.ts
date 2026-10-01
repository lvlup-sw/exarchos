import type { ToolResult } from '../../format.js';
import { isStale } from '../checkpoint.js';
import { listStateFiles } from '../state-store.js';
import type { ListInput } from '../types.js';

/**
 * List the workflows that have a valid state file.
 * Each entry includes `_checkpoint`, so the prune handler can read `lastActivityTimestamp`.
 */
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
