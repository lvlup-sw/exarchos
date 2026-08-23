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
import { publishTempFile } from '../utils/atomic-write.js';
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
 * Matches an orphaned temp state file, capturing the writer's pid.
 *
 * - group 1 — the temp kind (`tmp` for updates, `init` for creation).
 * - group 2 — the writer's **pid**, anchored to end-of-string.
 *
 * The optional `(?:\d+\.)?` in between absorbs the in-process counter without
 * capturing, so `match[2]` is the pid for both `.tmp.<counter>.<pid>` (current)
 * and `.tmp.<pid>` (legacy, pre-counter) filenames.
 */
export const TEMP_FILE_PATTERN = /\.(tmp|init)\.(?:\d+\.)?(\d+)$/;

/**
 * Extract the writing process's pid from a temp state filename, or `null` if the
 * name is not a temp file / carries no parseable pid. The sweep gates deletion on
 * this pid's liveness, so returning a counter here would strand temp files
 * forever — see {@link TEMP_FILE_PATTERN}.
 */
export function extractTempFilePid(filename: string): number | null {
  const match = filename.match(TEMP_FILE_PATTERN);
  if (!match) return null;
  const pid = parseInt(match[2] ?? '', 10);
  return Number.isNaN(pid) ? null : pid;
}

/**
 * Process-lifetime-monotonic counter. Never reset — resetting would reintroduce
 * the collision this exists to prevent (a second writer reusing a live writer's
 * suffix). Node executes JS on one thread, so `++` is atomic here and every
 * caller observes a distinct value even under concurrent async writers.
 */
let _tempFileCounter = 0;

/**
 * The temp-path format itself, as a pure function — the single place the segment
 * ORDER is decided. `counter` before `pid` keeps the pid trailing, which is what
 * makes {@link TEMP_FILE_PATTERN}'s end-anchored group land on the pid.
 *
 * Exported so the writer/sweep round trip can be tested at arbitrary
 * counter/pid combinations — notably the adversarial case where a counter's
 * value collides with a live pid, which is unreachable through
 * {@link nextTempPath} alone (its counter starts at 1 and only ever climbs).
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
 * Build a collision-free temp path for `stateFile`. Unique per writer (counter)
 * and per process (pid), with the pid last so the orphan sweep still reads it —
 * see {@link TEMP_FILE_PATTERN}.
 */
export function nextTempPath(stateFile: string, kind: 'tmp' | 'init'): string {
  return formatTempPath(stateFile, kind, ++_tempFileCounter, process.pid);
}

// ─── Module-Level StorageBackend ──────────────────────────────────────────────

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

/** Extract featureId from a state file path (e.g., "/dir/my-feature.state.json" -> "my-feature"). */
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

// ─── Initial Phase by Workflow Type ────────────────────────────────────────
// Now delegated to state-machine.ts getInitialPhase() for built-in + custom types

// ─── State Store Error ─────────────────────────────────────────────────────
// `StateStoreError`, `ReservedFieldErrorData`, and `resolveAlternateWritePath`
// now live in `./state-mutation.js` (imported + re-exported above) so the
// workflow-state projection can share them without the runtime import cycle.
// `VersionConflictError` stays here — it is the CAS-conflict specialization the
// store raises, and nothing at the leaf needs it.

export class VersionConflictError extends StateStoreError {
  constructor(expected: number, actual: number) {
    super('VERSION_CONFLICT', `Version conflict: expected ${expected}, actual ${actual}`);
    this.name = 'VersionConflictError';
  }
}

// ─── Initialize a New State File ───────────────────────────────────────────

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

  // Delegate to backend if available
  if (_stateStoreBackend) {
    // Use version 0 as expectedVersion for exclusive-create semantics:
    // setState with expectedVersion=0 only succeeds if no state exists yet
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

    // #1504 — the SQLite backend is the authoritative store; no `.state.json`
    // crash-backup is written. A derived file on disk would go stale and could
    // shadow the projection (the bug #1504 fixes); the no-read/write gate
    // (1504-4) forbids `.state.json` I/O in production. `stateFile` is returned
    // as a stable path identifier only — callers must not assume it exists.
    return { stateFile, state };
  }

  // Ensure directory exists
  await fs.mkdir(stateDir, { recursive: true });

  // Write via temp file + atomic link for crash safety.
  // link() fails with EEXIST if target exists, preserving exclusive-create semantics.
  // On crash before link(), only the temp file remains — no corrupt state file.
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
    // Always clean up temp file (link created a second hard link to same inode)
    await fs.unlink(tmpPath).catch(() => {});
  }

  return { stateFile, state };
}

