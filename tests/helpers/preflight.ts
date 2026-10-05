import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { runCli } from './cli-runner.js';
import { execFileAsync } from '../../tools/test-helpers/spawn.js';

/** The binary that the install flow puts on PATH. */
const BINARY_NAME = 'exarchos';

/**
 * Throws if `command` (default `exarchos`) does not resolve on PATH. A setup file of the
 * `process` vitest project calls it. Thus a missing binary fails before the first test,
 * not as an `ENOENT` inside one. The lookup is `which` on POSIX and `where` on Windows.
 * Each lookup failure counts as not found.
 *
 * `npm link` does not provide the binary. The `bin` map of `package.json` holds only
 * `exarchos-release-verify`, and the build emits `dist/bin/exarchos-<os>-<arch>`.
 * To test the working tree, build the host target and link it on PATH as `exarchos`:
 *
 *   bun run tools/release/build-binary.ts --target <os>-<arch>
 *   ln -s "$PWD/dist/bin/exarchos-<os>-<arch>" <dir-on-PATH>/exarchos
 */
export async function assertExarchosOnPath(command: string = BINARY_NAME): Promise<void> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execFileAsync(lookup, [command]);
  } catch {
    throw new Error(
      `${command} not found on PATH. To test the working tree, build the host ` +
        'target and link it under the bare name: `bun run tools/release/build-binary.ts ' +
        '--target <os>-<arch>` then symlink `dist/bin/exarchos-<os>-<arch>` onto PATH as ' +
        '`exarchos`. To test a published release, install via ' +
        '`tools/release/get-exarchos.sh` (POSIX) or `tools/release/get-exarchos.ps1` ' +
        '(Windows). `npm link` does NOT provide this binary — package.json maps only ' +
        '`exarchos-release-verify`.',
    );
  }
}

/**
 * The default version resolver. It runs `<command> version` and returns the first
 * non-empty line of stdout, trimmed. A unit test passes a stub in its place, because the
 * binary can be absent when only unit tests run.
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

/** Reads the expected major.minor from the root `package.json`, two directories above this file. */
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
   * A different version resolver. The default runs `<command> version` and parses stdout.
   * A test passes a stub that returns a fixed version string.
   */
  resolveVersion?: (command: string) => Promise<string>;
  /**
   * The expected major.minor. The default comes from the root `package.json`.
   * With an explicit value, a test of the comparison does not depend on the package version.
   */
  expectedMajorMinor?: string;
}

/**
 * Throws if the major.minor of the binary on PATH differs from the major.minor in the
 * root `package.json`. The error names the expected version and the actual version.
 * The usual cause is an `exarchos` symlink that points at the build of an older checkout.
 * Without this check, the process tests run against stale behavior.
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
      `${command} version mismatch: expected ${expected}.x but found ${actualRaw} (major.minor=${actualMajorMinor}). Rebuild the host target from the v${expected} checkout and re-point the \`exarchos\` symlink at it, or reinstall via \`tools/release/get-exarchos.sh\` (POSIX) or \`tools/release/get-exarchos.ps1\` (Windows).`,
    );
  }
}
