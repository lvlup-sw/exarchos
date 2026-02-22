import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { StorageBackend } from './backend.js';
import { logger } from '../logger.js';
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

/** Count lines in a JSONL file. Returns 0 if the file doesn't exist. */
async function countJsonlLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
}

/** Calculate total size of all *.events.jsonl files in a directory. */
async function totalJsonlSizeBytes(stateDir: string): Promise<number> {
  let totalBytes = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(stateDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw err;
  }
  for (const entry of entries) {
    if (entry.endsWith('.events.jsonl')) {
      const stat = await fs.stat(path.join(stateDir, entry));
      totalBytes += stat.size;
    }
  }
  return totalBytes;
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

  let state: Record<string, unknown>;
  try {
    state = JSON.parse(stateRaw) as Record<string, unknown>;
  } catch {
    return; // Corrupt state, skip
  }

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

  // Count events before archiving
  const jsonlPath = path.join(stateDir, `${featureId}.events.jsonl`);
  const eventCount = await countJsonlLines(jsonlPath);

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

  // Delete JSONL file
  await unlinkIfExists(jsonlPath);

  // Delete .seq file if it exists
  const seqPath = path.join(stateDir, `${featureId}.seq`);
  await unlinkIfExists(seqPath);

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

  // Check total storage size
  const totalBytes = await totalJsonlSizeBytes(stateDir);
  const totalSizeMB = totalBytes / (1024 * 1024);

  if (totalSizeMB > policy.maxTotalSizeMB) {
    logger.warn(
      { totalSizeMB, limitMB: policy.maxTotalSizeMB },
      `Total storage size ${totalSizeMB.toFixed(2)} MB exceeds limit of ${policy.maxTotalSizeMB} MB`,
    );
  }
}

// ─── Telemetry Rotation ────────────────────────────────────────────────────

/**
 * Rotate the telemetry JSONL file when it exceeds maxTelemetryEvents.
 *
 * Rotation strategy:
 * - Rename current file to .1 (if .1 exists, rename to .2 first; delete .2 if exists)
 * - Prune SQLite rows older than telemetryRetentionDays
 * - Keep at most 2 rotated files (.1 and .2)
 */
export async function rotateTelemetry(
  backend: StorageBackend | undefined,
  stateDir: string,
  policy: LifecyclePolicy,
): Promise<void> {
  const telemetryJsonl = path.join(stateDir, `${TELEMETRY_STREAM}.events.jsonl`);

  // Check if telemetry file exists
  if (!await fileExists(telemetryJsonl)) {
    return;
  }

  // Count events
  const eventCount = await countJsonlLines(telemetryJsonl);

  if (eventCount <= policy.maxTelemetryEvents) {
    return;
  }

  // Rotate files: .2 <- .1 <- current
  const rotated1 = `${telemetryJsonl}.1`;
  const rotated2 = `${telemetryJsonl}.2`;

  // Delete .2 if it exists
  await unlinkIfExists(rotated2);

  // Rename .1 to .2 if it exists
  if (await fileExists(rotated1)) {
    await fs.rename(rotated1, rotated2);
  }

  // Rename current to .1
  await fs.rename(telemetryJsonl, rotated1);

  // Prune old SQLite rows if backend is available
  if (backend) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - policy.telemetryRetentionDays);
    const cutoffIso = cutoff.toISOString();

    backend.pruneEvents(TELEMETRY_STREAM, cutoffIso);
  }
}
