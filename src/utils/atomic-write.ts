/**
 * The one home for replacing a file. It stages the bytes in a unique temp file
 * next to the target, then renames the temp file over the target.
 *
 * A reader sees the old bytes or the new bytes, never a torn file. Inside one
 * process, every publish to a target goes through a per-target queue, so two of
 * our own renames to one path can never overlap. On Windows a rename can still
 * be refused by a holder we do not own, such as a virus scanner or another
 * process. Only for that case, the publish retries with a bounded, jittered
 * backoff and then rethrows. Writers in other processes are not ordered: the
 * last rename wins.
 *
 * `tests/architecture/atomic-replace.test.ts` keeps every `rename` in `src/` in
 * this file or in a named exemption.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  open as fsPromisesOpen,
  rename as fsPromisesRename,
  unlink as fsPromisesUnlink,
  writeFile as fsPromisesWriteFile,
  type FileHandle,
} from 'node:fs/promises';

/**
 * Attempts to publish a temp file before the publish gives up, and the cap on the
 * jittered backoff between attempts. The total stays under about one second. That
 * is long enough to outlast a contended replace, and short enough that a permanent
 * failure does not look like a hang.
 */
const PUBLISH_RETRY_LIMIT = 20;
export const PUBLISH_BACKOFF_CAP_MS = 64;

/** `true` when `err` is Windows refusing a replace because another handle holds the target. */
function isWindowsRenameRace(err: unknown): boolean {
  if (process.platform !== 'win32') return false;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES';
}

/** Backoff for attempt `n`, jittered. See {@link publishTempFile} for why jitter. */
function publishBackoffMs(attempt: number): number {
  return 1 + Math.random() * Math.min(2 ** attempt, PUBLISH_BACKOFF_CAP_MS);
}

/**
 * What a parent-directory fsync achieved. `synced`: the metadata of the directory
 * reached stable storage. `unsupported`: the host refused a directory fsync (see
 * {@link DIRECTORY_SYNC_UNSUPPORTED_CODES}). The publish is still atomic, but the
 * durability of the directory entry is not proven.
 */
export type DirectorySyncStatus =
  | 'synced'
  | 'unsupported';

/**
 * The typed, inspectable result of a directory fsync. Returned (never
 * swallowed) so a degraded platform is VISIBLE to the caller and to tests
 * instead of hiding behind a bare `catch {}`.
 */
export interface DirectorySyncOutcome {
  readonly directory: string;
  readonly status: DirectorySyncStatus;
  /** errno explaining an `unsupported` result. */
  readonly code?: string;
}

/**
 * The closed errno set that means "this host cannot fsync a directory handle".
 * On win32 `fs.openSync(dir, 'r')` succeeds and `fs.fsyncSync(fd)` fails with
 * `EPERM` (Node 24, NTFS). Other runtimes report the other codes in this list.
 * `ENOENT`, `ENOSPC`, `EIO`, `EROFS`, and all other codes propagate, because each
 * is a real fault. A blanket `catch {}` turns such a fault into a false claim of
 * durability.
 */
export const DIRECTORY_SYNC_UNSUPPORTED_CODES: readonly string[] = [
  'EPERM',
  'EACCES',
  'EISDIR',
  'EINVAL',
  'ENOTSUP',
  'EOPNOTSUPP',
  'ENOSYS',
];

function unsupportedDirectorySyncCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && DIRECTORY_SYNC_UNSUPPORTED_CODES.includes(code)
    ? code
    : undefined;
}

/** `unsupported` outcome for a platform/seam that declined, keeping `code` typed. */
function unsupportedDirectorySync(directory: string, code: string): DirectorySyncOutcome {
  return { directory, status: 'unsupported', code };
}

/**
 * fsync `directory` itself, so the entries that a rename made are on stable storage.
 *
 * A rename is atomic for observers, but the new name lives in the metadata of the
 * directory. Only an fsync of the directory makes the name durable. Two renames
 * that must reach the disk in order need this fsync between them.
 *
 * On a host that cannot fsync a directory, the function returns `unsupported` with
 * the errno, but only for {@link DIRECTORY_SYNC_UNSUPPORTED_CODES}. It rethrows all
 * other errors. It ignores a failed close, which cannot undo a completed sync.
 */
export function fsyncDirSync(directory: string): DirectorySyncOutcome {
  let fd: number;
  try {
    fd = fs.openSync(directory, 'r');
  } catch (err: unknown) {
    const code = unsupportedDirectorySyncCode(err);
    if (code === undefined) throw err;
    return unsupportedDirectorySync(directory, code);
  }
  try {
    fs.fsyncSync(fd);
  } catch (err: unknown) {
    const code = unsupportedDirectorySyncCode(err);
    if (code === undefined) throw err;
    return unsupportedDirectorySync(directory, code);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
    }
  }
  return { directory, status: 'synced' };
}

