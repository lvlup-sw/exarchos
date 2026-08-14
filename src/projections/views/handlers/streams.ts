import { EventStore } from '../../../events/store.js';
import { logger } from '../../../logger.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Helper: discover all event stream files ───────────────────────────────

export async function discoverStreams(stateDir: string, store?: EventStore): Promise<string[]> {
  // v2.11 Phase 3 (substrate-cut): SQLite is the only substrate, so
  // stream discovery always flows through `EventStore.listStreams()`
  // (a SELECT DISTINCT streamId FROM events on the SqliteBackend).
  // The legacy JSONL `fs.readdir` fallback was removed alongside the
  // JSONL writer.
  if (store) {
    return store.listStreams();
  }
  // No store wired (synthetic test fixtures only) — return empty.
  void stateDir;
  return [];
}

// ─── Helper: read state.json (Fix 2 / #1184) ───────────────────────────────
//
// Several view handlers must consult `<id>.state.json` for plan-state facts
// that the event projection cannot derive (review status, declared task
// count, declared task list, dimension findings). The handlers stay
// best-effort: a missing/corrupt state file falls back to the projection-
// derived value rather than failing the view query, because state.json is
// the planner's stamp and not all callers (CLI tools, tests, in-flight
// workflows) will have one yet.
export async function readWorkflowStateJson(
  stateDir: string,
  workflowId: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(stateDir, `${workflowId}.state.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    // ENOENT is the legitimate "no plan-state stamp yet" case (CLI tools,
    // tests, in-flight workflows before first `workflow set`) — fall back
    // silently to projection-derived values. Other I/O errors are NOT
    // expected and would mask real corruption if treated as a clean miss.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'readWorkflowStateJson: I/O error reading state.json — falling back to projection',
    );
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    logger.warn(
      { file, type: Array.isArray(parsed) ? 'array' : typeof parsed },
      'readWorkflowStateJson: state.json is not an object — falling back to projection',
    );
    return null;
  } catch (err) {
    // Corrupt JSON: surface a warning so the corruption is observable in
    // logs even though we keep serving views from the projection. Without
    // this, a long-lived bad state.json would silently disagree with
    // workflow_status / synthesis_readiness / convergence forever.
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'readWorkflowStateJson: failed to parse state.json — falling back to projection',
    );
    return null;
  }
}
