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
 *   1. serialize, then VALIDATE the serialized bytes by parsing them back —
 *      nothing unreadable is ever promoted;
 *   2. write to a temp file in the SAME directory (rename is only atomic within
 *      a filesystem);
 *   3. `fsync` the data before promoting, so a crash cannot leave a
 *      rename-visible but empty file;
 *   4. `rename` over the target, which is atomic;
 *   5. on any failure, unlink the temp file and rethrow — the target keeps its
 *      previous contents.
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
  writeSync: (fd: number, data: string) => void;
  fsyncSync: typeof fs.fsyncSync;
  closeSync: typeof fs.closeSync;
  renameSync: typeof fs.renameSync;
  unlinkSync: typeof fs.unlinkSync;
}

const nodeFs: AtomicJsonFs = {
  mkdirSync: fs.mkdirSync,
  openSync: fs.openSync,
  writeSync: (fd, data) => {
    fs.writeSync(fd, data);
  },
  fsyncSync: fs.fsyncSync,
  closeSync: fs.closeSync,
  renameSync: fs.renameSync,
  unlinkSync: fs.unlinkSync,
};

/**
 * Serialize `value` and replace `filePath` atomically.
 *
 * Parent directories are created. The target is only ever replaced by a
 * complete, re-parseable document; a failure at any step leaves the previous
 * file untouched and removes the temp artifact.
 */
export function writeJsonConfigAtomic(
  filePath: string,
  value: unknown,
  io: AtomicJsonFs = nodeFs,
): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;

  // Validate BEFORE promotion. `JSON.stringify` can return `undefined` (e.g. a
  // bare `undefined` value) and can emit output that no longer round-trips if a
  // caller supplied an exotic replacer-hostile shape. Promoting that would
  // create exactly the corrupt file this module exists to prevent.
  try {
    JSON.parse(serialized);
  } catch (err: unknown) {
    throw new ConfigParseError(filePath, err);
  }

  const dir = path.dirname(filePath);
  io.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
  );

  let fd: number;
  try {
    fd = io.openSync(tmpPath, 'w');
  } catch (err: unknown) {
    throw err;
  }

  try {
    io.writeSync(fd, serialized);
    io.fsyncSync(fd);
  } catch (err: unknown) {
    closeQuietly(io, fd);
    unlinkQuietly(io, tmpPath);
    throw err;
  }
  closeQuietly(io, fd);

  try {
    io.renameSync(tmpPath, filePath);
  } catch (err: unknown) {
    unlinkQuietly(io, tmpPath);
    throw err;
  }
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