/** Async {@link fsyncDirSync}, with identical degradation semantics. */
export async function fsyncDir(directory: string): Promise<DirectorySyncOutcome> {
  let handle: FileHandle;
  try {
    handle = await fsPromisesOpen(directory, 'r');
  } catch (err: unknown) {
    const code = unsupportedDirectorySyncCode(err);
    if (code === undefined) throw err;
    return unsupportedDirectorySync(directory, code);
  }
  try {
    await handle.sync();
  } catch (err: unknown) {
    const code = unsupportedDirectorySyncCode(err);
    if (code === undefined) throw err;
    return unsupportedDirectorySync(directory, code);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { directory, status: 'synced' };
}

/**
 * Proof that a completed rename pushed its directory entry to stable storage, or
 * that the host refused (`directory.status` tells which). A step that must wait
 * until an earlier step is durable takes that barrier as a parameter. Thus the
 * compiler checks the order, not the line sequence. See `install/atomic-promotion.ts`.
 */
export interface DurabilityBarrier {
  /** The path the rename published. */
  readonly published: string;
  /** Outcome of the parent-directory fsync that closed this barrier. */
  readonly directory: DirectorySyncOutcome;
}

/**
 * The synchronous seam for {@link publishTempFileSync} and {@link atomicWriteFile}.
 * `rename` defaults to `fs.renameSync`. A caller injects it to fault the rename.
 */
export interface PublishSyncIo {
  rename?(from: string, to: string): void;
  syncDirectory(directory: string): DirectorySyncOutcome;
}

export const DEFAULT_PUBLISH_SYNC_IO: PublishSyncIo = { syncDirectory: fsyncDirSync };

/**
 * The seam for {@link publishTempFile}. The default comes from
 * `node:fs/promises`, so a mock a caller installs on that module applies here
 * too. `unlink` is optional: a seam without it gets no temp-file cleanup.
 * `syncDirectory` is optional: a seam without it gets an atomic publish whose
 * directory entry is not forced to disk.
 */
export interface PublishIo {
  rename(from: string, to: string): Promise<void>;
  unlink?(path: string): Promise<void>;
  /** fsync the *directory* so the rename's entry is durable. See {@link fsyncDir}. */
  syncDirectory?(directory: string): Promise<DirectorySyncOutcome>;
}

/**
 * Default publish IO. It imports from `node:fs/promises`, the module that async
 * callers import, and not `fs.promises` from `node:fs`. These are different module
 * references, so a mock that a caller installs on `node:fs/promises` also applies
 * to the publish. The crash-injection mock of the `snapshot-store` tests needs this.
 */
const DEFAULT_PUBLISH_IO: PublishIo = {
  rename: fsPromisesRename,
  unlink: fsPromisesUnlink,
  syncDirectory: fsyncDir,
};

/**
 * The tail of the publish chain for each target with a publish queued or
 * running, keyed by {@link publishQueueKey}. An entry is removed when the last
 * publish for its target settles, so the map holds only targets in use.
 */
const publishQueues = new Map<string, Promise<void>>();

/**
 * The queue key for `target`. `path.resolve` makes it absolute and normalizes
 * `.`, `..` and separators. Windows file names ignore case, so the key is
 * lower-cased there. Symbolic links are not resolved.
 */
function publishQueueKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Run `task` after every earlier task for the same target has settled, in call
 * order. A failed task does not stop the tasks after it. This is what makes two
 * of our own renames to one path unable to overlap. On Windows such an overlap
 * fails with `EPERM`. On POSIX it succeeds, but in no defined order.
 */
function serializePerTarget<T>(target: string, task: () => Promise<T>): Promise<T> {
  const key = publishQueueKey(target);
  const release = (): void => {
    if (publishQueues.get(key) === tail) publishQueues.delete(key);
  };
  const result = (publishQueues.get(key) ?? Promise.resolve()).then(task).finally(release);
  const tail: Promise<void> = result.then(
    () => undefined,
    () => undefined,
  );
  publishQueues.set(key, tail);
  return result;
}

/** How many targets have a publish queued or running in this process. */
export function pendingPublishTargets(): number {
  return publishQueues.size;
}

/**
 * Rename `tmpPath` over `target`, then fsync the parent directory. The rename
 * comes first, because a directory fsync proves nothing about an entry that
 * does not exist yet. Unqueued: callers reach it through {@link publishTempFile}
 * or {@link atomicReplace}. On win32 only, `EPERM` or `EACCES` is retried with a
 * bounded, jittered backoff. A bare `EPERM` looks the same as a real permission
 * fault. So after the bound, or on any other error, the temp file is
 * removed and the original error is rethrown.
 */
async function renameIntoPlace(tmpPath: string, target: string, io: PublishIo): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(tmpPath, target);
      if (io.syncDirectory !== undefined) {
        await io.syncDirectory(path.dirname(target));
      }
      return;
    } catch (err) {
      if (!isWindowsRenameRace(err) || attempt >= PUBLISH_RETRY_LIMIT) {
        if (io.unlink) {
          await io.unlink(tmpPath).catch(() => undefined);
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, publishBackoffMs(attempt)));
    }
  }
}

