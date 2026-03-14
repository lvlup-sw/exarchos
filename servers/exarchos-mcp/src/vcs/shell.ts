// ─── Shell Execution Helper ──────────────────────────────────────────────────
//
// Thin wrapper around child_process.execFile for CLI invocations.
// Separated for easy mocking in tests.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function exec(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { encoding: 'utf-8' });
  return stdout.trim();
}
