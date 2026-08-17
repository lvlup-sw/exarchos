/**
 * Atomic JSON configuration I/O (EFF-008).
 *
 * `~/.claude.json` and the Exarchos config are user-owned files that a failed
 * write can destroy: a truncated `writeFileSync` leaves the target neither the
 * old configuration nor the new one, and the next read fails on a file the user
 * never edited. Configuration writes are the one effect class where "partially
 * applied" is strictly worse than "not applied".
 *
 * Both writers route through this module so the durability rules live in one
 * place:
 *
 *   1. serialize, and refuse a value `JSON.stringify` cannot represent;
 *   2. write to a temp file in the SAME directory (rename is only atomic within
 *      a filesystem), LOOPING on the byte count `writeSync` reports — a short
 *      write is completed, and a write that makes no forward progress throws;
 *   3. `fsync` the data before promoting, so a crash cannot leave a
 *      rename-visible but empty file;
 *   4. re-read the temp file FROM DISK and require it to be byte-identical to
 *      what we serialized, and to parse — this is the promotion gate;
 *   5. `rename` over the target, which is atomic, then `fsync` the directory so
 *      the new link survives a crash (best-effort: see `fsyncDirectory`);
 *   6. on any failure, unlink the temp file and rethrow — the target keeps its
 *      previous contents.
 *
 * Step 4 is the one that earns the module's name, and it is deliberately a disk
 * read. Parsing back the in-memory string `JSON.stringify` just produced tests
 * nothing that can fail; the real hazard is a short `writeSync` whose return
 * value is discarded, leaving a truncated temp file that is then fsync'd and
 * renamed over good data. Both a truncating filesystem and a stalled write are
 * caught here rather than at the user's next read.
 *
 * Reads fail with a typed {@link ConfigParseError} rather than a silent default,
 * because silently treating a corrupt config as "absent" is how a user's MCP
 * server list gets quietly erased on the next write.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A configuration file exists but does not contain readable JSON.
 *
 * Distinct from "absent": absent is a normal first-run state a caller may
 * default for, corrupt is an operator-visible fault that must not be papered
 * over by writing a fresh file on top of it.
 */
