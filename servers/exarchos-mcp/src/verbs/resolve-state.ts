// ─── Workflow State Resolution ──────────────────────────────────────────────
//
// Unified state resolution. The SQLite event store is the source of truth; the
// on-disk `.state.json` is a derived stamp consulted only when no event store
// is available. Resolution order (event-store-first, #1504):
//   1. Event store materialization (when featureId + eventStore are supplied)
//   2. State file on disk (fallback — legacy / CLI paths with no event store)
//   3. Error if neither source is available
//
// Replaces inline parseStateFile / existsSync patterns in
// post-delegation-check.ts and reconcile-state.ts.
// ────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync } from 'node:fs';
import type { EventStore } from '../events/store.js';
import type { ToolResult } from '../format.js';
import { workflowStateProjection } from '../projections/views/workflow-state-projection.js';

// ─── Types ──────────────────────────────────────────────────────────────────

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

// ─── State File Classification ────────────────────────────────────────────────

/**
 * Classify an explicit `stateFile` path WITHOUT mutating anything.
 *
 * {@link resolveWorkflowState} silently falls back to the event store when a
 * supplied `stateFile` is missing OR unparseable. That is the right behavior
 * for a *missing* derived stamp (INV-1: `.state.json` is optional), but it
 * masks a *corrupt* file the caller explicitly provided. Callers that need to
 * surface an explicit-file error should consult this first and report
 * `'malformed'` (and, when no event-store fallback exists, `'missing'`) rather
 * than letting the silent fallback collapse it into a misleading downstream
 * message.
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

// ─── State Resolution ───────────────────────────────────────────────────────

/**
 * Resolve workflow state from the best available source.
 *
 * Resolution order (event-store-first, #1504):
 * 1. If `featureId` and `eventStore` are provided, materialize state from the
 *    event store via projection — the authoritative source of truth.
 * 2. Otherwise, if a `stateFile` is provided and exists on disk, read and parse
 *    it (legacy / CLI fallback when no event store is available).
 * 3. If neither source is available, return a NO_STATE_SOURCE error.
 */
export async function resolveWorkflowState(opts: ResolveOpts): Promise<ResolveResult> {
  // ── Event store FIRST (#1504, INV-1) ──────────────────────────────────────
  // The SQLite event log is the source of truth; the on-disk `.state.json` is a
  // derived stamp that can go stale and silently SHADOW the authoritative
  // projection (the bug #1504 fixes). When the event store is available,
  // materialize from it. The file is a fallback ONLY when no event store is
  // supplied (CLI/legacy paths). For a caller that explicitly needs the on-disk
  // file (e.g. a file↔projection drift comparison), read it directly rather
  // than relying on resolution order.
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

  // ── Fallback: file-only resolution (no event store available) ─────────────

  if (opts.stateFile && existsSync(opts.stateFile)) {
    try {
      const raw = readFileSync(opts.stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { state: parsed };
    } catch {
      // File exists but is unreadable or invalid JSON — fall through to error
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
