import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StorageBackend } from './backend.js';
import { logger } from '../logger.js';
import { WorkflowStateSchema } from '../workflow/schemas.js';
import { TELEMETRY_STREAM } from '../telemetry/constants.js';

// ─── Lifecycle Policy ───────────────────────────────────────────────────────

export interface LifecyclePolicy {
  /** Days to keep completed workflows before compaction. */
  readonly retentionDays: number;
  /** Maximum total storage size in MB before emitting a warning. */
  readonly maxTotalSizeMB: number;
  /** Maximum number of telemetry events before rotation. */
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

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Check if a file exists. Only treats ENOENT as "not found"; rethrows other errors. */
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

// ─── Workflow Compaction ────────────────────────────────────────────────────

/**
 * Compact a completed workflow by archiving its final state and event count,
 * then deleting the associated JSONL event files and SQLite rows.
 *
 * No-ops if the workflow is active or recently completed.
 */
export async function compactWorkflow(
  backend: StorageBackend | undefined,
  stateDir: string,
  featureId: string,
  policy: LifecyclePolicy,
): Promise<void> {
  // Read state file to check eligibility
  const stateFile = path.join(stateDir, `${featureId}.state.json`);

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
  const state = parsed.data;

  const phase = state.phase as string | undefined;
  const updatedAt = state.updatedAt as string | undefined;

  // Guard: only compact completed/cancelled workflows
  if (!phase || !isCompletedPhase(phase)) {
    return;
  }

  // Guard: only compact if older than retention period
  if (!updatedAt || !isOlderThanDays(updatedAt, policy.retentionDays)) {
    return;
  }

  // Count events from the SQLite backend (post-v2.11: SQLite is the only
  // substrate). Fall back to 0 when no backend is wired (test fixtures
  // that exercise the archive-write atomicity path without a backend).
  const eventCount = backend ? backend.queryEvents(featureId).length : 0;

  // Write archive
  const archiveDir = path.join(stateDir, 'archives');
  await fs.mkdir(archiveDir, { recursive: true });

  const archive = {
    featureId,
    archivedAt: new Date().toISOString(),
    finalState: state,
    eventCount,
  };

  const archivePath = path.join(archiveDir, `${featureId}.archive.json`);
  const tmpPath = `${archivePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(archive, null, 2), 'utf-8');
  await fs.rename(tmpPath, archivePath);

  // Delete state file
  await unlinkIfExists(stateFile);

  // Clean up backend rows if available
  if (backend) {
    backend.deleteStream(featureId);
    backend.deleteState(featureId);
  }
}

// ─── Batch Compaction ───────────────────────────────────────────────────────

/**
 * Check all workflows for compaction eligibility and compact those that qualify.
 * Also checks total storage size and emits a warning if it exceeds the limit.
 */
export async function checkCompaction(
  backend: StorageBackend | undefined,
  stateDir: string,
  policy: LifecyclePolicy,
): Promise<void> {
  // List all state files
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const stateFiles = entries.filter((f) => f.endsWith('.state.json'));

  // Compact eligible workflows
  for (const file of stateFiles) {
    const featureId = file.replace('.state.json', '');
    await compactWorkflow(backend, stateDir, featureId, policy);
  }

  // Storage-size warning: the pre-v2.11 implementation summed JSONL file
  // sizes. Post-v2.11 the substrate is SQLite WAL — operators inspect
  // size via `du events.db*` or `sqlite3 events.db ".dbinfo"`. The
  // policy.maxTotalSizeMB threshold is no longer applied at runtime;
  // a SQLite-aware reimplementation is tracked as v2.12 follow-up.
}

// ─── Telemetry Rotation ────────────────────────────────────────────────────

/**
 * Prune telemetry events older than `policy.telemetryRetentionDays`.
 *
 * Pre-v2.11: rotated `_telemetry.events.jsonl` files (.1 / .2 sibling
 * files) and pruned SQLite rows. v2.11 deletes the JSONL substrate, so
 * the file-rotation half is gone — this becomes a thin wrapper over
 * `backend.pruneEvents`. Naming is retained for caller compat
 * (`index.ts` cron tick).
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
