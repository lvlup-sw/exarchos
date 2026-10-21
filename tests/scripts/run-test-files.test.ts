/**
 * Tests for `tools/test-helpers/run-test-files.mjs`, the script behind `npm run test:files`.
 *
 * Without a file argument, `vitest run` starts the whole root suite, and that suite deletes the
 * worktree that it runs in. These tests hold that the script refuses before vitest starts.
 * The cases of the binary build run a copy of the script beside an echo vitest and a fake `bun`.
 * No real vitest and no real build starts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnAsync } from '../../tools/test-helpers/spawn.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';
import { pathBinaryTestFiles } from '../../tools/test-helpers/run-test-files.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(REPO_ROOT, 'tools', 'test-helpers', 'run-test-files.mjs');

/** The exit code of a refusal. */
const REFUSED = 2;

/** Runs the script from the repository root with the given arguments. */
function runScript(args: readonly string[]): ReturnType<typeof spawnAsync> {
  return spawnAsync(process.execPath, [SCRIPT, ...args], { cwd: REPO_ROOT, timeout: 30_000 });
}

describe('run-test-files refusals', () => {
  it('RunTestFiles_NoFileArgument_RefusesBeforeVitestStarts', async () => {
    const result = await runScript([]);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
    expect(result.stdout).not.toContain('Test Files');
  });

  it('RunTestFiles_OnlyTheSeparator_RefusesBeforeVitestStarts', async () => {
    const result = await runScript(['--']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
  });

  it('RunTestFiles_ADirectoryArgument_IsRefusedAsNotAFile', async () => {
    const result = await runScript(['tests']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('not files: tests');
  });

  it('RunTestFiles_OnlyAnOption_RefusesBeforeVitestStarts', async () => {
    const result = await runScript(['--project=unit']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
  });
});

/** The echo vitest. It prints its arguments, the first two PATH entries, and whether the first entry holds the binary. */
const ECHO_VITEST = `import { existsSync } from 'node:fs';
import path from 'node:path';
const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
const entries = (process.env[key] ?? '').split(path.delimiter);
const first = entries[0] ?? '';
const binary = path.join(first, process.platform === 'win32' ? 'exarchos.exe' : 'exarchos');
process.stdout.write('ECHO ' + JSON.stringify({ argv: process.argv.slice(2), pathEntries: entries.slice(0, 2), binaryOnFirstPath: existsSync(binary) }) + '\\n');
`;

/** The fake build. It records its arguments, fails when asked, and otherwise writes one binary into its `--outdir`. */
const FAKE_BUN = `import { writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_BUN_MARKER) writeFileSync(process.env.FAKE_BUN_MARKER, JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.FAKE_BUN_EXIT) {
  process.stderr.write('fake build failed\\n');
  process.exit(Number(process.env.FAKE_BUN_EXIT));
}
const outdir = args[args.indexOf('--outdir') + 1];
writeFileSync(path.join(outdir, 'exarchos-fake-host'), 'fake binary\\n', { mode: 0o755 });
`;

/** What the echo vitest printed. */
interface Echo {
  readonly argv: string[];
  readonly pathEntries: string[];
  readonly binaryOnFirstPath: boolean;
}

/** Reads the line of the echo vitest from the output of the script, or `undefined` when vitest did not run. */
function readEcho(stdout: string): Echo | undefined {
  const line = stdout.split('\n').find((text) => text.startsWith('ECHO '));
  if (line === undefined) return undefined;
  const parsed: unknown = JSON.parse(line.slice('ECHO '.length));
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const argv = Reflect.get(parsed, 'argv');
  const pathEntries = Reflect.get(parsed, 'pathEntries');
  const binaryOnFirstPath = Reflect.get(parsed, 'binaryOnFirstPath');
  if (!Array.isArray(argv) || !Array.isArray(pathEntries) || typeof binaryOnFirstPath !== 'boolean') return undefined;
  return {
    argv: argv.filter((arg): arg is string => typeof arg === 'string'),
    pathEntries: pathEntries.filter((entry): entry is string => typeof entry === 'string'),
    binaryOnFirstPath,
  };
}

/**
 * The script builds the `exarchos` binary of the working tree for a file of the `process` project, and puts it first on PATH.
 * The fake `bun` is a POSIX shell script, so these cases do not run on Windows.
 */
describe.skipIf(process.platform === 'win32')('run-test-files binary build for process tests', () => {
  let root = '';
  let copy = '';
  let fakeBin = '';

  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'run-test-files-')));
    copy = path.join(root, 'tools', 'test-helpers', 'run-test-files.mjs');
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(SCRIPT, copy);
    mkdirSync(path.join(root, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ECHO_VITEST);
    for (const file of ['tests/process/sample.test.ts', 'tests/unit/sample.test.ts']) {
      mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(root, file), '');
    }
    fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(path.join(root, 'fake-bun.mjs'), FAKE_BUN);
    writeFileSync(
      path.join(fakeBin, 'bun'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'fake-bun.mjs'))} "$@"\n`,
    );
    chmodSync(path.join(fakeBin, 'bun'), 0o755);
  });

  afterAll(() => {
    if (root !== '') rmrf(root);
  });

  function runCopy(args: readonly string[], env: Readonly<Record<string, string>>): ReturnType<typeof spawnAsync> {
    return spawnAsync(process.execPath, [copy, ...args], {
      cwd: root,
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}`, ...env },
      timeout: 30_000,
    });
  }

  it('RunTestFiles_ProcessTestFile_PutsTheBinaryOfTheTreeFirstOnPath', async () => {
    const marker = path.join(root, 'build-process.json');

    const result = await runCopy(['tests/process/sample.test.ts'], { FAKE_BUN_MARKER: marker });

    expect(result.status, result.stderr).toBe(0);
    const echo = readEcho(result.stdout);
    expect(echo?.argv).toEqual(['run', 'tests/process/sample.test.ts']);
    const buildDir = echo?.pathEntries[0] ?? '';
    expect(buildDir).not.toBe(fakeBin);
    expect(echo?.pathEntries[1]).toBe(fakeBin);
    expect(echo?.binaryOnFirstPath).toBe(true);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      args: ['run', 'tools/release/build-binary.ts', '--outdir', buildDir],
      cwd: root,
    });
    expect(existsSync(buildDir)).toBe(false);
  });

  it('RunTestFiles_NoProcessTestFile_BuildsNoBinaryAndKeepsThePath', async () => {
    const marker = path.join(root, 'build-unit.json');

    const result = await runCopy(['tests/unit/sample.test.ts'], { FAKE_BUN_MARKER: marker });

    expect(result.status, result.stderr).toBe(0);
    const echo = readEcho(result.stdout);
    expect(echo?.argv).toEqual(['run', 'tests/unit/sample.test.ts']);
    expect(echo?.pathEntries[0]).toBe(fakeBin);
    expect(existsSync(marker)).toBe(false);
  });

  it('RunTestFiles_FailedBuild_RefusesWithExit2AndRunsNoTest', async () => {
    const result = await runCopy(['tests/unit/sample.test.ts', 'tests/process/sample.test.ts'], { FAKE_BUN_EXIT: '1' });

    expect(result.status).toBe(REFUSED);
    expect(readEcho(result.stdout)).toBeUndefined();
    expect(result.stderr).toContain('did not build');
    expect(result.stderr).toContain('fake build failed');
  });
});

describe('pathBinaryTestFiles', () => {
  /** The table matches the include of the `process` project, for a relative path and an absolute path. Near misses stay out. */
  it('PathBinaryTestFiles_ProcessInclude_MatchesOnlyItsFiles', () => {
    const files = [
      'tests/process/a.test.ts',
      'tests/process/cli/b.test.ts',
      path.join(REPO_ROOT, 'tests', 'process', 'c.test.ts'),
      'tests/unit/a.test.ts',
      'tests/processes/a.test.ts',
      'tests/process/helper.ts',
      'src/tests/process/a.test.ts',
    ];

    expect(pathBinaryTestFiles(files, REPO_ROOT)).toEqual(files.slice(0, 3));
  });
});