export class ConfigParseError extends Error {
  override readonly name = 'ConfigParseError';
  readonly code = 'CONFIG_PARSE_ERROR';
  constructor(
    readonly filePath: string,
    override readonly cause: unknown,
  ) {
    super(
      `Failed to parse JSON configuration at ${filePath}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Read and parse a JSON configuration file.
 *
 * @returns the parsed value, or `null` when the file does not exist.
 * @throws {ConfigParseError} when the file exists but is not readable JSON.
 */
export function readJsonConfig<T>(filePath: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isErrnoCode(err, 'ENOENT')) return null;
    throw err;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    throw new ConfigParseError(filePath, err);
  }
}

/**
 * The bytes that reached disk are not the bytes we serialized.
 *
 * Raised before promotion, so the target still holds its previous contents.
 * Distinct from {@link ConfigParseError}: that one reports a file that is
 * already unreadable, this one reports that we declined to make one.
 */
export class AtomicWriteError extends Error {
  override readonly name = 'AtomicWriteError';
  readonly code = 'ATOMIC_WRITE_ERROR';
  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(`Refusing to promote a partial write to ${filePath}: ${reason}`);
  }
}

/** Narrow a thrown value to a Node errno error with the given `code`. */
function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === code
  );
}

/** Injectable filesystem seam so the failure-injection tests need no real crash. */
export interface AtomicJsonFs {
  mkdirSync: typeof fs.mkdirSync;
  openSync: typeof fs.openSync;
  /**
   * Write `length` bytes of `data` starting at `offset`, returning the number
   * actually written. The return value is load-bearing — the caller loops on it
   * — so an implementation must report the truth, exactly as `fs.writeSync`
   * does. Discarding it is the bug this seam exists to make visible.
   */
  writeSync: (fd: number, data: Buffer, offset: number, length: number) => number;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  /** Read the promotion candidate back from disk for the pre-rename check. */
  readFileSync: (filePath: string) => Buffer;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
}

const nodeFs: AtomicJsonFs = {
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  writeSync: (fd, data, offset, length) => fs.writeSync(fd, data, offset, length),
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  readFileSync: (filePath) => fs.readFileSync(filePath),
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
};

/**
 * Serialize `value` and replace `filePath` atomically.
 *
 * Parent directories are created. The target is only ever replaced by bytes
 * that were read back from disk and found identical to what we serialized; a
 * failure at any step leaves the previous file untouched and removes the temp
 * artifact.
 */
export function writeJsonConfigAtomic(
  filePath: string,
  value: unknown,
  io: AtomicJsonFs = nodeFs,
): void {
  // `JSON.stringify` returns `undefined` for a value it cannot represent (a bare
  // `undefined`, a function, a symbol). Catch that here, directly, rather than
  // via a parse of the string we just built.
  const body = JSON.stringify(value, null, 2);
  if (body === undefined) {
    throw new AtomicWriteError(filePath, 'value has no JSON representation');
  }
  const serialized = Buffer.from(`${body}\n`, 'utf-8');

  const dir = path.dirname(filePath);
  io.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );

  const fd = io.openSync(tmpPath, 'w');

  try {
    writeFully(io, fd, serialized, filePath);
    io.fsyncSync(fd);
  } catch (err: unknown) {
    closeQuietly(io, fd);
    unlinkQuietly(io, tmpPath);
    throw err;
  }
  closeQuietly(io, fd);

  // The promotion gate. Everything above reports success through a return value
  // or the absence of a throw; this reads the candidate back and compares it to
  // the source bytes, so a filesystem that accepted less than it acknowledged
  // cannot reach `rename`.
  try {
    assertPromotable(io, tmpPath, serialized, filePath);
  } catch (err: unknown) {
    unlinkQuietly(io, tmpPath);
    throw err;
  }

  try {
    io.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    unlinkQuietly(io, tmpPath);
    throw err;
  }

  fsyncDirectory(io, dir);
}

/**
 * Write every byte of `data`, looping on the count `writeSync` reports.
 *
 * A single `writeSync` may transfer fewer bytes than requested — that is the
 * documented contract, not an error condition — so the previous "call it once
 * and discard the result" shape produced a truncated file that the rest of the
 * pipeline then treated as complete. A call that transfers nothing is not short
 * but stalled, and gets no retry budget: looping on it would spin forever.
 */
function writeFully(io: AtomicJsonFs, fd: number, data: Buffer, filePath: string): void {
  let written = 0;
  while (written < data.byteLength) {
    const n = io.writeSync(fd, data, written, data.byteLength - written);
    if (!Number.isInteger(n) || n <= 0) {
      throw new AtomicWriteError(
        filePath,
        `write made no progress at byte ${written} of ${data.byteLength}`,
      );
    }
    written += n;
  }
}

/** Require the on-disk candidate to be the exact bytes we serialized, and JSON. */
function assertPromotable(
  io: AtomicJsonFs,
  tmpPath: string,
  expected: Buffer,
  filePath: string,
): void {
  const actual = io.readFileSync(tmpPath);
  if (!actual.equals(expected)) {
    throw new AtomicWriteError(
      filePath,
      `temp file holds ${actual.byteLength} of ${expected.byteLength} expected bytes`,
    );
  }
  try {
    JSON.parse(actual.toString('utf-8'));
  } catch (err: unknown) {
    throw new ConfigParseError(filePath, err);
  }
}

/**
 * Flush the directory entry so a crash cannot lose the rename itself.
 *
 * Best-effort by necessity: Windows does not permit opening a directory as a
 * file handle, and some filesystems reject `fsync` on a directory fd. Where it
 * fails the data is still safe — `rename` over an existing file is atomic
 * everywhere we run — so this widens the durability window rather than guarding
 * correctness, and must never turn a completed write into a reported failure.
 */
function fsyncDirectory(io: AtomicJsonFs, dir: string): void {
  let dirFd: number;
  try {
    dirFd = io.openSync(dir, 'r');
  } catch {
    return;
  }
  try {
    io.fsyncSync(dirFd);
  } catch {
    /* platform does not support directory fsync — the rename already landed */
  }
  closeQuietly(io, dirFd);
}

function closeQuietly(io: AtomicJsonFs, fd: number): void {
  try {
    io.closeSync(fd);
  } catch {
    /* best-effort: never mask the original failure */
  }
}

function unlinkQuietly(io: AtomicJsonFs, target: string): void {
  try {
    io.unlinkSync(target);
  } catch {
    /* best-effort: a leftover temp file is recoverable, a lost config is not */
  }
}