// ─── Read and Validate a State File (with Migration) ───────────────────────

export async function readStateFile(stateFile: string): Promise<WorkflowState> {
  // Delegate to backend if available
  if (_stateStoreBackend) {
    const featureId = extractFeatureIdFromPath(stateFile);
    const state = _stateStoreBackend.getState(featureId);
    if (!state) {
      throw new StateStoreError(
        ErrorCode.STATE_NOT_FOUND,
        `State not found in backend for featureId: ${featureId}`,
      );
    }
    // Structural validation: ensure required fields exist (schema format rules may differ from backend)
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
    raw = await fs.readFile(stateFile, 'utf-8');
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

  // Backup state file before migration if version differs
  const parsedObj = parsed as Record<string, unknown>;
  if (parsedObj.version && parsedObj.version !== CURRENT_VERSION) {
    await backupStateFile(stateFile);
  }

  // Run migration if needed
  let migrated: unknown;
  try {
    migrated = migrateState(parsed);
  } catch (err) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Migration failed for state file: ${stateFile} — ${(err as Error).message}`,
    );
  }

  // Validate against schema
  const result = WorkflowStateSchema.safeParse(migrated);
  if (!result.success) {
    throw new StateStoreError(
      ErrorCode.STATE_CORRUPT,
      `Schema validation failed for state file: ${stateFile} — ${result.error.message}`,
    );
  }

  return result.data;
}

// ─── Version Helper ─────────────────────────────────────────────────────────

/** Extract the CAS version from a workflow state, defaulting to 1 for legacy files. */
function getStateVersion(state: WorkflowState): number {
  return (state as Record<string, unknown>)._version as number ?? 1;
}

// ─── Write State File Atomically ───────────────────────────────────────────


/**
 * Write a workflow state file atomically using tmp+rename.
 *
 * When `expectedVersion` is provided, performs a Compare-And-Swap (CAS) check:
 * reads the current file's `_version` and compares it to `expectedVersion`.
 * If they don't match, throws `VersionConflictError`.
 *
 * **TOCTOU Note:** The CAS check has a time-of-check-to-time-of-use window
 * between the version read and the atomic write (tmp+rename). This is acceptable
 * because the MCP server runs as a single process with async serialization —
 * concurrent writes only arise from interleaved async operations within the same
 * event loop, not from separate processes. The atomic tmp+rename prevents file
 * corruption, and the CAS version check prevents lost updates from concurrent
 * async operations. For multi-process scenarios, file-level locking (e.g., `flock`)
 * would be needed.
 */
export async function writeStateFile(
  stateFile: string,
  state: WorkflowState,
  options?: { expectedVersion?: number; skipValidation?: boolean },
): Promise<void> {
  // Delegate to backend if available
  if (_stateStoreBackend) {
    const featureId = extractFeatureIdFromPath(stateFile);

    // Auto-increment _version before writing
    const stateWithVersion = {
      ...state,
      _version: getStateVersion(state) + 1,
    } as WorkflowState;

    // Validate before writing
    if (!options?.skipValidation) {
      const validation = WorkflowStateSchema.safeParse(stateWithVersion);
      if (!validation.success) {
        throw new StateStoreError(
          ErrorCode.INVALID_INPUT,
          `Write-time validation failed: ${validation.error.message}`,
        );
      }
    }

    try {
      _stateStoreBackend.setState(featureId, stateWithVersion, options?.expectedVersion);
    } catch (err) {
      // Re-throw backend version conflicts as state-store VersionConflictErrors
      if (err instanceof Error && err.name === 'VersionConflictError') {
        const message = err.message;
        // Parse expected and actual from the error message
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

    // #1504 — backend is the authoritative store; no `.state.json`
    // write-through. The derived file is never written in backend mode so it
    // cannot go stale or shadow the projection.
    return;
  }

  // CAS check: if expectedVersion is provided, verify it matches the current file
  if (options?.expectedVersion !== undefined) {
    let currentVersion = 1;
    try {
      const raw = await fs.readFile(stateFile, 'utf-8');
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        currentVersion = typeof parsed._version === 'number' ? parsed._version : 1;
      } catch {
        // File exists but has invalid JSON — surface corruption instead of masking it
        throw new StateStoreError(
          ErrorCode.STATE_CORRUPT,
          `Cannot perform CAS check — state file has invalid JSON: ${stateFile}`,
        );
      }
    } catch (err) {
      if (err instanceof StateStoreError) throw err; // re-throw STATE_CORRUPT
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist — version 1 is correct for first write
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

  // Auto-increment _version before writing
  const stateWithVersion = {
    ...state,
    _version: getStateVersion(state) + 1,
  } as WorkflowState;

  // Validate before writing to catch schema violations at write time (not deferred to read)
  if (!options?.skipValidation) {
    const validation = WorkflowStateSchema.safeParse(stateWithVersion);
    if (!validation.success) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `Write-time validation failed: ${validation.error.message}`,
      );
    }
  }

  const tmpPath = nextTempPath(stateFile, 'tmp');
  try {
    await fs.writeFile(tmpPath, JSON.stringify(stateWithVersion, null, 2), 'utf-8');
    await publishTempFile(tmpPath, stateFile);
  } catch (err) {
    // Clean up temp file if rename failed
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write state file: ${stateFile} — ${(err as Error).message}`,
    );
  }
}

