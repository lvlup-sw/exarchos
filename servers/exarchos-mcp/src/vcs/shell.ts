// ─── Shell Execution Helper ──────────────────────────────────────────────────
//
// Thin wrapper around child_process.execFile for CLI invocations.
// Separated for easy mocking in tests.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Wall-clock budget for a single CLI invocation (`gh`, `git`, …).
 *
 * Exported because it is the DEEPEST child budget in the process tree: any
 * out-of-process harness that spawns the binary and imposes its own timeout
 * must set that timeout strictly GREATER than this value. If the two are equal,
 * the outer timer — started earlier, at spawn, while this one starts only after
 * the binary boots — always wins the race, so a slow-but-bounded CLI is killed
 * before it can surface its error envelope and is misreported as a hang. See
 * `test/process/packaged-proof.test.ts`.
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
