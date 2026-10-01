import { WorkflowStateSchema, ErrorCode } from './schemas.js';
import { getInitialPhase } from './state-machine.js';
// State-mutation primitives (DR-4, task 009). Extracted to a leaf module so the
// projection can share them WITHOUT re-entering state-store — breaking the
// state-store ↔ workflow-state-projection runtime import cycle. Re-exported below
// so every existing `state-store.js` importer is unaffected.
import {
  StateStoreError,
  isPlainObject,
  deepMerge,
  applyDotPath,
  resolveAlternateWritePath,
  MAX_ARRAY_GAP,
  type ReservedFieldErrorData,
} from './state-mutation.js';
export {
  StateStoreError,
  isPlainObject,
  deepMerge,
  applyDotPath,
  resolveAlternateWritePath,
  MAX_ARRAY_GAP,
  type ReservedFieldErrorData,
};
import { migrateState, CURRENT_VERSION, backupStateFile } from './migration.js';
import { mapExternalToInternalType } from './events.js';
import type { WorkflowState, WorkflowType } from './types.js';
import type { EventStore } from '../events/store.js';
import type { WorkflowEvent } from '../events/schemas.js';
// Canonical workflow-state fold (#1554). Imported for its `apply` at call time
// only (inside reconcileFromEvents) — the state-store ↔ workflow-state-projection
// edge is a call-time-only ESM cycle (the projection imports isPlainObject/
// applyDotPath from here, also call-time), which live bindings resolve safely.
import { workflowStateProjection, type WorkflowStateView } from '../projections/views/workflow-state-projection.js';
import type { StorageBackend } from '../storage/backend.js';
import { mergeSidecarEvents } from '../storage/sidecar-merger.js';
import { isPidAlive } from '../utils/process.js';
import { publishTempFile, readPublished } from '../utils/atomic-write.js';
import { logger } from '../logger.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// ─── Temp-File Naming (collision-free, sweep-safe) ────────────────────────────
//
// A temp path of `<stateFile>.<kind>.<pid>` is unique across *processes* but NOT
// within one: two concurrent in-process writers to the same stateFile derive the
// identical path, then race — one writer truncates the temp file the other is
// still filling, and whichever renames first can publish a half-written payload
// (or the loser's rename fails ENOENT). A process-lifetime-monotonic counter
// makes the path unique per writer, restoring write/rename atomicity.
//
// WHERE the counter goes is load-bearing. The orphan sweep in `listStateFiles`
// reclaims temp files by extracting a PID and testing liveness. It reads the
// SECOND capture group of {@link TEMP_FILE_PATTERN}, whose PID group is anchored
// to `$`. So the counter is placed BEFORE the pid — `.tmp.<counter>.<pid>` — and
// matched by a NON-capturing optional group. Two properties fall out by
// construction:
//
//   1. The pid is always the trailing segment, so the end-anchored `(\d+)$`
//      group — i.e. `match[2]` — can only ever land on the pid.
//   2. Group numbering is unaffected by the counter, so the sweep's extraction
//      index does not shift.
//
// The naive alternative, `.tmp.<pid>.<counter>`, inverts this: the end-anchored
// group captures the COUNTER, so liveness is tested against a counter value
// rather than the writer. Whenever that value collides with a live pid, the
// sweep concludes the orphan is "still being written" and never reaps it — a
// silent, permanent temp-file leak. Counters are small and dense, so collisions
// are routine rather than exotic. Keeping the pid last makes the whole class
// unrepresentable instead of merely unlikely.
//
// The counter segment is OPTIONAL in the pattern so temp files written by an
// older version (`.tmp.<pid>`, no counter) remain reapable after upgrade.


/**
 * The workflow state store. It reads, writes, and lists workflow state through
 * the module-level storage backend, or through `.state.json` files when no
 * backend is set. It re-exports the state-mutation primitives of the leaf module
 * `state-mutation.js`, and `resolveStateDir` for backward compatibility.
 */
export {
};