// ─── Apply Dot-Path Update ─────────────────────────────────────────────────
// `isPlainObject`, `deepMerge`, and `applyDotPath` (with the private `parsePath`
// / `assertArrayBounds` helpers) now live in `./state-mutation.js` (imported +
// re-exported above). The projection folds `state.patched` with the SAME
// `applyDotPath` the on-disk write uses, so `fold ≡ write` (#1504/#1554) holds
// across the extraction — the primitives are byte-identical, only relocated.

// ─── List State Files ──────────────────────────────────────────────────────

export interface ListStateFilesResult {
  valid: Array<{ featureId: string; stateFile: string; state: WorkflowState }>;
  corrupt: Array<{ featureId: string; stateFile: string; error: string }>;
}

export async function listStateFiles(
  stateDir: string,
): Promise<ListStateFilesResult> {
  // Delegate to backend if available
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

  // Clean up orphaned temp files from crashed writes. The pid — never the
  // in-process counter — gates deletion; see TEMP_FILE_PATTERN for why the
  // filename puts the pid last to guarantee that.
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

// ─── Apply Event to State ───────────────────────────────────────────────────
// The former in-place `applyEventToState` fold was deleted in #1554: it was the
// last duplicate of the canonical workflow-state fold (a parallel
// `switch (event.type)` over WorkflowEvent that derived a WorkflowStateView).
// `reconcileFromEvents` now folds through `workflowStateProjection.apply` — the
// single registered `workflow-state@v1` reducer — so reconcile and
// `resolveWorkflowState` can never diverge (its `state.patched` deepMerge vs the
// canonical applyDotPath was the last dual-mutation gap). The single-fold CI
// gate (`tools/audit/gates/check-single-workflow-fold.mjs`) keeps it that way.

// ─── Hydrate Events from Store ──────────────────────────────────────────────

/**
 * Query all events for a feature from the event store and map them to
 * the internal format used by guards and the `_events` materialized view.
 *
 * Maps external types (e.g. `workflow.transition`) to internal types
 * (e.g. `transition`) via `mapExternalToInternalType`, spreads all
 * `e.data` fields at the top level, and preserves `metadata: e.data`
 * for backward compatibility.
 *
 * Callers decide catch semantics: `handleSet` falls back to an empty
 * array on failure, while `reconcileFromEvents` logs a warning.
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

// ─── Reconcile State from Events ────────────────────────────────────────────

/**
 * Rebuild a workflow state file from events in the JSONL event store.
 *
 * If no state file exists and the first event is `workflow.started`, creates
 * the state file via `initStateFile`. Then replays all events with sequence
 * numbers greater than the state's `_eventSequence` (defaulting to 0).
 *
 * This function is idempotent — running it twice with no new events produces
 * the same state and returns `{ reconciled: false, eventsApplied: 0 }`.
 */
export async function reconcileFromEvents(
  stateDir: string,
  featureId: string,
  eventStore: EventStore,
): Promise<{ reconciled: boolean; eventsApplied: number }> {
  // Merge hook-event sidecar files written by CLI hook subprocesses before
  // querying, so reconcile sees the complete event stream. The previous
  // `!eventStore.inSidecarMode` gate is gone — sidecar fallback in the
  // EventStore was deleted in v2.11 (#1082); this merger now exclusively
  // reconciles hook-subprocess writes.
  await mergeSidecarEvents(stateDir, eventStore).catch((err) => {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Hook-event sidecar merge before reconcile failed — continuing with existing events',
    );
  });

  const stateFile = path.join(stateDir, `${featureId}.state.json`);

  // Read existing state or create from workflow.started event
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
    // If no state file, query all events to find workflow.started
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
    // Fix 1: Preserve original event timestamp instead of "now"
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

  // Fix 2: Capture CAS version before applying events
  const initialVersion = getStateVersion(state);

  // Query only new events using sinceSequence for efficiency (Fix 3)
  const newEvents = currentSeq > 0
    ? await eventStore.query(featureId, { sinceSequence: currentSeq })
    : (await eventStore.query(featureId)).filter((e) => e.sequence > currentSeq);

  if (newEvents.length === 0) {
    return { reconciled: false, eventsApplied: 0 };
  }

  // Fold new events through the single canonical workflow-state reducer
  // (#1554) instead of the former duplicate `applyEventToState` (deleted). This
  // retires the last dual-mutation divergence: `applyEventToState`'s
  // `state.patched` used `deepMerge` (whole-array clobber), whereas the
  // canonical fold uses `applyDotPath` (the #1504 array-index in-place fix), so
  // reconcile and resolveWorkflowState now agree byte-for-byte. `eventsApplied`
  // counts events the fold acted on (reference-changed result) — for the
  // mutating events reconcile callers exercise (started/transition/checkpoint/
  // state.patched/merge.*) this preserves the pre-#1554 count contract.
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

  // Carry the folded result forward as the state to reconcile + persist.
  state = folded as unknown as WorkflowState;
  const stateRecord = state as unknown as Record<string, unknown>;

  // Update _eventSequence
  stateRecord._eventSequence = maxSequence;

  // Phase reconciliation: compare state.phase against last workflow.transition
  // event from the delta. applyEventToState already sets the phase during the
  // scan loop, so this is a consistency check using the tracked transition
  // rather than issuing a redundant full-stream query.
  if (lastTransition?.data) {
    const eventPhase = (lastTransition.data as Record<string, unknown>).to as string | undefined;
    if (eventPhase && stateRecord.phase !== eventPhase) {
      stateRecord.phase = eventPhase;
      if (!eventsApplied) eventsApplied = 1; // Mark as reconciled even if only phase was fixed
    }
  }

  // Hydrate _events from full event stream for guard evaluation.
  // This ensures guards (e.g. teamDisbandedEmitted) can evaluate from
  // the materialized _events view after reconciliation.
  try {
    stateRecord._events = await hydrateEventsFromStore(featureId, eventStore);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to hydrate _events during reconcile — guards may fail',
    );
  }

  // Write updated state with CAS guard, retrying on version conflict.
  // The backend's version counter can desync from state._version (e.g., after
  // DB self-healing or mixed JSONL-only/backend usage). Reconcile is a recovery
  // operation, so retry by re-reading the current backend version.
  try {
    await writeStateFile(stateFile, state, { expectedVersion: initialVersion });
  } catch (err) {
    if (err instanceof VersionConflictError) {
      // Re-read to get the backend's actual version, then force-write
      try {
        const freshState = await readStateFile(stateFile);
        const freshVersion = getStateVersion(freshState);
        await writeStateFile(stateFile, state, { expectedVersion: freshVersion });
      } catch (retryErr) {
        if (retryErr instanceof VersionConflictError) {
          // Last resort: write without CAS — reconcile IS the recovery mechanism
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

// ─── Resolve State Directory ───────────────────────────────────────────────

// Re-export centralized resolver for backward compatibility
export { resolveStateDir } from '../utils/paths.js';
