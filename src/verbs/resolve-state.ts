/**
 * Resolves workflow state for a feature.
 * The SQLite event store is the source of truth. The `.state.json` file on disk is a derived stamp.
 * The resolver reads the file only when the caller supplies no event store.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { EventStore } from '../events/store.js';
import type { ToolResult } from '../format.js';
import { workflowStateProjection } from '../projections/views/workflow-state-projection.js';

export interface ResolveOpts {
  /** Path to a JSON state file on disk. */
  stateFile?: string | undefined;
  /** Feature/stream ID for event store lookup. */
  featureId?: string | undefined;
  /** Event store instance for in-memory state materialization. */
  eventStore?: EventStore | undefined;
}

export type ResolveResult =
  | { state: Record<string, unknown> }
  | { error: ToolResult };

/**
 * Classification of an explicit `stateFile` path:
 *   - 'absent'    — no path supplied
 *   - 'missing'   — path supplied but the file does not exist
 *   - 'malformed' — file exists but is unreadable or not valid JSON
 *   - 'ok'        — file exists and parses as JSON
 */
export type StateFileStatus = 'absent' | 'missing' | 'malformed' | 'ok';

/**
 * Classifies an explicit `stateFile` path and changes nothing.
 * {@link resolveWorkflowState} ignores the file when an event store is supplied.
 * Without an event store, it reports a malformed file as `NO_STATE_SOURCE`, the same as a missing file.
 * A missing `.state.json` is normal, but a corrupt file that the caller supplied is an error.
 * A caller that must report that error calls this function first.
 */
export function classifyStateFile(stateFile: string | undefined): StateFileStatus {
  if (!stateFile) return 'absent';
  if (!existsSync(stateFile)) return 'missing';
  try {
    JSON.parse(readFileSync(stateFile, 'utf-8'));
    return 'ok';
  } catch {
    return 'malformed';
  }
}

/**
 * Resolves workflow state from the best available source, in this order:
 * 1. With `featureId` and `eventStore`, it folds the stream through `workflowStateProjection`.
 * 2. Without an event store, it parses `stateFile` when the file exists.
 * 3. Otherwise it returns a `NO_STATE_SOURCE` error. A file that does not parse gives the same error.
 *
 * The file can go stale, so it never shadows the projection when an event store exists.
 * A caller that must compare the file with the projection reads the file directly.
 */
export async function resolveWorkflowState(opts: ResolveOpts): Promise<ResolveResult> {
  if (opts.featureId && opts.eventStore) {
    try {
      const events = await opts.eventStore.query(opts.featureId);

      const projection = workflowStateProjection;
      let view = projection.init();

      for (const event of events) {
        view = projection.apply(view, event);
      }

      return { state: view as unknown as Record<string, unknown> };
    } catch (err) {
      return {
        error: {
          success: false,
          error: {
            code: 'EVENT_STORE_ERROR',
            message: `Failed to materialize state from event store: ${err instanceof Error ? err.message : String(err)}`,
          },
        },
      };
    }
  }

  if (opts.stateFile && existsSync(opts.stateFile)) {
    try {
      const raw = readFileSync(opts.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { state: parsed };
    } catch {
    }
  }

  return {
    error: {
      success: false,
      error: {
        code: 'NO_STATE_SOURCE',
        message:
          'No state source available: provide a stateFile path or featureId + eventStore for in-memory resolution.',
      },
    },
  };
}