// State-mutation primitives (DR-4, task 009). Extracted to a leaf module so the
// projection can share them WITHOUT re-entering state-store — breaking the
// state-store ↔ workflow-state-projection runtime import cycle. Re-exported below
// so every existing `state-store.js` importer is unaffected.
export {
};
// Canonical workflow-state fold (#1554). Imported for its `apply` at call time
// only (inside reconcileFromEvents) — the state-store ↔ workflow-state-projection
// edge is a call-time-only ESM cycle (the projection imports isPlainObject/
// applyDotPath from here, also call-time), which live bindings resolve safely.
// ─── Temp-File Naming (collision-free, sweep-safe) ────────────────────────────
//
// A temp path of `<stateFile>.<kind>.<pid>` is unique across *processes* but NOT
// within one: two concurrent in-process writers to the same stateFile derive the
// identical path, then race — one writer truncates the temp file the other is
// still filling, and whichever renames first can publish a half-written payload
// (or the loser's rename fails ENOENT). A process-lifetime-monotonic counter
// makes the path unique per writer, restoring write/rename atomicity.
//
// WHERE the counter goes is load-bearing. The orphan sweep in `listStateFiles`
// reclaims temp files by extracting a PID and testing liveness. It reads the
// SECOND capture group of {@link TEMP_FILE_PATTERN}, whose PID group is anchored
// to `$`. So the counter is placed BEFORE the pid — `.tmp.<counter>.<pid>` — and
// matched by a NON-capturing optional group. Two properties fall out by
// construction:
//
//   1. The pid is always the trailing segment, so the end-anchored `(\d+)$`
//      group — i.e. `match[2]` — can only ever land on the pid.
//   2. Group numbering is unaffected by the counter, so the sweep's extraction
//      index does not shift.
//
// The naive alternative, `.tmp.<pid>.<counter>`, inverts this: the end-anchored
// group captures the COUNTER, so liveness is tested against a counter value
// rather than the writer. Whenever that value collides with a live pid, the
// sweep concludes the orphan is "still being written" and never reaps it — a
// silent, permanent temp-file leak. Counters are small and dense, so collisions
// are routine rather than exotic. Keeping the pid last makes the whole class
// unrepresentable instead of merely unlikely.
//
// The counter segment is OPTIONAL in the pattern so temp files written by an
// older version (`.tmp.<pid>`, no counter) remain reapable after upgrade.
/**
 * The workflow state store. It reads, writes, and lists workflow state through
 * the module-level storage backend, or through `.state.json` files when no
 * backend is set. It re-exports the state-mutation primitives of the leaf module
 * `state-mutation.js`, and `resolveStateDir` for backward compatibility. The
 * primitives live in the leaf module, so the workflow-state projection can use
 * them without an import cycle through this module.
 */
export {
};

/**
 * Matches an orphaned temp state file. Group 1 is the temp kind: `tmp` for an
 * update, `init` for a creation. Group 2 is the writer pid, at the end.
 *
 * The optional `(?:\d+\.)?` absorbs the in-process counter without a capture.
 * Thus `match[2]` is the pid for `.tmp.<counter>.<pid>` and for the older
 * `.tmp.<pid>` names. The pid must stay last. If the counter comes last, the
 * sweep tests liveness against the counter. Then an orphan whose counter equals
 * a live pid stays on disk forever.
 */
export const TEMP_FILE_PATTERN = /\.(tmp|init)\.(?:\d+\.)?(\d+)$/;

/**
 * Extract the writer pid from a temp state filename, or `null` when the name is
 * not a temp file or has no pid. The sweep deletes a file only when this pid is
 * dead, so a counter returned here strands temp files.
 */
