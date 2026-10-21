/**
 * Tests for `tools/test-helpers/run-test-files.mjs`, the script behind `npm run test:files`.
 *
 * With no file, `vitest run` can start the whole root suite. These tests hold that the script refuses before vitest starts.
 * Each case runs a copy of the script in a temporary tree beside an echo vitest, so no case can start the real vitest.
 * Thus a changed script turns a case red and starts no suite. The binary cases add a fake `bun`, so no real build starts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
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

/** The files of each temporary tree. They are empty, because the echo vitest reads no file. */
const TREE_FILES = ['tests/process/sample.test.ts', 'tests/unit/sample.test.ts', 'tests/unit/other.test.ts', 'vitest.config.ts'];

/**
 * The echo vitest. It prints its arguments, the first two PATH entries, and whether the first entry holds the binary.
 * It exits with the code in `ECHO_EXIT`, or with 0.
 * When asked, it writes a file into a read-only directory in the first entry, so that the script cannot delete that entry.
 */
const ECHO_VITEST = `import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
const entries = (process.env[key] ?? '').split(path.delimiter);
const first = entries[0] ?? '';
const binary = path.join(first, process.platform === 'win32' ? 'exarchos.exe' : 'exarchos');
if (process.env.FAKE_VITEST_HOLD_FIRST_PATH) {
  const held = path.join(first, 'held');
  mkdirSync(held);
  writeFileSync(path.join(held, 'file'), 'held\\n');
  chmodSync(held, 0o555);
}
process.stdout.write('ECHO ' + JSON.stringify({ argv: process.argv.slice(2), pathEntries: entries.slice(0, 2), binaryOnFirstPath: existsSync(binary) }) + '\\n');
process.exitCode = Number(process.env.ECHO_EXIT ?? '0');
`;

/**
 * The fake build. It records its arguments, fails when asked, and otherwise writes one binary into its `--outdir`.
 * When asked, it also writes a directory with the bare binary name, so that the rename of the binary fails.
 * When asked to hold, it writes no binary and waits until its `--outdir` is gone.
 */
