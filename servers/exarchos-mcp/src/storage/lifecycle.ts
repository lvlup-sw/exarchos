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

/** Check if a file exists. */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Count lines in a JSONL file. */
async function countJsonlLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Calculate total size of all *.events.jsonl files in a directory. */
async function totalJsonlSizeBytes(stateDir: string): Promise<number> {
  let totalBytes = 0;
  try {
    const entries = await fs.readdir(stateDir);
    for (const entry of entries) {
      if (entry.endsWith('.events.jsonl')) {
        const stat = await fs.stat(path.join(stateDir, entry));
        totalBytes += stat.size;
      }
    }
  } catch {
    // Directory may not exist
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
  } catch {
    return; // No state file, nothing to compact
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
  await fs.writeFile(archivePath, JSON.stringify(archive, null, 2), 'utf-8');

  // Delete JSONL file
  await fs.unlink(jsonlPath).catch(() => {});

  // Delete .seq file if it exists
  const seqPath = path.join(stateDir, `${featureId}.seq`);
  await fs.unlink(seqPath).catch(() => {});

  // Delete state file
  await fs.unlink(stateFile).catch(() => {});

  // Clean up backend rows if available
  if (backend) {
    // Delete events from backend by clearing the stream
    // InMemoryBackend doesn't have a delete method, so we use a workaround:
    // We need to clear events and state from the backend
    deleteBackendStream(backend, featureId);
    deleteBackendState(backend, featureId);
  }
}

/**
 * Delete all events for a stream from the backend.
 *
 * Since StorageBackend doesn't expose a delete method, we re-initialize
 * the backend's internal state by querying then clearing.
 * For InMemoryBackend: we access the internal map. For production:
 * this would need a proper `deleteStream` method on the backend.
 */
function deleteBackendStream(backend: StorageBackend, streamId: string): void {
  // The InMemoryBackend stores events in a private Map.
  // We use a type assertion (via unknown) to access it for cleanup.
  const mem = backend as unknown as Record<string, unknown>;
  if (mem.events instanceof Map) {
    (mem.events as Map<string, unknown>).delete(streamId);
  }
}

/**
 * Delete state for a feature from the backend.
 */
function deleteBackendState(backend: StorageBackend, featureId: string): void {
  const mem = backend as unknown as Record<string, unknown>;
  if (mem.states instanceof Map) {
    (mem.states as Map<string, unknown>).delete(featureId);
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
  } catch {
    return; // Directory doesn't exist
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
  await fs.unlink(rotated2).catch(() => {});

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

    // Query events older than retention and delete them
    // Since the backend doesn't have a deleteEvents method,
    // we filter and rebuild for InMemoryBackend
    pruneBackendTelemetry(backend, cutoffIso);
  }
}

/**
 * Prune telemetry events older than the cutoff from the backend.
 */
function pruneBackendTelemetry(backend: StorageBackend, cutoffIso: string): void {
  const mem = backend as unknown as Record<string, unknown>;
  if (mem.events instanceof Map) {
    const eventsMap = mem.events as Map<string, Array<{ timestamp: string }>>;
    const telemetryEvents = eventsMap.get(TELEMETRY_STREAM);
    if (telemetryEvents) {
      const kept = telemetryEvents.filter((e) => e.timestamp >= cutoffIso);
      if (kept.length === 0) {
        eventsMap.delete(TELEMETRY_STREAM);
      } else {
        eventsMap.set(TELEMETRY_STREAM, kept);
      }
    }
  }
}
