import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteBackend } from '../../src/storage/sqlite-backend.js';

/**
 * Recursively remove a directory, tolerant of transient Windows file locks.
 *
 * Most tests tear down a temp dir with
 * `fs.rmSync(dir, { recursive: true, force: true })`. That idiom is happy on
 * POSIX but throws EPERM/EBUSY on Windows (NTFS) when a file in the tree still
 * has an open handle — and even briefly *after* a handle is closed, an
 * antivirus or search-indexer scan can hold the file open. `maxRetries` +
 * `retryDelay` ride out that transient window (Node retries on
 * EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM).
 *
 * Before removing, this closes any SQLite backend whose database file lives
 * under `dir` (via {@link SqliteBackend.closeOpenUnder}) — so a handle opened
 * deep inside a production call the test never named is still released. That
 * is what makes the drop-in `fs.rmSync(dir, …)` → `rmrf(dir)` swap sufficient
 * on Windows without hunting down every store variable per test. `maxRetries`
 * + `retryDelay` then ride out any residual antivirus/indexer scan lock.
 *
 * `force: true` already swallows ENOENT, so removing a missing directory is a
 * no-op — safe to call unconditionally in `afterEach`.
 */
/**
 * Retry budget for the removal itself, applied AFTER every SQLite handle under
 * the tree is closed — so it rides out a lock we do not own (antivirus or the
 * search indexer re-opening a just-closed `-wal`/`-shm`), not one we forgot to
 * release. Node retries with LINEAR backoff (`retryDelay × attempt`).
 *
 * Deliberately SMALL, and not to be raised to chase a Windows EBUSY. Raising it
 * to 15 × 100ms was tried and reverted: when the lock is held by a handle we
 * failed to release, no budget ever succeeds, so a larger one only converts a
 * fast, legible `EBUSY … exarchos.db-shm` into `Hook timed out in 60000ms` from
 * `afterEach` — the same red lane, later, with the cause erased. The retries are
 * here for a transient scanner lock; a persistent one is a handle-ownership bug
 * and must be fixed at the handle.
 */
const RM_MAX_RETRIES = 10;
const RM_RETRY_DELAY_MS = 50;

export function rmrf(dir: string): void {
  SqliteBackend.closeOpenUnder(dir);
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: RM_MAX_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
}

/**
 * Async counterpart to {@link rmrf} — the 1:1 swap for teardown that does
 * `await fs.rm(dir, { recursive: true, force: true })`. Closes any SQLite
 * handle under `dir` first, then removes with the same retry budget.
 */
export async function rmrfAsync(dir: string): Promise<void> {
  SqliteBackend.closeOpenUnder(dir);
  await fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: RM_MAX_RETRIES,
    retryDelay: RM_RETRY_DELAY_MS,
  });
}

/**
 * Create a unique temp directory under the OS temp root and return its path.
 * Thin wrapper over `fs.mkdtempSync` for symmetry with {@link rmrf}.
 */
export function makeTempDir(prefix = 'exarchos-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
