import { exec } from 'node:child_process';
import type { GuardDefinition } from './define.js';

// Re-export for consumers that imported from here
export type { GuardDefinition };

// ─── Guard Types ────────────────────────────────────────────────────────────

export interface GuardResult {
  passed: boolean;
  error?: string;
  output?: string;
}

// ─── Guard Execution ────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Executes a guard command in a shell subprocess.
 *
 * TRUST BOUNDARY: Guard commands originate from user-authored config files
 * (exarchos.config.ts), which are themselves executed via dynamic import.
 * The config file already has full code execution capability, so shell
 * command execution here does not expand the attack surface.
 */
export function executeGuard(guard: GuardDefinition): Promise<GuardResult> {
  const timeout = guard.timeout ?? DEFAULT_TIMEOUT_MS;

  return new Promise<GuardResult>((resolve) => {
    const child = exec(guard.command, { timeout }, (error, stdout, stderr) => {
      if (error) {
        // Check if it was killed due to timeout
        if (child.killed) {
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
