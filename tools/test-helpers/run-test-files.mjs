#!/usr/bin/env node
// @ts-check
/**
 * Runs `vitest run` on the test files that it gets as arguments. `npm run test:files -- <files>` starts it.
 *
 * The run has no `--project` filter, so vitest runs each file in the project that collects it.
 * The kill probe uses the script to run the changed test files of a task.
 *
 * It refuses to start when it gets no file, or when an argument is not a file.
 * vitest reads a file argument as a substring filter. With no file, `vitest run` starts the whole
 * root suite, and a short filter starts a large part of it. The whole suite deletes the worktree that
 * it runs in.
 * An argument that starts with `-` is a vitest option. Write an option value as `--name=value`.
 *
 * A file of the `process` project tests the `exarchos` binary on PATH. For such a file, the script builds the binary of the
 * working tree into a temporary directory and puts that directory first on PATH. Thus each run of the probe tests the tree that the probe sees.
 *
 * The exit code is the exit code of vitest. A refusal, a failed build or a vitest that does not start exits 2.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The entry point of the local vitest. The script never downloads a runner. */
const VITEST_ENTRY = path.resolve(HERE, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');

/** The exit code of a refusal, of a failed build, and of a vitest that does not start or that a signal stops. */
const REFUSED = 2;

/**
 * The include globs of each vitest project whose setup checks the `exarchos` binary on PATH.
 * This table is a deliberate copy of the include of the `process` project in `vitest.config.ts`.
 * The script cannot import that TypeScript file, and the guard inventory reads the include there as literal globs.
 * `tests/architecture/vitest-config.test.ts` fails when the table and the config differ.
 * @type {readonly string[]}
 */
export const PATH_BINARY_TEST_GLOBS = Object.freeze(['tests/process/**/*.test.ts']);

/** The name prefix of the binaries that `tools/release/build-binary.ts` writes, such as `exarchos-linux-x64`. */
const BUILT_BINARY_PREFIX = 'exarchos-';

/** The name under which the setup of the `process` project looks for the binary on PATH. */
const PATH_BINARY_NAME = process.platform === 'win32' ? 'exarchos.exe' : 'exarchos';

/**
 * Returns true when `candidate` names a regular file, relative to the working directory or absolute.
 * @param {string} candidate
 */
function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Sorts the arguments into test files and arguments that are not files, and keeps the order of the
 * arguments for vitest. A bare `--` separator is dropped, because some package managers pass it on.
 * @param {readonly string[]} argv
 * @returns {{ forwarded: string[]; files: string[]; notFiles: string[] }}
 */
function splitArguments(argv) {
  const forwarded = [];
  const files = [];
  const notFiles = [];
  for (const arg of argv) {
    if (arg === '--') continue;
    forwarded.push(arg);
    if (arg.startsWith('-')) continue;
    if (isFile(arg)) files.push(arg);
    else notFiles.push(arg);
  }
  return { forwarded, files, notFiles };
}

/**
 * Returns a regular expression for a glob of the include dialect. A `**` before `/` matches any number of directories.
 * Another `**` matches any characters. A `*` matches characters other than `/`, and each other character is literal.
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*' && glob.charAt(index + 1) === '*') {
      const beforeSlash = glob.charAt(index + 2) === '/';
      pattern += beforeSlash ? '(?:.*/)?' : '.*';
      index += beforeSlash ? 2 : 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else {
      pattern += char.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
}

/**
 * Returns the files that match {@link PATH_BINARY_TEST_GLOBS}, in input order.
 * A file is a path relative to `cwd` or an absolute path. The globs are relative to `cwd`, the root of the vitest config.
 * @param {readonly string[]} files
 * @param {string} cwd
 * @returns {string[]}
 */
export function pathBinaryTestFiles(files, cwd) {
  const matchers = PATH_BINARY_TEST_GLOBS.map(globToRegExp);
  return files.filter((file) => {
    const relative = path.relative(cwd, path.resolve(cwd, file)).split(path.sep).join('/');
    return matchers.some((matcher) => matcher.test(relative));
  });
}

/**
 * Returns a copy of `env` with `dir` first on PATH. Windows can name the key `Path`, so the copy keeps the key that `env` uses.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} dir
 * @returns {NodeJS.ProcessEnv}
 */
function withFirstOnPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  return { ...env, [key]: current === undefined || current === '' ? dir : `${dir}${path.delimiter}${current}` };
}

/**
 * Runs `tools/release/build-binary.ts` with `bun` in `cwd`, with `dir` as the output directory, and collects the output.
 * The command runs through a shell on each platform, so Windows resolves a `bun.cmd` shim as `runCommandSync` does.
 * The only value in the command is the quoted temporary directory. A missing `bun` gives the exit code of the shell.
 * @param {string} dir
 * @param {string} cwd
 * @returns {Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string; error?: Error }>}
 */
