/**
 * Atomic file writer — temp + fsync + rename — and the one home for the
 * tmp+rename *publish* step every such writer shares.
 *
 * Stages `content` to `<target>.<pid>.<random>.tmp`, fsyncs the tmp file,
 * then renames it over `target`. The rename is atomic on POSIX filesystems
 * and on Windows when source and target are on the same volume, so concurrent
 * readers either see the prior contents or the new contents — never a partial
 * write.
 *
 * On rename failure the tmp file is best-effort unlinked; the original
 * error is rethrown unwrapped so callers can inspect `code` (e.g.,
 * `EXDEV`, `EACCES`).
 *
 * Originally inlined in `projections/store.ts`. Extracted here in T15
 * (#1192 Items 3+5+17) so `agents/plugin-manifest.ts` and the projection
 * store share one implementation.
 *
 * Atomicity is not the same guarantee as tolerating concurrent publishers, and
 * this module now provides both: see {@link publishTempFile} for why a
 * concurrent replace needs more than a bare `rename` on Windows. Cross-process
 * *ordering* remains out of scope — racing writers may each succeed and the
 * last winner clobbers the earlier one, which is fine for every current caller
 * (each has a single owning writer, or the payload is idempotent).
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

/** `true` when `err` is Windows refusing a replace that a concurrent one holds open. */
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

/** The synchronous directory-durability seam (`publishTempFileSync` / `atomicWriteFile`). */
export interface PublishSyncIo {
  syncDirectory(directory: string): DirectorySyncOutcome;
}

export const DEFAULT_PUBLISH_SYNC_IO: PublishSyncIo = { syncDirectory: fsyncDirSync };

/**
 * Replace `target` with `tmpPath`, tolerating Windows' concurrent-rename race.
 *
 * THIS IS THE ONLY PLACE THAT EXPLAINS THE RACE. Every tmp+rename publish in
 * this codebase routes through here or {@link publishTempFileSync}; call sites
 * point at this docstring and assert nothing. That is deliberate — see the
 * scope docstring in `projections/types.ts` for the same rule and the reason it
 * exists (#1342: a claim restated in ~8 places outlived the code and
 * contradicted itself; prose has no compiler, so the only defence is one copy).
 *
 * POSIX `rename(2)` fully defines a concurrent replace: it is atomic and a
 * loser simply overwrites. Windows does not. While one replace is in flight the
 * destination is briefly held open, and a concurrent `MoveFileEx` fails `EPERM`
 * (or `EACCES`) even though nothing is actually wrong. So identical, correct
 * code is green on Linux and red on Windows — which is why this class stayed
 * invisible until a concurrency test existed, and then only in the win32 lane.
 *
 * Retrying is safe because what is retried is the *publish*, not the write: the
 * payload is already fully on disk, each rename is still atomic, and a reader
 * therefore sees the old bytes or the new bytes and never a torn mix.
 *
 * The backoff is jittered, and that is load-bearing rather than decorative. The
 * contending writers are woken by the same collision, so a fixed *or purely
 * exponential* delay retries them in lockstep and they collide again every
 * round. The first cut of this used a deterministic `5 * attempt` and left one
 * writer still failing; randomising each sleep is what actually breaks the
 * convoy.
 *
 * Bounded on purpose. A real permission fault — read-only file, hostile ACL,
 * antivirus holding a handle — reports `EPERM` too and is indistinguishable at
 * this layer, so the loop must terminate and rethrow rather than mask it as a
 * hang. The retry is gated on win32 so POSIX keeps the single unconditional
 * rename it is already guaranteed.
 *
 * When the publish ultimately fails, `tmpPath` is removed before the error is
 * rethrown. A staged temp file whose publish failed is garbage by definition,
 * and leaving it behind orphans a file next to `target` on every failure —
 * `state-store` and {@link atomicWriteFile} each hand-rolled that cleanup while
 * the other publishes silently leaked. Owning it here is the point of having one
 * home. Cleanup is best-effort and never masks the original error.
 *
 * @param io injection seam for callers that own their own `fs` (see
 * `orchestrate/init/writers/`). Defaults to `node:fs/promises` — see the import
 * note above for why that module and not `node:fs`'s `fs.promises`. `unlink` is
 * optional: a caller whose injected fs cannot delete (e.g. `McpJsonWriterFs`)
 * simply gets no cleanup, exactly as before.
 *
 * `syncDirectory` is the DR-16 durability seam and is likewise optional, because
 * an injected fs may not be able to express a directory fsync at all (a seam
 * that only exposes `rename` cannot open a directory handle). It is never
 * silently *dropped*: the DEFAULT io always has one ({@link fsyncDir}), and the
 * ordering DR-16 actually depends on is built on the SYNC path
 * ({@link publishTempFileSync} / {@link DurabilityBarrier}), which always has one
 * too. An injected seam without `syncDirectory` gets an atomic publish whose
 * directory entry is not forced to disk — the same guarantee it had before this
 * seam existed, and no weaker.
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

export async function publishTempFile(
  tmpPath: string,
  target: string,
  io: PublishIo = DEFAULT_PUBLISH_IO,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await io.rename(tmpPath, target);
      // DR-16: the bytes were fsync'd before the rename; the NAME is durable
      // only once the parent directory is fsync'd too. Strictly after the
      // rename — fsync'ing the directory first would prove nothing about an
      // entry that does not exist yet, and a publish that never renamed must
      // not claim a durable entry at all.
      if (io.syncDirectory !== undefined) {
        await io.syncDirectory(path.dirname(target));
      }
      return;
    } catch (err) {
      if (!isWindowsRenameRace(err) || attempt >= PUBLISH_RETRY_LIMIT) {
        if (io.unlink) {
          try {
            await io.unlink(tmpPath);
          } catch {
            /* best-effort — never mask the publish failure */
          }
        }
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, publishBackoffMs(attempt)));
    }
  }
}

/**
 * Synchronous {@link publishTempFile}, for callers already committed to sync IO.
 *
 * The sleep blocks the thread via `Atomics.wait`, which is the only way to pause
 * without an event loop. That is acceptable *here* precisely because the wait is
 * bounded and rare — it only ever runs on win32, and only when a concurrent
 * replace is actually in flight. Prefer the async form wherever the caller can
 * await.
 */
export function publishTempFileSync(
  tmpPath: string,
  target: string,
  io: PublishSyncIo = DEFAULT_PUBLISH_SYNC_IO,
): DurabilityBarrier {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, target);
      // DR-16 — see `publishTempFile` above and the section docstring.
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

export function atomicWriteFile(
  target: string,
  content: string | Buffer,
  io: PublishSyncIo = DEFAULT_PUBLISH_SYNC_IO,
): DurabilityBarrier {
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
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
