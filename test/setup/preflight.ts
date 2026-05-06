import { execFileSync } from 'node:child_process';

/** Default binary the v2.9 install flow puts on PATH. */
const BINARY_NAME = 'exarchos';

/**
 * Assert that the given command (default: `exarchos`) resolves on PATH.
 *
 * Used by the `process` vitest project's `setupFiles` to fail fast with an
 * actionable error before any process-fidelity test attempts to spawn the
 * binary. Falling through to a cryptic `ENOENT` inside a test would waste
 * an expensive test-setup cycle.
 *
 * The v2.9 install rewrite ships a single bun-compiled binary named
 * `exarchos` with subcommands (e.g. `exarchos mcp`, `exarchos version`);
 * there is no separate `exarchos-mcp` binary. Local dev installs it via
 * `npm link`; users install via the `scripts/get-exarchos.sh` /
 * `get-exarchos.ps1` bootstrap.
 *
 * Resolution uses the platform's own lookup:
 *   - POSIX: `which <command>`
 *   - Windows: `where <command>`
 *
 * Any non-zero exit (or thrown OS error) is treated as "not found" and
 * re-thrown as an Error with remediation guidance.
 */
export function assertExarchosOnPath(command: string = BINARY_NAME): void {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(lookup, [command], { stdio: 'pipe' });
  } catch {
    throw new Error(
      `${command} not found on PATH. For local dev, run \`npm link\` in the repo root; otherwise install via \`scripts/get-exarchos.sh\` (POSIX) or \`scripts/get-exarchos.ps1\` (Windows). See docs/designs/2026-05-05-e2e-v29-revisited.md §5.1.`,
    );
  }
}
