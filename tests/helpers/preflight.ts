import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCli } from './cli-runner.js';

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

/**
 * Default version resolver: spawns `<BINARY_NAME> version` and returns the
 * first non-empty trimmed line of stdout. Kept as an injectable seam so the
 * unit tests can supply a deterministic stub without spawning the real
 * binary (which may not exist in the host environment when only unit tests
 * are running — the `process` project gates on `assertExarchosOnPath` for
 * that case).
 */
async function defaultResolveVersion(command: string = BINARY_NAME): Promise<string> {
  const result = await runCli({ command, args: ['version'], timeout: 10_000 });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} version: exited ${result.exitCode}. stderr: ${result.stderr.trim()}`,
    );
  }
  const line = result.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) {
    throw new Error(`${command} version: stdout was empty`);
  }
  return line;
}

/**
 * Read the expected major.minor from the repo's root `package.json`.
 *
 * `import.meta.url` resolves relative to this file at runtime under both
 * `tsx`/vitest and the bun-compiled bundle. Walking two parents up from
 * `test/setup/` lands on the repo root.
 */
function readExpectedMajorMinor(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', '..', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
  return parseMajorMinor(pkg.version);
}

/**
 * Extract `MAJOR.MINOR` from a SemVer-ish string. Tolerates a leading `v`,
 * a pre-release suffix (`-rc.3`), and build metadata (`+sha`). Throws if
 * the input does not start with two dotted numeric components.
 */
function parseMajorMinor(version: string): string {
  const m = version.trim().replace(/^v/, '').match(/^(\d+)\.(\d+)/);
  if (!m) {
    throw new Error(`Cannot parse major.minor from version string: '${version}'`);
  }
  return `${m[1]}.${m[2]}`;
}

export interface AssertExarchosVersionOpts {
  /** Override the binary name (default: `exarchos`). */
  command?: string;
  /**
   * Inject an alternate version resolver. The default spawns
   * `<command> version` and parses stdout; tests pass a stub returning a
   * canned version string.
   */
  resolveVersion?: (command: string) => Promise<string>;
  /**
   * Override the expected major.minor (default: read from root
   * `package.json`). Useful for tests that want to assert the comparison
   * logic without coupling to the live package version.
   */
  expectedMajorMinor?: string;
}

/**
 * Assert that the binary on PATH advertises a version whose major.minor
 * matches the repo's expected release line (read from root `package.json`).
 *
 * Throws an Error naming both the expected and the actual version on
 * mismatch. A stale-binary case is the most common failure mode when a
 * developer's `npm link` points at an older checkout — without this gate
 * the process-fidelity suite would silently exercise stale behavior.
 */
export async function assertExarchosVersion(
  opts: AssertExarchosVersionOpts = {},
): Promise<void> {
  const command = opts.command ?? BINARY_NAME;
  const resolve = opts.resolveVersion ?? defaultResolveVersion;
  const expected = opts.expectedMajorMinor ?? readExpectedMajorMinor();

  const actualRaw = await resolve(command);
  const actualMajorMinor = parseMajorMinor(actualRaw);

  if (actualMajorMinor !== expected) {
    throw new Error(
      `${command} version mismatch: expected ${expected}.x but found ${actualRaw} (major.minor=${actualMajorMinor}). Re-run \`npm link\` from the v${expected} checkout, or reinstall via \`scripts/get-exarchos.sh\`.`,
    );
  }
}
