import { execFileSync } from 'node:child_process';

/**
 * Assert that the given command (default: `exarchos-mcp`) resolves on PATH.
 *
 * Used by the `process` vitest project's `setupFiles` to fail fast with an
 * actionable error before any process-fidelity test attempts to spawn the
 * binary. Falling through to a cryptic `ENOENT` inside a test would waste
 * an expensive test-setup cycle.
 *
 * Resolution uses the platform's own lookup:
 *   - POSIX: `which <command>`
 *   - Windows: `where <command>`
 *
 * Any non-zero exit (or thrown OS error) is treated as "not found" and
 * re-thrown as an Error with remediation guidance.
 */
export function assertExarchosMcpOnPath(command = 'exarchos-mcp'): void {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [command], { stdio: 'pipe' });
  } catch {
    throw new Error(
      `${command} not found on PATH. Run \`npm link\` in the repo root before running the process project. See docs/designs/2026-04-19-process-fidelity-harness.md §4.2.`,
    );
  }
}
