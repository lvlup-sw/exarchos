/**
 * Thin wrapper around `child_process.execFile` for CLI calls.
 * It is a separate module so that tests can mock it.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Wall-clock budget for one CLI call (`gh`, `git`). It is the deepest child budget in the process tree.
 * A harness that spawns the binary with its own timeout must set that timeout greater than this value.
 * If the two are equal, the outer timer starts first, at spawn, and wins.
 * Then the outer timer kills a slow CLI before the CLI returns its error envelope, and the harness reports a hang.
 * See `tests/core/process/packaged-proof.test.ts`.
 */
export const EXEC_TIMEOUT_MS = 30_000;

export async function exec(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: EXEC_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}