const FAKE_BUN = `import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (process.env.FAKE_BUN_MARKER) writeFileSync(process.env.FAKE_BUN_MARKER, JSON.stringify({ args, cwd: process.cwd() }));
if (process.env.FAKE_BUN_EXIT) {
  process.stderr.write('fake build failed\\n');
  process.exit(Number(process.env.FAKE_BUN_EXIT));
}
const outdir = args[args.indexOf('--outdir') + 1];
if (process.env.FAKE_BUN_HOLD) {
  setInterval(() => {
    if (!existsSync(outdir)) process.exit(1);
  }, 20);
  setTimeout(() => process.exit(1), 20000);
} else {
  writeFileSync(path.join(outdir, 'exarchos-fake-host'), 'fake binary\\n', { mode: 0o755 });
  if (process.env.FAKE_BUN_BLOCK_RENAME) {
    mkdirSync(path.join(outdir, 'exarchos'));
    writeFileSync(path.join(outdir, 'exarchos', 'file'), 'blocks the rename\\n');
  }
}
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

/** Reads the `--outdir` that the fake build wrote into `marker`, or an empty string when the marker is absent or not complete. */
function readBuildDir(marker: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, 'utf8'));
    const args: unknown = typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'args') : undefined;
    if (!Array.isArray(args)) return '';
    const outdir: unknown = args[args.indexOf('--outdir') + 1];
    return typeof outdir === 'string' ? outdir : '';
  } catch {
    return '';
  }
}

/** Polls `check` until it returns true or the time ends. It resolves to the last result of `check`. */
async function waitFor(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

/** Copies the tracked script into `tree` at its path in the repository, and writes the files of {@link TREE_FILES}. It returns the copy. */
function makeTree(tree: string): string {
  const copy = path.join(tree, 'tools', 'test-helpers', 'run-test-files.mjs');
  mkdirSync(path.dirname(copy), { recursive: true });
  copyFileSync(SCRIPT, copy);
  for (const file of TREE_FILES) {
    mkdirSync(path.join(tree, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(tree, file), '');
  }
  return copy;
}

/** Returns the first vitest entry point in a `node_modules` directory from `dir` up, or `undefined` when there is none. */
function vitestEntryAbove(dir: string): string | undefined {
  for (let current = dir; ; current = path.dirname(current)) {
    const candidate = path.join(current, 'node_modules', 'vitest', 'vitest.mjs');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (path.dirname(current) === current) return undefined;
  }
}

/** Runs `script` with node in `cwd`. The child gets the environment of the test with `env` added. */
function runScriptIn(
  script: string,
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): ReturnType<typeof spawnAsync> {
  return spawnAsync(process.execPath, [script, ...args], { cwd, env: { ...process.env, ...env }, timeout: 30_000 });
}

/** The temporary tree. It holds the copy of the script, the files of {@link TREE_FILES}, and the echo vitest in its `node_modules`. */
let root = '';
/** The copy of the script in {@link root}. */
let copy = '';

beforeAll(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'run-test-files-')));
  copy = makeTree(root);
  mkdirSync(path.join(root, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), ECHO_VITEST);
});

afterAll(() => {
  if (root !== '') rmrf(root);
});

/** Runs the copy of the script in the temporary tree, beside the echo vitest. */
function runCopy(args: readonly string[], env: Readonly<Record<string, string>> = {}): ReturnType<typeof spawnAsync> {
  return runScriptIn(copy, root, args, env);
}

describe('run-test-files refusals', () => {
  it('RunTestFiles_NoFileArgument_RefusesBeforeVitestStarts', async () => {
    const result = await runCopy([]);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
    expect(readEcho(result.stdout)).toBeUndefined();
    expect(result.stdout).not.toContain('Test Files');
  });

  it('RunTestFiles_OnlyTheSeparator_RefusesBeforeVitestStarts', async () => {
    const result = await runCopy(['--']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
    expect(readEcho(result.stdout)).toBeUndefined();
  });

  /** The directory comes with a test file, so only the refusal of an argument that is not a file stops the run. */
  it('RunTestFiles_ADirectoryArgument_IsRefusedAsNotAFile', async () => {
    const result = await runCopy(['tests/unit/sample.test.ts', 'tests']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('not files: tests');
    expect(readEcho(result.stdout)).toBeUndefined();
  });

  it('RunTestFiles_OnlyAnOption_RefusesBeforeVitestStarts', async () => {
    const result = await runCopy(['--project=unit']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused');
    expect(readEcho(result.stdout)).toBeUndefined();
  });

  /**
   * vitest reads `vitest.config.ts` as the value of `--config` or `-c`, and then gets no file filter.
   * The value names a file, so only the refusal of an option with no `=` stops the run.
   */
  it('RunTestFiles_OptionWithASeparateValue_RefusesBeforeVitestStarts', async () => {
    const result = await runCopy(['--config', 'vitest.config.ts', '-c', 'vitest.config.ts']);
    expect(result.status).toBe(REFUSED);
    expect(result.stderr).toContain('refused. These options hold no =: --config, -c.');
    expect(readEcho(result.stdout)).toBeUndefined();
  });

  /** No `node_modules` from the tree up holds vitest. A vitest on `NODE_PATH` is not an install of the tree, so the script does not run it. */
  it('RunTestFiles_NoLocalVitest_RefusesWithExit2', async () => {
    const bare = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'run-test-files-bare-')));
    try {
      const bareCopy = makeTree(bare);
      const nodePath = path.join(bare, 'node-path');
      mkdirSync(path.join(nodePath, 'vitest'), { recursive: true });
      writeFileSync(path.join(nodePath, 'vitest', 'vitest.mjs'), ECHO_VITEST);
      expect(vitestEntryAbove(bare), 'a vitest above the temporary directory').toBeUndefined();

      const result = await runScriptIn(bareCopy, bare, ['tests/unit/sample.test.ts'], { NODE_PATH: nodePath });

      expect(result.status).toBe(REFUSED);
      expect(result.stderr).toContain('the local vitest is missing');
      expect(readEcho(result.stdout)).toBeUndefined();
    } finally {
      rmrf(bare);
    }
  });
});

describe('run-test-files runs the local vitest', () => {
  /** A package manager can pass the separator on. The script drops it, and vitest gets `run` and the files in order. */
  it('RunTestFiles_TestFiles_RunsVitestOnExactlyTheseFiles', async () => {
    const result = await runCopy(['--', 'tests/unit/sample.test.ts', 'tests/unit/other.test.ts']);

    expect(result.status, result.stderr).toBe(0);
    expect(readEcho(result.stdout)?.argv).toEqual(['run', 'tests/unit/sample.test.ts', 'tests/unit/other.test.ts']);
  });

  it('RunTestFiles_OptionWithItsValueAfterEquals_IsForwarded', async () => {
    const result = await runCopy(['--reporter=dot', 'tests/unit/sample.test.ts']);

    expect(result.status, result.stderr).toBe(0);
    expect(readEcho(result.stdout)?.argv).toEqual(['run', '--reporter=dot', 'tests/unit/sample.test.ts']);
  });

  /** The kill probe reads the exit code of the script. An exit that is not 0 or 1 gives no verdict, so the script passes each code on. */
  it('RunTestFiles_VitestExitCode_IsTheExitCodeOfTheScript', async () => {
    const result = await runCopy(['tests/unit/sample.test.ts'], { ECHO_EXIT: '3' });

    expect(result.status, result.stderr).toBe(3);
    expect(readEcho(result.stdout)?.argv).toEqual(['run', 'tests/unit/sample.test.ts']);
  });

  /** A worktree inside a checkout can have no install of its own. The script then runs the vitest of the checkout above it. */
  it('RunTestFiles_NoInstallInTheTree_RunsTheVitestOfTheDirectoryAbove', async () => {
    const tree = path.join(root, 'nested-worktree');
    const nestedCopy = makeTree(tree);
    expect(existsSync(path.join(tree, 'node_modules'))).toBe(false);

    const result = await runScriptIn(nestedCopy, tree, ['tests/unit/sample.test.ts']);

    expect(result.status, result.stderr).toBe(0);
    expect(readEcho(result.stdout)?.argv).toEqual(['run', 'tests/unit/sample.test.ts']);
  });
});

/**
 * The script builds the `exarchos` binary of the working tree for a file of the `process` project, and puts it first on PATH.
 * The fake `bun` is a POSIX shell script, so these cases do not run on Windows.
 */
describe.skipIf(process.platform === 'win32')('run-test-files binary build for process tests', () => {
  let fakeBin = '';

  beforeAll(() => {
    fakeBin = path.join(root, 'fake-bin');
    mkdirSync(fakeBin);
    writeFileSync(path.join(root, 'fake-bun.mjs'), FAKE_BUN);
    writeFileSync(
      path.join(fakeBin, 'bun'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, 'fake-bun.mjs'))} "$@"\n`,
    );
    chmodSync(path.join(fakeBin, 'bun'), 0o755);
  });

  function runWithFakeBun(args: readonly string[], env: Readonly<Record<string, string>>): ReturnType<typeof spawnAsync> {
    return runCopy(args, { PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}`, ...env });
  }

  it('RunTestFiles_ProcessTestFile_PutsTheBinaryOfTheTreeFirstOnPath', async () => {
    const marker = path.join(root, 'build-process.json');

    const result = await runWithFakeBun(['tests/process/sample.test.ts'], { FAKE_BUN_MARKER: marker });

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

    const result = await runWithFakeBun(['tests/unit/sample.test.ts'], { FAKE_BUN_MARKER: marker });

    expect(result.status, result.stderr).toBe(0);
    const echo = readEcho(result.stdout);
    expect(echo?.argv).toEqual(['run', 'tests/unit/sample.test.ts']);
    expect(echo?.pathEntries[0]).toBe(fakeBin);
    expect(existsSync(marker)).toBe(false);
  });

  it('RunTestFiles_FailedBuild_RefusesWithExit2AndRunsNoTest', async () => {
    const result = await runWithFakeBun(['tests/unit/sample.test.ts', 'tests/process/sample.test.ts'], { FAKE_BUN_EXIT: '1' });

    expect(result.status).toBe(REFUSED);
    expect(readEcho(result.stdout)).toBeUndefined();
    expect(result.stderr).toContain('did not build');
    expect(result.stderr).toContain('fake build failed');
  });

  /** An error of the file system before the build is a refusal with no verdict. Node exits 1 on an uncaught error, and the probe reads 1 as red. */
  it('RunTestFiles_TemporaryDirectoryNotMade_RefusesWithExit2AndStartsNoBuild', async () => {
    const marker = path.join(root, 'build-no-tmp.json');

    const result = await runWithFakeBun(['tests/process/sample.test.ts'], {
      FAKE_BUN_MARKER: marker,
      TMPDIR: path.join(root, 'missing-tmp'),
    });

    expect(result.status, result.stderr).toBe(REFUSED);
    expect(readEcho(result.stdout)).toBeUndefined();
    expect(result.stderr).toContain('the temporary directory for the build was not made');
    expect(existsSync(marker)).toBe(false);
  });

  /** An error of the file system after the build is a refusal with no verdict, and the build directory goes away. */
  it('RunTestFiles_RenameOfTheBuiltBinaryFails_RefusesWithExit2AndDeletesTheBuildDirectory', async () => {
    const marker = path.join(root, 'build-rename.json');

    const result = await runWithFakeBun(['tests/process/sample.test.ts'], { FAKE_BUN_MARKER: marker, FAKE_BUN_BLOCK_RENAME: '1' });

    expect(result.status, result.stderr).toBe(REFUSED);
    expect(readEcho(result.stdout)).toBeUndefined();
    expect(result.stderr).toContain('the script did not prepare the built binary');
    const buildDir = readBuildDir(marker);
    expect(buildDir).not.toBe('');
    expect(existsSync(buildDir)).toBe(false);
  });

  /**
   * A build directory that the script cannot delete gives a warning, and the green exit of vitest stays.
   * The root user can delete a read-only directory, so the case does not run as root.
   */
  it.skipIf(process.getuid?.() === 0)('RunTestFiles_BuildDirectoryNotDeleted_WarnsAndKeepsTheExitCodeOfVitest', async () => {
    const result = await runWithFakeBun(['tests/process/sample.test.ts'], { FAKE_VITEST_HOLD_FIRST_PATH: '1' });
    const buildDir = readEcho(result.stdout)?.pathEntries[0] ?? '';
    const held = path.join(buildDir, 'held');
    try {
      expect(buildDir).not.toBe('');
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain(`the build directory ${buildDir} was not deleted`);
      expect(existsSync(held)).toBe(true);
    } finally {
      if (buildDir !== '' && existsSync(held)) {
        chmodSync(held, 0o755);
        rmrf(buildDir);
      }
    }
  });

  /** A signal during the build stops the script, and the script deletes the build directory before it stops. */
  it('RunTestFiles_SignalDuringTheBuild_DeletesTheBuildDirectory', async () => {
    const marker = path.join(root, 'build-signal.json');
    const child = spawn(process.execPath, [copy, 'tests/process/sample.test.ts'], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
        FAKE_BUN_MARKER: marker,
        FAKE_BUN_HOLD: '1',
      },
      stdio: 'ignore',
    });
    const stopped = new Promise<NodeJS.Signals | null>((resolve) => {
      child.on('close', (_code, signal) => resolve(signal));
    });
    try {
      expect(await waitFor(() => readBuildDir(marker) !== '', 10_000)).toBe(true);
      const buildDir = readBuildDir(marker);
      expect(existsSync(buildDir)).toBe(true);

      child.kill('SIGTERM');

      expect(await stopped).toBe('SIGTERM');
      expect(existsSync(buildDir)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
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