function runBuild(dir, cwd) {
  const quoted = process.platform === 'win32' ? `"${dir}"` : `'${dir.replace(/'/g, `'\\''`)}'`;
  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const chunks = [];
    const child = spawn(`bun run tools/release/build-binary.ts --outdir ${quoted}`, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', (error) => resolve({ code: null, signal: null, output: Buffer.concat(chunks).toString('utf-8'), error }));
    child.on('close', (code, signal) => resolve({ code, signal, output: Buffer.concat(chunks).toString('utf-8') }));
  });
}

/**
 * Builds the `exarchos` binary of the working tree in `cwd` into a new temporary directory, with `tools/release/build-binary.ts`.
 * The binary gets the bare name that the setup of the `process` project looks for on PATH.
 * It resolves to the directory, or to the reason that no binary is there. On a failure, it removes the directory.
 * The build writes `src/install/runtimes/embedded.ts` from the runtime files, as each build does.
 * @param {string} cwd
 * @returns {Promise<{ dir: string } | { error: string }>}
 */
async function buildPathBinary(cwd) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'exarchos-test-files-'));
  const fail = (/** @type {string} */ error) => {
    rmSync(dir, { recursive: true, force: true });
    return { error };
  };
  const result = await runBuild(dir, cwd);
  if (result.error !== undefined) return fail(`the shell did not start: ${result.error.message}`);
  if (result.code !== 0) {
    const end = result.code === null ? `stopped on signal ${String(result.signal)}` : `exited ${result.code}`;
    return fail(`the build ${end}. The build output ends with:\n${result.output.trimEnd().split('\n').slice(-20).join('\n')}`);
  }
  const built = readdirSync(dir).filter((name) => name.startsWith(BUILT_BINARY_PREFIX));
  const [binary] = built;
  if (binary === undefined || built.length !== 1) {
    return fail(`the build wrote ${built.length} binaries into ${dir}, and the script needs one`);
  }
  renameSync(path.join(dir, binary), path.join(dir, PATH_BINARY_NAME));
  return { dir };
}

/**
 * Runs vitest with inherited stdio and the given environment. It resolves to the exit code for the process.
 * @param {readonly string[]} forwarded
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function runVitest(forwarded, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST_ENTRY, 'run', ...forwarded], { stdio: 'inherit', env });
    child.on('error', (error) => {
      process.stderr.write(`test:files: vitest did not start: ${error.message}\n`);
      resolve(REFUSED);
    });
    child.on('exit', (code, signal) => {
      if (code === null) {
        process.stderr.write(`test:files: vitest stopped on signal ${String(signal)}.\n`);
        resolve(REFUSED);
        return;
      }
      resolve(code);
    });
  });
}

/**
 * Builds the binary for the files of the `process` project, then runs vitest with that binary first on PATH.
 * It removes the binary when vitest ends, and also when `SIGINT` or `SIGTERM` stops the script.
 * @param {readonly string[]} forwarded
 * @param {readonly string[]} binaryFiles
 * @returns {Promise<number>}
 */
async function runWithPathBinary(forwarded, binaryFiles) {
  const built = await buildPathBinary(process.cwd());
  if ('error' in built) {
    process.stderr.write(
      `test:files: refused. The tests ${binaryFiles.join(', ')} check the exarchos binary on PATH, ` +
        `and the binary of the working tree did not build: ${built.error}\n`,
    );
    return REFUSED;
  }
  /** @type {NodeJS.Signals[]} */
  const signals = ['SIGINT', 'SIGTERM'];
  const onSignal = (/** @type {NodeJS.Signals} */ signal) => {
    rmSync(built.dir, { recursive: true, force: true });
    process.kill(process.pid, signal);
  };
  for (const signal of signals) process.once(signal, onSignal);
  process.stdout.write(`test:files: the exarchos binary of the working tree is first on PATH, from ${built.dir}.\n`);
  try {
    return await runVitest(forwarded, withFirstOnPath(process.env, built.dir));
  } finally {
    for (const signal of signals) process.removeListener(signal, onSignal);
    rmSync(built.dir, { recursive: true, force: true });
  }
}

/**
 * Checks the arguments, then runs vitest. It resolves to the exit code for the process.
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
async function main(argv) {
  const { forwarded, files, notFiles } = splitArguments(argv);
  if (notFiles.length > 0) {
    process.stderr.write(
      `test:files: refused. These arguments are not files: ${notFiles.join(', ')}. ` +
        'Give the paths of test files. Write an option value as --name=value.\n',
    );
    return REFUSED;
  }
  if (files.length === 0) {
    process.stderr.write(
      'test:files: refused. Give at least one test file, for example ' +
        '`npm run test:files -- tests/unit/config/tokenize-command.test.ts`. ' +
        'Without a file, vitest runs the whole root suite.\n',
    );
    return REFUSED;
  }
  if (!existsSync(VITEST_ENTRY)) {
    process.stderr.write(`test:files: the local vitest is missing at ${VITEST_ENTRY}. Run npm install.\n`);
    return REFUSED;
  }
  const binaryFiles = pathBinaryTestFiles(files, process.cwd());
  if (binaryFiles.length > 0) return runWithPathBinary(forwarded, binaryFiles);
  return runVitest(forwarded, process.env);
}

/** Returns true when node runs this file as its entry script. A module that imports the glob table starts no run. */
function isEntryScript() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) process.exitCode = await main(process.argv.slice(2));
