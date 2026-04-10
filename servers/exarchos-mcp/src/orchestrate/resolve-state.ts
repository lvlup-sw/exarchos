// ─── Workflow State Resolution ──────────────────────────────────────────────
//
// Unified state resolution with fallback chain:
//   1. State file on disk (legacy / file-based workflows)
//   2. Event store materialization (MCP-managed workflows)
//   3. Error if neither source is available
//
// Replaces inline parseStateFile / existsSync patterns in
// post-delegation-check.ts and reconcile-state.ts.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import { workflowStateProjection } from '../views/workflow-state-projection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolveOpts {
  /** Path to a JSON state file on disk. */
  stateFile?: string;
  /** Feature/stream ID for event store lookup. */
  featureId?: string;
  /** Event store instance for in-memory state materialization. */
  eventStore?: EventStore;
}

export type ResolveResult =
  | { state: Record<string, unknown> }
  | { error: ToolResult };

// ─── State Resolution ───────────────────────────────────────────────────────

/**
 * Resolve workflow state from the best available source.
 *
 * Resolution order:
 * 1. If `stateFile` is provided and exists on disk, read and parse it.
 * 2. If the file is missing/unreadable, or no `stateFile` was provided,
 *    fall back to materializing state from the event store via projection.
 * 3. If neither source is available, return a NO_STATE_SOURCE error.
 */
export async function resolveWorkflowState(opts: ResolveOpts): Promise<ResolveResult> {
  // ── Try state file first ──────────────────────────────────────────────────

  if (opts.stateFile && existsSync(opts.stateFile)) {
    try {
      const raw = readFileSync(opts.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { state: parsed };
    } catch {
      // File exists but is unreadable or invalid JSON — fall through to event store
    }
  }

  // ── Fall back to event store materialization ──────────────────────────────

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

  // ── No source available ───────────────────────────────────────────────────

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