export function extractTempFilePid(filename: string): number | null {
  const match = filename.match(TEMP_FILE_PATTERN);
  if (!match) return null;
  const pid = parseInt(match[2] ?? '', 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Monotonic counter for the life of the process. Without it, two in-process
 * writers to one state file derive the same temp path and race. Never reset it.
 * Node runs JS on one thread, so `++` gives each caller a distinct value.
 */
let _tempFileCounter = 0;

/**
 * The temp-path format, the one place that decides the segment order. The
 * counter comes before the pid, so the end-anchored group of
 * {@link TEMP_FILE_PATTERN} lands on the pid.
 *
 * It is exported so a test can try any counter and pid, also a counter equal to
 * a live pid. {@link nextTempPath} cannot choose those values, because its
 * counter starts at 1 and only climbs.
 */
export function formatTempPath(
  stateFile: string,
  kind: 'tmp' | 'init',
  counter: number,
  pid: number,
): string {
  return `${stateFile}.${kind}.${counter}.${pid}`;
}

/**
 * Build a collision-free temp path for `stateFile`. The counter makes it unique
 * for each writer, and the pid for each process. The pid comes last, so the
 * orphan sweep reads it.
 */
export function nextTempPath(stateFile: string, kind: 'tmp' | 'init'): string {
  return formatTempPath(stateFile, kind, ++_tempFileCounter, process.pid);
}

/** Module-level storage backend. When set, state operations delegate here. */
let _stateStoreBackend: StorageBackend | undefined;

/**
 * Configure the module-level storage backend for state operations.
 * Pass `undefined` to reset to file-based mode.
 */
export function configureStateStoreBackend(backend: StorageBackend | undefined): void {
  _stateStoreBackend = backend;
}

/** Safe pattern for feature IDs: alphanumeric, dots, underscores, and hyphens. */
const SAFE_FEATURE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Extract featureId from a state file path: "/dir/my-feature.state.json" gives "my-feature". */
function extractFeatureIdFromPath(stateFile: string): string {
  const basename = path.basename(stateFile);
  const featureId = basename.replace('.state.json', '');

  if (!SAFE_FEATURE_ID_PATTERN.test(featureId)) {
    throw new StateStoreError(
      ErrorCode.INVALID_INPUT,
      `Invalid featureId "${featureId}" extracted from path: must match ${SAFE_FEATURE_ID_PATTERN}`,
    );
  }

  return featureId;
}

/** The compare-and-swap conflict error that the store raises. */
export class VersionConflictError extends StateStoreError {
  constructor(expected: number, actual: number) {
    super('VERSION_CONFLICT', `Version conflict: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
  }
}

/**
 * Create the state for a new workflow, and fail when it already exists.
 *
 * With a backend, `setState` with expected version 0 gives exclusive-create
 * semantics. The backend is authoritative, so the function writes no
 * `.state.json`, and the returned `stateFile` is only a stable path identifier.
 * Without a backend, the state goes to a temp file, and `link()` publishes it.
 * `link()` fails with EEXIST when the file exists. A crash before `link()`
 * leaves only the temp file.
 */
export async function initStateFile(
  stateDir: string,
  featureId: string,
  workflowType: WorkflowType,
  extraFields?: Record<string, unknown>,
): Promise<{ stateFile: string; state: WorkflowState }> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);

  const now = new Date().toISOString();
  const initialPhase = getInitialPhase(workflowType);

  const rawState = {
    version: CURRENT_VERSION,
    featureId,
    workflowType,
    createdAt: now,
    updatedAt: now,
    phase: initialPhase,
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    explore: {},
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: now,
      phase: initialPhase,
      summary: 'Workflow initialized',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: now,
      staleAfterMinutes: 120,
    },
    ...extraFields,
  };

  const parseResult = WorkflowStateSchema.safeParse(rawState);
  if (!parseResult.success) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Failed to validate initial state: ${parseResult.error.message}`,
    );
  }

  const state = parseResult.data;

  if (_stateStoreBackend) {
    try {
      _stateStoreBackend.setState(featureId, state, 0);
    } catch (err) {
      if (err instanceof Error && err.name === 'VersionConflictError') {
        throw new StateStoreError(
          ErrorCode.STATE_ALREADY_EXISTS,
          `State already exists in backend for featureId: ${featureId}`,
        );
      }
      throw err;
    }

    return { stateFile, state };
  }

  await fs.mkdir(stateDir, { recursive: true });

  const tmpPath = nextTempPath(stateFile, 'init');
  try {
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write temp state file: ${stateFile} — ${(err as Error).message}`,
    );
  }
  try {
    await fs.link(tmpPath, stateFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StateStoreError(
        ErrorCode.STATE_ALREADY_EXISTS,
        `State file already exists: ${stateFile}`,
      );
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to create state file: ${stateFile} — ${(err as Error).message}`,
    );
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }

  return { stateFile, state };
}

/**
 * Read and validate workflow state, with migration. A backend read checks only
 * the required fields, because the schema format rules can differ from the
 * backend. A file read backs up the file first when its `version` is not the
 * current version.
 */
export async function readStateFile(stateFile: string): Promise<WorkflowState> {
  if (_stateStoreBackend) {
    const featureId = extractFeatureIdFromPath(stateFile);
    const state = _stateStoreBackend.getState(featureId);
    if (!state) {
      throw new StateStoreError(
        ErrorCode.STATE_NOT_FOUND,
        `State not found in backend for featureId: ${featureId}`,
      );
    }
    if (!state.featureId || !state.phase || !state.workflowType) {
      throw new StateStoreError(
        ErrorCode.STATE_CORRUPT,
        `Corrupted backend state for featureId: ${featureId} — missing required fields`,
      );
    }
    return state;
  }

  let raw: string;

  try {
    raw = await readPublished(stateFile, () => fs.readFile(stateFile, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StateStoreError(
        ErrorCode.STATE_NOT_FOUND,
        `State file not found: ${stateFile}`,
      );
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to read state file: ${stateFile}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Invalid JSON in state file: ${stateFile}`,
    );
  }

  const parsedObj = parsed as Record<string, unknown>;
  if (parsedObj.version && parsedObj.version !== CURRENT_VERSION) {
    await backupStateFile(stateFile);
  }

  let migrated: unknown;
  try {
    migrated = migrateState(parsed);
  } catch (err) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Migration failed for state file: ${stateFile} — ${(err as Error).message}`,
    );
  }

  const result = WorkflowStateSchema.safeParse(migrated);
  if (!result.success) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Schema validation failed for state file: ${stateFile} — ${result.error.message}`,
    );
  }

  return result.data;
}

/** Extract the CAS version from a workflow state, defaulting to 1 for legacy files. */
function getStateVersion(state: WorkflowState): number {
  return (state as Record<string, unknown>)._version as number ?? 1;
}

/**
 * The write-time schema check, exported for callers other than the write path.
 *
 * `handleSet` records a `state.patched` event before it writes. It calls this
 * check before the append, with the same schema and `_version` bump as the
 * write. Thus the log does not keep a patch that the write then rejects.
 */
export function validateStateForWrite(state: WorkflowState): string | undefined {
  const stateWithVersion = {
    ...state,
    _version: getStateVersion(state) + 1,
  } as WorkflowState;
  const validation = WorkflowStateSchema.safeParse(stateWithVersion);
  return validation.success ? undefined : `Write-time validation failed: ${validation.error.message}`;
}

/**
 * Write workflow state atomically through a temp file and a rename.
 *
 * With `expectedVersion`, a compare-and-swap check reads the current `_version`
 * and throws `VersionConflictError` on a mismatch. Invalid JSON gives
 * `STATE_CORRUPT`, and a missing file counts as version 1. The check has a
 * window before the write. That is safe while one process serializes the
 * writes. With a backend, the backend is authoritative, and the function writes
 * no `.state.json`.
 */
export async function writeStateFile(
  stateFile: string,
  state: WorkflowState,
  options?: { expectedVersion?: number; skipValidation?: boolean },
): Promise<void> {
  if (_stateStoreBackend) {
    const featureId = extractFeatureIdFromPath(stateFile);

    const stateWithVersion = {
      ...state,
      _version: getStateVersion(state) + 1,
    } as WorkflowState;

    if (!options?.skipValidation) {
      const invalid = validateStateForWrite(state);
      if (invalid !== undefined) throw new StateStoreError(ErrorCode.INVALID_INPUT, invalid);
    }

    try {
      _stateStoreBackend.setState(featureId, stateWithVersion, options?.expectedVersion);
    } catch (err) {
      if (err instanceof Error && err.name === 'VersionConflictError') {
        const message = err.message;
        const match = message.match(/expected (\d+), actual (\d+)/);
        if (match) {
          throw new VersionConflictError(parseInt(match[1] ?? '0', 10), parseInt(match[2] ?? '0', 10));
        }
        throw new VersionConflictError(
          options?.expectedVersion ?? 0,
          0,
        );
      }
      throw err;
    }

    return;
  }

  if (options?.expectedVersion !== undefined) {
    let currentVersion = 1;
    try {
      const raw = await readPublished(stateFile, () => fs.readFile(stateFile, 'utf-8'));
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        currentVersion = typeof parsed._version === 'number' ? parsed._version : 1;
      } catch {
        throw new StateStoreError(
          ErrorCode.STATE_CORRUPT,
          `Cannot perform CAS check — state file has invalid JSON: ${stateFile}`,
        );
      }
    } catch (err) {
      if (err instanceof StateStoreError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        currentVersion = 1;
      } else {
        throw new StateStoreError(
          ErrorCode.FILE_IO_ERROR,
          `Cannot read state file for CAS check: ${stateFile}`,
        );
      }
    }

    if (options.expectedVersion !== currentVersion) {
      throw new VersionConflictError(options.expectedVersion, currentVersion);
    }
  }

  const stateWithVersion = {
    ...state,
    _version: getStateVersion(state) + 1,
  } as WorkflowState;

  if (!options?.skipValidation) {
    const invalid = validateStateForWrite(state);
    if (invalid !== undefined) throw new StateStoreError(ErrorCode.INVALID_INPUT, invalid);
  }

  const tmpPath = nextTempPath(stateFile, 'tmp');
  try {
    await fs.writeFile(tmpPath, JSON.stringify(stateWithVersion, null, 2), 'utf-8');
    await publishTempFile(tmpPath, stateFile);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write state file: ${stateFile} — ${(err as Error).message}`,
    );
  }
}

