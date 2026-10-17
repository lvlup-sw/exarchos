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
 * The exit code is the exit code of vitest. A refusal or a vitest that does not start exits 2.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The entry point of the local vitest. The script never downloads a runner. */
const VITEST_ENTRY = path.resolve(HERE, '..', '..', 'node_modules', 'vitest', 'vitest.mjs');

/** The exit code of a refusal, and of a vitest that does not start or that a signal stops. */
const REFUSED = 2;

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
 * Checks the arguments, then runs vitest with inherited stdio. It resolves to the exit code for the process.
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
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST_ENTRY, 'run', ...forwarded], { stdio: 'inherit' });
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

process.exitCode = await main(process.argv.slice(2));
