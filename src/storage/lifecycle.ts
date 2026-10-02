import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StorageBackend } from './backend.js';
import type { WorkflowState } from '../workflow/types.js';
import { logger } from '../logger.js';
import { WorkflowStateSchema } from '../workflow/schemas.js';
import { TELEMETRY_STREAM } from '../projections/telemetry/constants.js';
import { atomicReplace } from '../utils/atomic-write.js';

export interface LifecyclePolicy {
  /** Days to keep completed workflows before compaction. */
  readonly retentionDays: number;
  /** Maximum total storage size in MB. No runtime code reads this field. */
  readonly maxTotalSizeMB: number;
  /** Maximum number of telemetry events. No runtime code reads this field. */
  readonly maxTelemetryEvents: number;
  /** Days to keep telemetry events in SQLite before pruning. */
  readonly telemetryRetentionDays: number;
}

export const DEFAULT_LIFECYCLE_POLICY: LifecyclePolicy = {
  retentionDays: 30,
  maxTotalSizeMB: 500,
  maxTelemetryEvents: 10000,
  telemetryRetentionDays: 7,
};

/** Checks if a file exists. Only ENOENT means "not found". Other errors propagate. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** Check if a workflow phase is a terminal/completed phase. */
function isCompletedPhase(phase: string): boolean {
  return phase === 'completed' || phase === 'cancelled';
}

/** Check if a timestamp is older than N days ago. */
function isOlderThanDays(isoTimestamp: string, days: number): boolean {
  const threshold = new Date();
  threshold.setDate(threshold.getDate() - days);
  return new Date(isoTimestamp) < threshold;
}

/** Unlink a file, ignoring ENOENT but rethrowing other errors. */
async function unlinkIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

/**
 * Compacts a completed workflow. It archives the final state and event count, then
 * deletes the state file and the SQLite rows.
 *
 * It does nothing for a workflow that is not `completed` or `cancelled`, or that
 * changed less than `retentionDays` ago. The SQLite backend is the source of truth. Only the no-backend path reads
 * `.state.json`, and that path archives zero events. A state that fails schema
 * validation is not compacted, and the function logs a warning.
 */
export async function compactWorkflow(
  backend: StorageBackend | undefined,
  stateDir: string,
  featureId: string,
  policy: LifecyclePolicy,
): Promise<void> {
  const stateFile = path.join(stateDir, `${featureId}.state.json`);

  let state: WorkflowState;
  if (backend) {
    const backendState = backend.getState(featureId);
    if (!backendState) return;
    const parsed = WorkflowStateSchema.safeParse(backendState);
    if (!parsed.success) {
      logger.warn(
        { featureId, error: parsed.error.message },
        'Skipping compaction — backend state fails schema validation',
      );
      return;
    }
    state = parsed.data as WorkflowState;
  } else {
    let stateRaw: string;
    try {
      stateRaw = await fs.readFile(stateFile, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }

    let rawJson: unknown;
    try {
      rawJson = JSON.parse(stateRaw);
    } catch {
      logger.warn({ featureId, file: stateFile }, 'Skipping compaction — corrupt JSON in state file');
      return;
    }

    const parsed = WorkflowStateSchema.safeParse(rawJson);
    if (!parsed.success) {
      logger.warn(
        { featureId, file: stateFile, error: parsed.error.message },
        'Skipping compaction — state file fails schema validation',
      );
      return;
    }
    state = parsed.data as WorkflowState;
  }

  const phase = state.phase as string | undefined;
  const updatedAt = state.updatedAt as string | undefined;

  if (!phase || !isCompletedPhase(phase)) {
    return;
  }

  if (!updatedAt || !isOlderThanDays(updatedAt, policy.retentionDays)) {
    return;
  }

  const eventCount = backend ? backend.queryEvents(featureId).length : 0;

  const archiveDir = path.join(stateDir, 'archives');
  await fs.mkdir(archiveDir, { recursive: true });

  const archive = {
    featureId,
    archivedAt: new Date().toISOString(),
    finalState: state,
    eventCount,
  };

  const archivePath = path.join(archiveDir, `${featureId}.archive.json`);
  await atomicReplace(archivePath, JSON.stringify(archive, null, 2));

  await unlinkIfExists(stateFile);

  if (backend) {
    backend.deleteStream(featureId);
    backend.deleteState(featureId);
  }
}

/**
 * Compacts each workflow that qualifies. The SQLite backend lists the workflows.
 * Without a backend, a scan for `.state.json` files lists them. The function does not
 * check the total storage size.
 */
export async function checkCompaction(
  backend: StorageBackend | undefined,
  stateDir: string,
  policy: LifecyclePolicy,
): Promise<void> {
  let featureIds: string[];
  if (backend) {
    featureIds = backend.listStates().map((s) => s.featureId);
  } else {
    let entries: string[];
    try {
      entries = await fs.readdir(stateDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    featureIds = entries
      .filter((f) => f.endsWith('.state.json'))
      .map((f) => f.replace('.state.json', ''));
  }

  for (const featureId of featureIds) {
    await compactWorkflow(backend, stateDir, featureId, policy);
  }
}

/**
 * Prunes telemetry events older than `policy.telemetryRetentionDays` through
 * `backend.pruneEvents`. Without a backend, it does nothing.
 */
export async function rotateTelemetry(
  backend: StorageBackend | undefined,
  _stateDir: string,
  policy: LifecyclePolicy,
): Promise<void> {
  if (!backend) return;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - policy.telemetryRetentionDays);
  backend.pruneEvents(TELEMETRY_STREAM, cutoff.toISOString());
}
