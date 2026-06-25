import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SqliteBackend } from '../storage/sqlite-backend.js';

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
export function rmrf(dir: string): void {
  SqliteBackend.closeOpenUnder(dir);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * Create a unique temp directory under the OS temp root and return its path.
 * Thin wrapper over `fs.mkdtempSync` for symmetry with {@link rmrf}.
 */
export function makeTempDir(prefix = 'exarchos-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
