import { exec } from 'node:child_process';

// ─── Guard Types ────────────────────────────────────────────────────────────

export interface GuardDefinition {
  readonly command: string;
  readonly timeout?: number;
  readonly description?: string;
}

export interface GuardResult {
  passed: boolean;
  error?: string;
  output?: string;
}

// ─── Guard Execution ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute a guard command and return the result.
 * Exit 0 → passed, non-zero → failed, timeout → failed with 'timeout' error.
 */
export function executeGuard(guard: GuardDefinition): Promise<GuardResult> {
  const timeout = guard.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GuardResult>((resolve) => {
    const child = exec(guard.command, { timeout }, (error, stdout, stderr) => {
      if (error) {
        // Check if it was killed due to timeout
        if (child.killed || error.message.includes('TIMEOUT') || ('signal' in error && error.signal === 'SIGTERM')) {
          resolve({ passed: false, error: 'timeout' });
          return;
        }

        // Command not found or other execution error
        const errorMessage = stderr?.trim() || error.message;
        resolve({ passed: false, error: errorMessage, output: stdout?.trim() || undefined });
        return;
      }

      resolve({ passed: true, output: stdout?.trim() || undefined });
    });
  });
}
