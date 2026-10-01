import { exec } from 'node:child_process';
import type { GuardDefinition } from './define.js';

export type { GuardDefinition };

export interface GuardResult {
  passed: boolean;
  error?: string;
  output?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Runs a guard command in a shell subprocess. A process that Node kills (`error.killed`) gives
 * the error `timeout`.
 *
 * Trust boundary: guard commands come from the user-authored config file, which the loader runs
 * through dynamic import. That file can already run any code, so the shell adds no attack surface.
 */
export function executeGuard(guard: GuardDefinition): Promise<GuardResult> {
  const timeout = guard.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GuardResult>((resolve) => {
    const child = exec(guard.command, { timeout }, (error, stdout, stderr) => {
      if (error) {
        if ((error as unknown as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          resolve({ passed: false, error: 'timeout' });
          return;
        }

        const errorMessage = stderr?.trim() || error.message;
        resolve({ passed: false, error: errorMessage, output: stdout?.trim() || undefined });
        return;
      }

      resolve({ passed: true, output: stdout?.trim() || undefined });
    });
  });
}