/**
 * Publish the staged `tmpPath` over `target`. Publishes to one target run one at
 * a time, in call order, so our own renames never collide. The win32 retry is
 * left only for a holder we do not own, such as a virus scanner or another
 * process. Its jitter keeps two such processes from retrying in step. Retrying
 * is safe: the bytes are already on disk and each rename is atomic.
 */
export function publishTempFile(
  tmpPath: string,
  target: string,
  io: PublishIo = DEFAULT_PUBLISH_IO,
): Promise<void> {
  return serializePerTarget(target, () => renameIntoPlace(tmpPath, target, io));
}

/** A temp path next to `target` that no other writer, in any process, will choose. */
function uniqueTempPath(target: string): string {
  return `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

/**
 * Write `data` to `tmpPath` and fsync it, so a rename never publishes a name
 * before its bytes are on disk. The write is `node:fs/promises`'s `writeFile`,
 * so a caller's mock of that module observes it. The temp file is removed if
 * any step fails.
 */
async function stageTempFile(tmpPath: string, data: string | Uint8Array): Promise<void> {
  try {
    await fsPromisesWriteFile(tmpPath, data);
    const handle = await fsPromisesOpen(tmpPath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (err) {
    await fsPromisesUnlink(tmpPath).catch(() => undefined);
    throw err;
  }
}

/**
 * Run `read` in the target's queue, so it never overlaps a publish to that
 * target from this process. On Windows a file that a reader holds open cannot
 * be replaced. An in-process reader outside the queue can make our own publish
 * fail with `EPERM`. Readers in other processes still rely on the
 * bounded retry in {@link publishTempFile}.
 */
export function readPublished<T>(target: string, read: () => Promise<T>): Promise<T> {
  return serializePerTarget(target, read);
}

/**
 * Replace `target` with `data`: stage a unique temp file next to it, then rename
 * the temp file over it. Stage and rename are one task in the target's queue.
 * Thus writers to one target run one at a time, and the target ends with the
 * bytes of the last call. A reader sees the old bytes or the new bytes, never a torn
 * file. On failure the temp file is removed and the error is rethrown. The
 * synchronous form is {@link atomicWriteFile}.
 */
export function atomicReplace(target: string, data: string | Uint8Array): Promise<void> {
  return serializePerTarget(target, async () => {
    const tmpPath = uniqueTempPath(target);
    await stageTempFile(tmpPath, data);
    await renameIntoPlace(tmpPath, target, DEFAULT_PUBLISH_IO);
  });
}

/**
 * Synchronous {@link publishTempFile}. It has no queue, because synchronous calls
 * cannot overlap on one thread. An async publish to the same target can still run
 * on the thread pool. That case falls to the same bounded win32 retry as a
 * foreign holder. The retry sleeps with `Atomics.wait`, the only way to
 * pause without an event loop. Prefer the async form wherever the caller can
 * await.
 */
export function publishTempFileSync(
  tmpPath: string,
  target: string,
  io: PublishSyncIo = DEFAULT_PUBLISH_SYNC_IO,
): DurabilityBarrier {
  const rename = io.rename ?? fs.renameSync;
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmpPath, target);
      return { published: target, directory: io.syncDirectory(path.dirname(target)) };
    } catch (err: unknown) {
      if (!isWindowsRenameRace(err) || attempt >= PUBLISH_RETRY_LIMIT) throw err;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.ceil(publishBackoffMs(attempt)),
      );
    }
  }
}

/**
 * Synchronous {@link atomicReplace}: stage a unique, fsynced temp file, then
 * publish it with {@link publishTempFileSync}. Returns the publish's
 * {@link DurabilityBarrier}.
 */
export function atomicWriteFile(
  target: string,
  content: string | Buffer,
  io: PublishSyncIo = DEFAULT_PUBLISH_SYNC_IO,
): DurabilityBarrier {
  const tmp = uniqueTempPath(target);
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof content === 'string') {
      fs.writeSync(fd, content);
    } else {
      fs.writeSync(fd, content);
    }
    fs.fsyncSync(fd);
  } catch (err: unknown) {
    try {
      fs.closeSync(fd);
    } catch {
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
  fs.closeSync(fd);

  try {
    return publishTempFileSync(tmp, target, io);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
    }
    throw err;
  }
}