export interface ListStateFilesResult {
  valid: Array<{ featureId: string; stateFile: string; state: WorkflowState }>;
  corrupt: Array<{ featureId: string; stateFile: string; error: string }>;
}

/**
 * List the workflow states as valid or corrupt. Without a backend, it first
 * deletes the orphaned temp files whose writer pid is dead.
 */
export async function listStateFiles(
  stateDir: string,
): Promise<ListStateFilesResult> {
  if (_stateStoreBackend) {
    const states = _stateStoreBackend.listStates();
    const valid: Array<{ featureId: string; stateFile: string; state: WorkflowState }> = [];
    const corrupt: Array<{ featureId: string; stateFile: string; error: string }> = [];
    for (const { featureId, state } of states) {
      if (state.featureId && state.phase && state.workflowType) {
        valid.push({ featureId, stateFile: path.join(stateDir, `${featureId}.state.json`), state });
      } else {
        corrupt.push({ featureId, stateFile: path.join(stateDir, `${featureId}.state.json`), error: 'Missing required fields' });
      }
    }
    return { valid, corrupt };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { valid: [], corrupt: [] };
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to read state directory: ${stateDir}`,
    );
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  for (const tmpFile of entries) {
    const pid = extractTempFilePid(tmpFile);
    if (pid !== null && !isPidAlive(pid)) {
      await fs.unlink(path.join(stateDir, tmpFile)).catch(() => {});
    }
  }

  const valid: ListStateFilesResult['valid'] = [];
  const corrupt: ListStateFilesResult['corrupt'] = [];

  for (const file of stateFiles) {
    const stateFile = path.join(stateDir, file);
    const featureId = file.replace('.state.json', '');
    try {
      const state = await readStateFile(stateFile);
      valid.push({ featureId, stateFile, state });
    } catch (err) {
      corrupt.push({
        featureId,
        stateFile,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { valid, corrupt };
}

/**
 * Query all events for a feature and map them to the internal format of the
 * guards and the `_events` view.
 *
 * `mapExternalToInternalType` maps each type, such as `workflow.transition` to
 * `transition`. The `e.data` fields go to the top level, and `metadata` keeps
 * `e.data` for backward compatibility. Callers handle a failure. `handleSet`
 * keeps its existing `_events`, and `reconcileFromEvents` logs a warning.
 */
export async function hydrateEventsFromStore(
  featureId: string,
  eventStore: EventStore,
): Promise<readonly Record<string, unknown>[]> {
  const storeEvents = await eventStore.query(featureId);
  return storeEvents.map((e) => ({
    type: mapExternalToInternalType(e.type),
    timestamp: e.timestamp,
    ...(e.data as Record<string, unknown> ?? {}),
    metadata: e.data as Record<string, unknown> ?? {},
  }));
}

/** How marking tasks complete on the state document came out. */
export type TaskStatusSyncOutcome =
  | { readonly kind: 'synced'; readonly updated: readonly string[]; readonly missing: readonly string[] }
  | { readonly kind: 'unchanged'; readonly missing: readonly string[] }
  | {
      readonly kind: 'skipped';
      readonly reason: 'no-document' | 'tasks-not-an-array' | 'tasks-not-found';
      readonly missing: readonly string[];
    }
  | { readonly kind: 'failed'; readonly attempts: number; readonly error: string };

/**
 * Mark tasks `complete` on the state document of the workflow.
 *
 * The transition guards read `state.tasks[].status` from the document, not from
 * the event log. Thus a completion fact admits nothing until the document
 * agrees. The loop uses compare-and-swap on `_version` and retries a conflict,
 * so two parallel writers cannot lose an update.
 *
 * A task that the document does not list goes into `missing`. The outcome is
 * `skipped` when `tasks` is not an array, no task is found, or there is no
 * document. A corrupt document or a conflict past the retries gives `failed`.
 */
export async function markTasksCompleteInStateDocument(
  stateFile: string,
  taskIds: readonly string[],
  maxAttempts = 3,
): Promise<TaskStatusSyncOutcome> {
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const state = await readStateFile(stateFile);
      if (!Array.isArray(state.tasks)) {
        return { kind: 'skipped', reason: 'tasks-not-an-array', missing: [...taskIds] };
      }
      const tasks = state.tasks as Array<{ id: string; status: string }>;
      const updated: string[] = [];
      const missing: string[] = [];
      for (const taskId of taskIds) {
        const task = tasks.find((t) => t.id === taskId);
        if (!task) {
          missing.push(taskId);
          continue;
        }
        if (task.status === 'complete') continue;
        task.status = 'complete';
        updated.push(taskId);
      }
      if (updated.length === 0) {
        return missing.length === taskIds.length && taskIds.length > 0
          ? { kind: 'skipped', reason: 'tasks-not-found', missing }
          : { kind: 'unchanged', missing };
      }
      const rawVersion = (state as Record<string, unknown>)._version;
      const version = typeof rawVersion === 'number' ? rawVersion : 1;
      (state as Record<string, unknown>).updatedAt = new Date().toISOString();
      await writeStateFile(stateFile, state, { expectedVersion: version, skipValidation: true });
      return { kind: 'synced', updated, missing };
    } catch (err) {
      if (err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND) {
        return { kind: 'skipped', reason: 'no-document', missing: [...taskIds] };
      }
      lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof VersionConflictError && attempt < maxAttempts) continue;
      return { kind: 'failed', attempts: attempt, error: lastError };
    }
  }
  return { kind: 'failed', attempts: maxAttempts, error: lastError };
}

/**
 * Rebuild workflow state from the event store.
 *
 * It merges the hook-event sidecar files first. With no state, it creates the
 * state from a `workflow.started` event, if one exists, with its time. Then it
 * folds the events after `_eventSequence` through
 * `workflowStateProjection.apply`. It takes the phase from the last transition
 * event and hydrates `_events` for the guards. The backend version
 * can drift from `_version`. Thus a version conflict retries with the fresh
 * version and then writes without CAS, because reconcile is the recovery path.
 */
export async function reconcileFromEvents(
  stateDir: string,
  featureId: string,
  eventStore: EventStore,
): Promise<{ reconciled: boolean; eventsApplied: number }> {
  await mergeSidecarEvents(stateDir, eventStore).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Hook-event sidecar merge before reconcile failed — continuing with existing events',
    );
  });

  const stateFile = path.join(stateDir, `${featureId}.state.json`);

  let state: WorkflowState;
  let currentSeq = 0;
  try {
    state = await readStateFile(stateFile);
    const stateRecord = state as unknown as Record<string, unknown>;
    currentSeq = (stateRecord._eventSequence as number) ?? 0;
  } catch (err) {
    if (!(err instanceof StateStoreError && err.code === ErrorCode.STATE_NOT_FOUND)) {
      throw err;
    }
    const allEvents = await eventStore.query(featureId);
    if (allEvents.length === 0) {
      return { reconciled: false, eventsApplied: 0 };
    }
    const startedEvent = allEvents.find((e) => e.type === 'workflow.started');
    if (!startedEvent?.data) {
      return { reconciled: false, eventsApplied: 0 };
    }
    const data = startedEvent.data as Record<string, unknown>;
    const workflowType = data.workflowType as WorkflowType;
    const result = await initStateFile(stateDir, featureId, workflowType);
    state = result.state;
    const startedAt = startedEvent.timestamp;
    const stateRecord = state as unknown as Record<string, unknown>;
    stateRecord.createdAt = startedAt;
    stateRecord.updatedAt = startedAt;
    const checkpoint = stateRecord._checkpoint as Record<string, unknown> | undefined;
    if (checkpoint) {
      checkpoint.timestamp = startedAt;
      checkpoint.lastActivityTimestamp = startedAt;
    }
  }

  const initialVersion = getStateVersion(state);

  const newEvents = currentSeq > 0
    ? await eventStore.query(featureId, { sinceSequence: currentSeq })
    : (await eventStore.query(featureId)).filter((e) => e.sequence > currentSeq);

  if (newEvents.length === 0) {
    return { reconciled: false, eventsApplied: 0 };
  }

  let folded = state as unknown as WorkflowStateView;
  let eventsApplied = 0;
  let maxSequence = currentSeq;
  let lastTransition: WorkflowEvent | undefined;

  for (const event of newEvents) {
    const next = workflowStateProjection.apply(folded, event);
    if (next !== folded) {
      eventsApplied++;
    }
    folded = next;
    if (event.sequence > maxSequence) {
      maxSequence = event.sequence;
    }
    if (event.type === 'workflow.transition') {
      lastTransition = event;
    }
  }

  state = folded as unknown as WorkflowState;
  const stateRecord = state as unknown as Record<string, unknown>;

  stateRecord._eventSequence = maxSequence;

  if (lastTransition?.data) {
    const eventPhase = (lastTransition.data as Record<string, unknown>).to as string | undefined;
    if (eventPhase && stateRecord.phase !== eventPhase) {
      stateRecord.phase = eventPhase;
      if (!eventsApplied) eventsApplied = 1;
    }
  }

  try {
    stateRecord._events = await hydrateEventsFromStore(featureId, eventStore);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to hydrate _events during reconcile — guards may fail',
    );
  }

  try {
    await writeStateFile(stateFile, state, { expectedVersion: initialVersion });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      try {
        const freshState = await readStateFile(stateFile);
        const freshVersion = getStateVersion(freshState);
        await writeStateFile(stateFile, state, { expectedVersion: freshVersion });
      } catch (retryErr) {
        if (retryErr instanceof VersionConflictError) {
          await writeStateFile(stateFile, state);
        } else {
          throw retryErr;
        }
      }
    } else {
      throw err;
    }
  }

  return { reconciled: eventsApplied > 0, eventsApplied };
}

export { resolveStateDir } from '../utils/paths.js';
