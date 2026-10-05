/**
 * Integration tests for `tools/release/build-binary.ts`.
 * The suite builds the host binary into a sandbox, then runs that binary with `--version`.
 * The build takes about 30 seconds, and the 3-minute timeout allows for a cold bun cache.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepoSandbox, type RepoSandbox } from '../../tools/test-helpers/repo-sandbox.js';

import { spawnAsync } from '../../tools/test-helpers/spawn.js';

/** Pure ESM does not define `__dirname`, so this file derives it from `import.meta.url`. */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../..');
const BUILD_SCRIPT = join(REPO_ROOT, 'tools', 'release', 'build-binary.ts');

/**
 * The build writes into an empty sandbox through `--outdir`, never into the
 * live `dist/bin` that other suites read (#2030). An empty directory also
 * means the binary found afterwards is the one this build made.
 */
let output: RepoSandbox | undefined;
let DIST_BIN_DIR = '';

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

describe('tools/release/build-binary.ts', () => {
  let builtBinary: string;

  beforeAll(async () => {
    output = await makeRepoSandbox({ prefix: 'build-binary' });
    DIST_BIN_DIR = output.path('dist/bin');

    if (!existsSync(BUILD_SCRIPT)) {
      throw new Error(
        `build script missing: ${BUILD_SCRIPT}. ` +
          `Expected tools/release/build-binary.ts to exist.`,
      );
    }

    const result = await spawnAsync('bun', ['run', BUILD_SCRIPT, '--outdir', DIST_BIN_DIR], {
      cwd: REPO_ROOT,
      env: process.env,
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

  afterAll(() => {
    output?.remove();
  });

  /**
   * A size of zero shows a build that failed without an error.
   * Windows gives the mode bits a different meaning, so the owner-executable check runs on POSIX only.
   */
  it('BuildBinary_HostTarget_ProducesExecutable', () => {
    expect(existsSync(builtBinary)).toBe(true);

    const st = statSync(builtBinary);
    expect(st.isFile()).toBe(true);

    expect(st.size).toBeGreaterThan(0);

    if (hostOs() !== 'windows') {
      expect(st.mode & 0o100).toBeGreaterThan(0);
    }
  });

  /**
   * The binary must exit 0 and print text that starts with a `N.N.N` version.
   * The test reads `package.json` but does not compare the output with that version.
   */
  it('BuildBinary_CompiledBinary_RespondsToVersionFlag', async () => {
    const pkgJson = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'),
    ) as { version: string };
    void pkgJson.version;

    const result = await spawnAsync(builtBinary, ['--version'], {
      timeout: 30_000,
    });

    expect(result.status).toBe(0);

    const stdout = result.stdout ?? '';
    expect(stdout.trim().length).toBeGreaterThan(0);
    expect(stdout).toMatch(/^\s*\d+\.\d+\.\d+/);
  });
});
