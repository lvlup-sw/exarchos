import { EventStore } from '../../../events/store.js';
import { logger } from '../../../logger.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** List the event stream IDs through `EventStore.listStreams()`. Without a store, it returns an empty list. */
export async function discoverStreams(stateDir: string, store?: EventStore): Promise<string[]> {
  if (store) {
    return store.listStreams();
  }
  void stateDir;
  return [];
}

/**
 * Read `<workflowId>.state.json` for plan facts that the event projection cannot derive.
 * It returns `null` when the file is absent, unreadable or not a JSON object. The caller then uses the projection value.
 * An absent file is a normal case and logs nothing. Other read errors and parse errors log a warning, so corruption stays visible.
 */
export async function readWorkflowStateJson(
  stateDir: string,
  workflowId: string,
): Promise<Record<string, unknown> | null> {
  const file = path.join(stateDir, `${workflowId}.state.json`);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
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
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), file },
      'readWorkflowStateJson: failed to parse state.json — falling back to projection',
    );
    return null;
  }
}
