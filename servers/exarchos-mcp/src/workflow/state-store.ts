import { WorkflowStateSchema, ErrorCode, isReservedField } from './schemas.js';
import { migrateState, CURRENT_VERSION, backupStateFile } from './migration.js';
import type { WorkflowState, WorkflowType } from './types.js';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

// ─── Initial Phase by Workflow Type ────────────────────────────────────────

const INITIAL_PHASE: Record<WorkflowType, string> = {
  feature: 'ideate',
  debug: 'triage',
  refactor: 'explore',
};

// ─── State Store Error ─────────────────────────────────────────────────────

export class StateStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StateStoreError';
  }
}

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
  const initialPhase = INITIAL_PHASE[workflowType];

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

  // Ensure directory exists
  await fs.mkdir(stateDir, { recursive: true });

  // Write atomically with exclusive flag (fails if file exists)
  // This avoids TOCTOU race condition — no separate existence check needed
  try {
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      flag: 'wx', // exclusive create - fails with EEXIST if file exists
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new StateStoreError(
        ErrorCode.STATE_ALREADY_EXISTS,
        `State file already exists: ${stateFile}`,
      );
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to write state file: ${stateFile} — ${(err as Error).message}`,
    );
  }

  return { stateFile, state };
}

// ─── Read and Validate a State File (with Migration) ───────────────────────

export async function readStateFile(stateFile: string): Promise<WorkflowState> {
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
  // CAS check: if expectedVersion is provided, verify it matches the current file
  if (options?.expectedVersion !== undefined) {
    let currentVersion = 1;
    try {
      const raw = await fs.readFile(stateFile, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      currentVersion = typeof parsed._version === 'number' ? parsed._version : 1;
    } catch {
      // If file doesn't exist or is unreadable, default to version 1
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

  const tmpPath = `${stateFile}.tmp.${process.pid}`;
  try {
    await fs.writeFile(tmpPath, JSON.stringify(stateWithVersion, null, 2), 'utf-8');
    await fs.rename(tmpPath, stateFile);
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

/**
 * Check if a value is a plain object (not null, not array).
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge source into target, returning a new merged object.
 * Arrays are replaced, not merged.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (isPlainObject(result[key]) && isPlainObject(source[key])) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>,
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Parse a dot-path string into segments, handling array bracket notation.
 * Example: "tasks[0].status" -> ["tasks", 0, "status"]
 */
function parsePath(dotPath: string): Array<string | number> {
  const segments: Array<string | number> = [];
  const parts = dotPath.split('.');

  for (const part of parts) {
    // Check for array bracket notation: "tasks[0]"
    const bracketMatch = part.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      segments.push(bracketMatch[1]);
      segments.push(parseInt(bracketMatch[2], 10));
    } else {
      // Check for standalone bracket: "[0]"
      const standaloneBracket = part.match(/^\[(\d+)\]$/);
      if (standaloneBracket) {
        segments.push(parseInt(standaloneBracket[1], 10));
      } else {
        segments.push(part);
      }
    }
  }

  return segments;
}

export function applyDotPath(
  obj: Record<string, unknown>,
  dotPath: string,
  value: unknown,
): void {
  // Check for reserved fields
  if (isReservedField(dotPath)) {
    throw new StateStoreError(
      ErrorCode.RESERVED_FIELD,
      `Cannot update reserved field: ${dotPath}`,
    );
  }

  const segments = parsePath(dotPath);
  if (segments.length === 0) return;

  let current: unknown = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];

    if (typeof segment === 'number') {
      // Array index access
      if (!Array.isArray(current)) {
        throw new StateStoreError(
          ErrorCode.INVALID_INPUT,
          `Expected array at index ${segment} in path ${dotPath}`,
        );
      }
      if (current[segment] === undefined) {
        // Create intermediate object or array based on next segment
        current[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = current[segment];
    } else {
      // Object key access
      const record = current as Record<string, unknown>;
      if (record[segment] === undefined || record[segment] === null) {
        // Create intermediate object or array based on next segment
        record[segment] = typeof nextSegment === 'number' ? [] : {};
      }
      current = record[segment];
    }
  }

  // Set the final value
  const lastSegment = segments[segments.length - 1];
  if (typeof lastSegment === 'number') {
    if (!Array.isArray(current)) {
      throw new StateStoreError(
        ErrorCode.INVALID_INPUT,
        `Expected array for final index ${lastSegment} in path ${dotPath}`,
      );
    }
    current[lastSegment] = value;
  } else {
    const record = current as Record<string, unknown>;
    // Deep-merge when both existing and new values are plain objects
    if (isPlainObject(record[lastSegment]) && isPlainObject(value)) {
      record[lastSegment] = deepMerge(
        record[lastSegment] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      record[lastSegment] = value;
    }
  }
}

// ─── List State Files ──────────────────────────────────────────────────────

export async function listStateFiles(
  stateDir: string,
): Promise<Array<{ featureId: string; stateFile: string; state: WorkflowState }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new StateStoreError(
      ErrorCode.FILE_IO_ERROR,
      `Failed to read state directory: ${stateDir}`,
    );
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));
  const results: Array<{ featureId: string; stateFile: string; state: WorkflowState }> = [];

  for (const file of stateFiles) {
    const stateFile = path.join(stateDir, file);
    const featureId = file.replace('.state.json', '');
    try {
      const state = await readStateFile(stateFile);
      results.push({ featureId, stateFile, state });
    } catch {
      // Skip corrupt or unreadable state files
      continue;
    }
  }

  return results;
}

// ─── Apply Event to State (pure helper) ─────────────────────────────────────

/**
 * Apply a single event's mutation to a workflow state object (in-place).
 * Returns true if the event was meaningfully applied.
 */
function applyEventToState(
  state: Record<string, unknown>,
  event: WorkflowEvent,
): boolean {
  const data = event.data as Record<string, unknown> | undefined;

  switch (event.type) {
    case 'workflow.started':
      // workflow.started is used to create the state file; no mutation needed
      // when state already exists
      return true;

    case 'workflow.transition': {
      if (!data) return false;
      const to = data.to as string | undefined;
      if (!to) return false;
      state.phase = to;
      state.updatedAt = event.timestamp;
      return true;
    }

    case 'workflow.checkpoint': {
      if (!data) return false;
      const checkpointPhase = data.phase as string | undefined;
      const counter = data.counter as number | undefined;
      const checkpoint = state._checkpoint as Record<string, unknown> | undefined;
      if (checkpoint && checkpointPhase) {
        checkpoint.phase = checkpointPhase;
        checkpoint.timestamp = event.timestamp;
        checkpoint.lastActivityTimestamp = event.timestamp;
        if (counter !== undefined) {
          checkpoint.operationsSince = counter;
        }
      }
      return true;
    }

    default:
      // Unknown event types are skipped
      return false;
  }
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

  // Apply each event to the state
  const stateRecord = state as unknown as Record<string, unknown>;
  let eventsApplied = 0;
  let maxSequence = currentSeq;

  for (const event of newEvents) {
    const applied = applyEventToState(stateRecord, event);
    if (applied) {
      eventsApplied++;
    }
    if (event.sequence > maxSequence) {
      maxSequence = event.sequence;
    }
  }

  // Update _eventSequence
  stateRecord._eventSequence = maxSequence;

  // Phase reconciliation: compare state.phase against last workflow.transition event.
  // This catches corrupted state files where the phase is out of sync with events.
  const allEvents = await eventStore.query(featureId);
  const lastTransition = [...allEvents]
    .reverse()
    .find((e) => e.type === 'workflow.transition');
  if (lastTransition?.data) {
    const eventPhase = (lastTransition.data as Record<string, unknown>).to as string | undefined;
    if (eventPhase && stateRecord.phase !== eventPhase) {
      stateRecord.phase = eventPhase;
      if (!eventsApplied) eventsApplied = 1; // Mark as reconciled even if only phase was fixed
    }
  }

  // Write updated state with CAS guard (Fix 2)
  await writeStateFile(stateFile, state, { expectedVersion: initialVersion });

  return { reconciled: eventsApplied > 0, eventsApplied };
}

// ─── Resolve State Directory ───────────────────────────────────────────────

export function resolveStateDir(): string {
  // Check environment variable first
  const envDir = process.env.WORKFLOW_STATE_DIR;
  if (envDir) return envDir;

  return path.join(homedir(), '.claude', 'workflow-state');
}
