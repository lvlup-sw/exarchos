/**
 * The one home for replacing a file: stage the bytes in a unique temp file next
 * to the target, then rename the temp file over the target.
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
// The async default deliberately comes from `node:fs/promises` — the same module
// every async caller here imports — rather than `node:fs`'s `fs.promises`. They
// hit the same syscall but are DIFFERENT module references, and reaching around
// the caller's module seam means any mock, spy, or instrumentation the caller
// installs on `node:fs/promises` silently does not apply to the publish. That is
// not hypothetical: routing `snapshot-store` through here with an `fs.promises`
// default bypassed its crash-injection mock, and a test that asserts a failed
// rename leaves the previous snapshot intact published the "crashed" payload
// instead.
import {
  open as fsPromisesOpen,
  rename as fsPromisesRename,
  unlink as fsPromisesUnlink,
  writeFile as fsPromisesWriteFile,
  type FileHandle,
} from 'node:fs/promises';

/**
 * Attempts to publish a temp file over its target before giving up, and the
 * ceiling on the jittered backoff between them. Sized so the whole budget stays
 * under ~1s of wall clock: long enough to outlast a contended replace, short
 * enough that a permanent failure surfaces promptly instead of looking like a
 * hang.
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

// ─── Directory durability (DR-16) ────────────────────────────────────────────

/**
 * THIS IS THE ONLY PLACE THAT EXPLAINS DIRECTORY DURABILITY. Everything below —
 * and `install/atomic-promotion.ts`'s `renameDurable` — points here.
 *
 * `rename(2)` is atomic with respect to OBSERVERS: a concurrent reader sees the
 * old name or the new name, never a half-moved path. That is the guarantee every
 * docstring above this line is about, and it is NOT the same guarantee as
 * durability. The new name lives in the *containing directory's* metadata, and
 * nothing forces that metadata to stable storage. So a rename can be observed to
 * succeed, the process can be told it succeeded, and a power loss can still lose
 * it. fsync'ing the FILE (which {@link atomicWriteFile} already does) publishes
 * the BYTES; only fsync'ing the DIRECTORY publishes the NAME.
 *
 * The distinction only becomes load-bearing when two renames are supposed to be
 * ORDERED. A journal written before a backup rename constrains recovery only if
 * the journal's directory entry reaches stable storage FIRST; without a
 * directory fsync between them the two entries may land in either order, or
 * neither. "Journal, then backup" then describes the source text rather than the
 * disk — an ordering that is accidental rather than constructed, which is
 * exactly the defect DR-16 exists to remove.
 */

/** What a parent-directory fsync attempt actually achieved. */
export type DirectorySyncStatus =
  /** The directory's own metadata reached stable storage. */
  | 'synced'
  /**
   * The host declined a directory fsync outright. NOT "it failed" — see
   * {@link DIRECTORY_SYNC_UNSUPPORTED_CODES}. The publish is still atomic; only
   * the durability of the directory entry is unproven.
   */
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
 * The exact errno set that means "this host cannot fsync a directory handle",
 * as opposed to "the fsync failed and the caller must know".
 *
 * fsync on a directory fd is a POSIX idiom with no Windows equivalent. On win32
 * `fs.openSync(dir, 'r')` SUCCEEDS and the subsequent `fs.fsyncSync(fd)` fails
 * `EPERM` (measured on Node 24 / NTFS); other runtimes and filesystems report
 * `EACCES`, `EISDIR`, `EINVAL`, or `ENOTSUP`/`EOPNOTSUPP`/`ENOSYS` for the same
 * "not a thing here" condition.
 *
 * The list is deliberately CLOSED. `ENOENT` (the parent vanished), `ENOSPC`,
 * `EIO`, `EROFS` and everything else propagate untouched, because each of those
 * is a real fault that a blanket `catch {}` would convert into a silent claim of
 * durability — the same class of defect as the accidental ordering this module
 * is fixing.
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
 * fsync `directory` itself, so directory entries created by a preceding rename
 * are on stable storage. See the section docstring above for why that is a
 * different guarantee from the rename's atomicity.
 *
 * Degrades EXPLICITLY: on a host that cannot fsync a directory handle the
 * refusal is converted into an `unsupported` {@link DirectorySyncOutcome}
 * carrying the errno, and only for the closed
 * {@link DIRECTORY_SYNC_UNSUPPORTED_CODES} set. Every other error is rethrown.
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
      /* best-effort — a failed close cannot un-sync what already synced */
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
 * Proof token: the directory entry published by a completed rename has been
 * pushed to stable storage (or the host explicitly declined — `directory.status`
 * says which).
 *
 * A token, rather than a `void`, because it is what turns statement order into a
 * CONSTRUCTED ordering: a step that must not begin until an earlier step is
 * durable takes that step's barrier as a parameter, so the dependency is checked
 * by the compiler and legible to a reader instead of resting on which line
 * happens to come first. See `install/atomic-promotion.ts`.
 */
export interface DurabilityBarrier {
  /** The path the rename published. */
  readonly published: string;
  /** Outcome of the parent-directory fsync that closed this barrier. */
  readonly directory: DirectorySyncOutcome;
}

/**
 * The synchronous seam for {@link publishTempFileSync} and {@link atomicWriteFile}.
 * `rename` defaults to `fs.renameSync`; a caller injects it to fault the rename.
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
 * fails with `EPERM`; on POSIX it succeeds, but in no defined order.
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
 * bounded, jittered backoff. A bare `EPERM` cannot be told apart from a real
 * permission fault, so after the bound, or on any other error, the temp file is
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
 * Replace `target` with `data`: stage a unique temp file next to it, then rename
 * the temp file over it. Stage and rename are one task in the target's queue, so
 * writers to one target run one at a time and the target ends with the bytes of
 * the last call. A reader sees the old bytes or the new bytes, never a torn
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
 * cannot overlap on one thread. An async publish to the same target can still be
 * running on the thread pool; that case, like a foreign holder, falls to the same
 * bounded win32 retry. The retry sleeps with `Atomics.wait`, the only way to
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
    // Write or fsync failed — close fd and unlink the tmp before rethrowing
    // so a stale `*.tmp` doesn't accumulate alongside `target`.
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup — don't mask the original error */
    }
    throw err;
  }
  fs.closeSync(fd);

  try {
    // The barrier is produced by the publish, not re-derived here: the bytes are
    // durable (fsync above), the name becomes durable inside the publish, and
    // the caller receives the proof of both.
    return publishTempFileSync(tmp, target, io);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup — don't mask the original error */
    }
    throw err;
  }
}
