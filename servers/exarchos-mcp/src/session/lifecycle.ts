import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const SESSIONS_DIR = 'sessions';
const EVENTS_PATTERN = /\.events\.jsonl$/;
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_SIZE_MB = 50;
const BYTES_PER_MB = 1024 * 1024;

/** Result of a session file pruning operation. */
export interface PruneResult {
  readonly deleted: number;
  readonly freedBytes: number;
}

/** Options for controlling pruning behavior. */
export interface PruneOptions {
  /** Maximum age in days before files are deleted. Default: 7 */
  readonly retentionDays?: number;
  /** Maximum total size in MB for session files. Default: 50 */
  readonly maxSizeMB?: number;
}

interface SessionFileInfo {
  readonly filePath: string;
  readonly mtimeMs: number;
  readonly size: number;
}

/**
 * Prune stale session event files from the sessions directory.
 *
 * Pass 1: Deletes files older than the retention period.
 * Pass 2: If remaining files exceed the size cap, deletes oldest first until under cap.
 *
 * The `.manifest.jsonl` file is never deleted. Only `*.events.jsonl` files are candidates.
 *
 * @param stateDir - Root state directory containing `sessions/` subdirectory
 * @param options - Optional retention and size cap configuration
 * @returns Count of deleted files and total freed bytes
 */
export async function pruneSessionFiles(
  stateDir: string,
  options?: PruneOptions,
): Promise<PruneResult> {
  const retentionDays = options?.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxSizeBytes = (options?.maxSizeMB ?? DEFAULT_MAX_SIZE_MB) * BYTES_PER_MB;
  const sessionsDir = path.join(stateDir, SESSIONS_DIR);

  const entries = await readSessionsDir(sessionsDir);
  if (entries.length === 0) {
    return { deleted: 0, freedBytes: 0 };
  }

  const fileInfos = await collectFileInfos(sessionsDir, entries);
  if (fileInfos.length === 0) {
    return { deleted: 0, freedBytes: 0 };
  }

  // Sort by mtime ascending (oldest first)
  const sorted = [...fileInfos].sort((a, b) => a.mtimeMs - b.mtimeMs);

  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  // Pass 1: Delete files older than retention period
  let deleted = 0;
  let freedBytes = 0;
  const remaining: SessionFileInfo[] = [];

  for (const info of sorted) {
    if (info.mtimeMs < cutoffMs) {
      const removed = await safeUnlink(info.filePath);
      if (removed) {
        deleted += 1;
        freedBytes += info.size;
      }
    } else {
      remaining.push(info);
    }
  }

  // Pass 2: Enforce size cap on remaining files (still sorted oldest first)
  let totalSize = remaining.reduce((sum, f) => sum + f.size, 0);

  for (const info of remaining) {
    if (totalSize <= maxSizeBytes) {
      break;
    }
    const removed = await safeUnlink(info.filePath);
    if (removed) {
      deleted += 1;
      freedBytes += info.size;
      totalSize -= info.size;
    }
  }

  return { deleted, freedBytes };
}

/** Read the sessions directory, returning an empty array if it doesn't exist. */
async function readSessionsDir(sessionsDir: string): Promise<string[]> {
  try {
    return await fs.readdir(sessionsDir);
  } catch {
    return [];
  }
}

/** Collect stat info for all `*.events.jsonl` files. */
async function collectFileInfos(
  sessionsDir: string,
  entries: readonly string[],
): Promise<SessionFileInfo[]> {
  const results: SessionFileInfo[] = [];

  for (const entry of entries) {
    if (!EVENTS_PATTERN.test(entry)) {
      continue;
    }

    const filePath = path.join(sessionsDir, entry);
    try {
      const stat = await fs.stat(filePath);
      results.push({
        filePath,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch {
      // File may have been deleted between readdir and stat; skip it
    }
  }

  return results;
}

/** Delete a file, returning true if successful. Handles ENOENT gracefully. */
async function safeUnlink(filePath: string): Promise<boolean> {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return false;
    }
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
