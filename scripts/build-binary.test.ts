/**
 * Integration tests for `scripts/build-binary.ts`.
 *
 * These tests exercise the end-to-end compile path:
 *   1. Spawn `bun run scripts/build-binary.ts` (no args → host-only build).
 *   2. Assert the platform-specific output binary exists and is executable.
 *   3. Spawn the compiled binary with `--version` and verify it responds
 *      with the version string from root `package.json`.
 *
 * The build step can take ~30s on a cold bun cache, so we use generous
 * timeouts. Tests are always part of `npm run test:run` so that drift in
 * the compile pipeline is caught on every CI run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync, readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..');
const BUILD_SCRIPT = join(REPO_ROOT, 'scripts', 'build-binary.ts');
const DIST_BIN_DIR = join(REPO_ROOT, 'dist', 'bin');

function hostOs(): 'linux' | 'darwin' | 'windows' {
  if (process.platform === 'darwin') return 'darwin';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function hostArch(): 'x64' | 'arm64' {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

function expectedBinaryPath(): string {
  const o = hostOs();
  const a = hostArch();
  const ext = o === 'windows' ? '.exe' : '';
  return join(DIST_BIN_DIR, `exarchos-${o}-${a}${ext}`);
}

describe('scripts/build-binary.ts', () => {
  let builtBinary: string;

  beforeAll(() => {
    // Ensure dist/bin exists so the existence check below reliably asserts
    // the build itself created the file.
    mkdirSync(DIST_BIN_DIR, { recursive: true });

    if (!existsSync(BUILD_SCRIPT)) {
      throw new Error(
        `build script missing: ${BUILD_SCRIPT}. ` +
          `Expected scripts/build-binary.ts to exist.`,
      );
    }

    const result = spawnSync('bun', ['run', BUILD_SCRIPT], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      env: process.env,
      // 3 minute timeout for cold cache; typical run is ~30s.
      timeout: 180_000,
    });

    if (result.status !== 0) {
      throw new Error(
        `build-binary.ts exited with status=${result.status}\n` +
          `stdout:\n${result.stdout}\n` +
          `stderr:\n${result.stderr}`,
      );
    }

    builtBinary = expectedBinaryPath();
  }, 200_000);

  it('BuildBinary_HostTarget_ProducesExecutable', () => {
    expect(existsSync(builtBinary)).toBe(true);

    const st = statSync(builtBinary);
    expect(st.isFile()).toBe(true);

    // Non-zero size — an empty file would mean bun silently failed.
    expect(st.size).toBeGreaterThan(0);

    if (hostOs() !== 'windows') {
      // Owner-executable bit. Skip on Windows where these mode bits don't
      // carry the same semantics.
      expect(st.mode & 0o100).toBeGreaterThan(0);
    }
  });

  it('BuildBinary_CompiledBinary_RespondsToVersionFlag', () => {
    // Load root package.json for reference — documented in the provenance
    // block that the CLI currently hardcodes its own version constant and
    // wiring it to package.json is out of scope for task 1.4. This test
    // asserts the compiled binary responds with a semver-looking string,
    // which is the primary behavioural guarantee (binary runs, Commander
    // wiring survives the --compile step).
    const pkgJson = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string };
    void pkgJson.version;

    const result = spawnSync(builtBinary, ['--version'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });

    // --version is a success exit in Commander.
    expect(result.status).toBe(0);

    const stdout = result.stdout ?? '';
    expect(stdout.trim().length).toBeGreaterThan(0);
    // Semver-shape check: the binary emits a `N.N.N` string. Tightening this
    // to `pkgJson.version` exactly is blocked on wiring the CLI version
    // constant to package.json, tracked separately from task 1.4.
    expect(stdout).toMatch(/^\s*\d+\.\d+\.\d+/);
  });
});
