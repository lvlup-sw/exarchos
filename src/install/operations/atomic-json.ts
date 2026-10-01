/**
 * Atomic JSON configuration I/O for `~/.claude.json` and the Exarchos config.
 * A truncated write destroys a user-owned file, so a partial write is worse
 * than no write. The writer does these steps:
 *
 *   1. Serialize, and refuse a value that `JSON.stringify` cannot represent.
 *   2. Write a temp file in the same directory, because a rename is atomic only in one
 *      filesystem. Loop on the byte count from `writeSync`. A write that makes no progress throws.
 *   3. `fsync` the data, so that a crash cannot leave an empty file after the rename.
 *   4. Read the temp file back from disk. It must equal the serialized bytes and
 *      parse as JSON. This check stops a short write before the rename.
 *   5. `rename` over the target, then `fsync` the directory where possible.
 *   6. On failure, unlink the temp file and rethrow. The target keeps its content.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { publishTempFileSync, type DirectorySyncOutcome } from '../../utils/atomic-write.js';

/**
 * A configuration file exists but does not hold readable JSON. An absent file
 * is a normal first-run state. A corrupt file is a fault that a new write must
 * not hide.
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
 * The writer refused to promote a write. It throws before the rename, so the
 * target keeps its previous content.
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
   * Write `length` bytes of `data` from `offset`, and return the count actually
   * written. The caller loops on this count, so it must be true, as in
   * `fs.writeSync`.
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
 * Serialize `value` and replace `filePath` atomically. This function creates
 * parent directories. Only a temp file whose bytes on disk equal the serialized
 * bytes replaces the target. On failure, the previous file stays and the temp
 * file is removed.
 */
export function writeJsonConfigAtomic(
  filePath: string,
  value: unknown,
  io: AtomicJsonFs = nodeFs,
): void {
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

  try {
    assertPromotable(io, tmpPath, serialized, filePath);
  } catch (err: unknown) {
    unlinkQuietly(io, tmpPath);
    throw err;
  }

  try {
    publishTempFileSync(tmpPath, filePath, {
      rename: (from, to) => io.renameSync(from, to),
      syncDirectory: (directory) => fsyncDirectory(io, directory),
    });
  } catch (err: unknown) {
    unlinkQuietly(io, tmpPath);
    throw err;
  }
}

/**
 * Write each byte of `data`, and loop on the count that `writeSync` reports.
 * One call can write fewer bytes than requested. A call that writes nothing is
 * stalled, so it throws and does not retry.
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
 * Flush the directory entry so that a crash cannot lose the rename. This step is
 * best-effort, because a host can refuse to open or fsync a directory. The rename
 * has already landed, so a completed write is never reported as a failure. Each
 * refusal is reported as `unsupported`, with its errno.
 */
function fsyncDirectory(io: AtomicJsonFs, dir: string): DirectorySyncOutcome {
  let dirFd: number;
  try {
    dirFd = io.openSync(dir, 'r');
  } catch (err: unknown) {
    return { directory: dir, status: 'unsupported', code: errnoCode(err) };
  }
  try {
    io.fsyncSync(dirFd);
  } catch (err: unknown) {
    return { directory: dir, status: 'unsupported', code: errnoCode(err) };
  } finally {
    closeQuietly(io, dirFd);
  }
  return { directory: dir, status: 'synced' };
}

/** The errno code of a thrown value, or `UNKNOWN` when it carries none. */
function errnoCode(err: unknown): string {
  if (typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return 'UNKNOWN';
}

/** Close `fd` and ignore an error, so that a close failure never hides the original failure. */
function closeQuietly(io: AtomicJsonFs, fd: number): void {
  try {
    io.closeSync(fd);
  } catch {
  }
}

/** Remove `target` and ignore an error. A leftover temp file is recoverable, but a lost config is not. */
function unlinkQuietly(io: AtomicJsonFs, target: string): void {
  try {
    io.unlinkSync(target);
  } catch {
  }
}
