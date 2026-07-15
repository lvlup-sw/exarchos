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
// The async default deliberately comes from `node:fs/promises` — the same module
// every async caller here imports — rather than `node:fs`'s `fs.promises`. They
// hit the same syscall but are DIFFERENT module references, and reaching around
// the caller's module seam means any mock, spy, or instrumentation the caller
// installs on `node:fs/promises` silently does not apply to the publish. That is
// not hypothetical: routing `snapshot-store` through here with an `fs.promises`
// default bypassed its crash-injection mock, and a test that asserts a failed
// rename leaves the previous snapshot intact published the "crashed" payload
// instead.
import { rename as fsPromisesRename } from 'node:fs/promises';

/**
 * Attempts to publish a temp file over its target before giving up, and the
 * ceiling on the jittered backoff between them. Sized so the whole budget stays
 * under ~1s of wall clock: long enough to outlast a contended replace, short
 * enough that a permanent failure surfaces promptly instead of looking like a
 * hang.
 */
const PUBLISH_RETRY_LIMIT = 20;
const PUBLISH_BACKOFF_CAP_MS = 64;

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
 * @param rename injection seam for callers that own their own `fs` (see
 * `orchestrate/init/writers/`). Defaults to `node:fs/promises`' `rename` — see
 * the import note above for why that module and not `node:fs`'s `fs.promises`.
 */
export async function publishTempFile(
  tmpPath: string,
  target: string,
  rename: (from: string, to: string) => Promise<void> = fsPromisesRename,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmpPath, target);
      return;
    } catch (err) {
      if (!isWindowsRenameRace(err) || attempt >= PUBLISH_RETRY_LIMIT) throw err;
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
export function publishTempFileSync(tmpPath: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, target);
      return;
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

export function atomicWriteFile(target: string, content: string | Buffer): void {
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
    publishTempFileSync(tmp, target);
  } catch (err: unknown) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup — don't mask the original error */
    }
    throw err;
  }
}
