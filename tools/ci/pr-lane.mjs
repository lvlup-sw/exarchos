#!/usr/bin/env node
/**
 * Runs one suite of the Buildkite pull request lane: `static` or `tests`.
 *
 * The protected worker in lvlup-sw/.github calls this script after the install. It passes the base commit and a mode.
 * In `selected` mode, the script runs only the self-tests and tests that the diff can reach. In `full` mode, it runs all of them.
 *
 * The lane never collects coverage. The coverage ratchet runs on the push-to-main run of `ci.yml`.
 * `tools/ci/pr-lane.json` holds the steps. `tests/scripts/pr-lane-parity.test.ts` maps each `ci.yml` step to a lane step.
 *
 * Usage: node tools/ci/pr-lane.mjs <static|tests> --base <commit> [--mode selected|full|auto] [--summary <file>] [--dry-run]
 * The `--dry-run` flag prints the planned steps and runs none of them.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** The root of the checkout that holds this script. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The path of the lane manifest. */
export const MANIFEST_PATH = path.join(REPO_ROOT, 'tools', 'ci', 'pr-lane.json');

/** The default summary file. The Buildkite worker publishes files that a job writes to `/out`. */
const DEFAULT_SUMMARY_PATH = '/out/exarchos-summary.json';

/** The memory in GiB that each vitest worker of a project uses, plus the memory kept for the main process. */
const WORKER_MEMORY_GIB = Object.freeze({ static: 1.5, unit: 2, core: 3, reserve: 1.5 });

/** One GiB in bytes. */
const GIB = 1024 ** 3;

/** The usage text. */
const USAGE = 'usage: node tools/ci/pr-lane.mjs <static|tests> --base <commit> [--mode selected|full|auto] [--summary <file>] [--dry-run]';

/**
 * Converts a glob to a regular expression. `**` matches across `/`, `*` and `?` stay inside one segment.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let pattern = '';
  let index = 0;
  while (index < glob.length) {
    if (glob.startsWith('**/', index)) {
      pattern += '(?:.*/)?';
      index += 3;
    } else if (glob.startsWith('**', index)) {
      pattern += '.*';
      index += 2;
    } else if (glob[index] === '*') {
      pattern += '[^/]*';
      index += 1;
    } else if (glob[index] === '?') {
      pattern += '[^/]';
      index += 1;
    } else {
      pattern += glob[index].replace(/[.+^${}()|[\]\\]/g, '\\$&');
      index += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * Tells if `file` matches one of `globs`.
 *
 * @param {readonly string[]} globs
 * @param {string} file
 * @returns {boolean}
 */
export function matchesAny(globs, file) {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/**
 * Reads the lane manifest.
 *
 * @param {string} [manifestPath]
 * @returns {any}
 */
export function loadManifest(manifestPath = MANIFEST_PATH) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/**
 * Parses the command line. It throws a usage error for a missing suite, a missing base, or an unknown flag.
 *
 * @param {readonly string[]} argv
 * @returns {{ suite: 'static' | 'tests', base: string, mode: 'selected' | 'full' | 'auto', summary: string, dryRun: boolean }}
 */
export function parseArgs(argv) {
  const [suite, ...rest] = argv;
  if (suite !== 'static' && suite !== 'tests') throw new Error(USAGE);
  const options = { suite, base: '', mode: 'auto', summary: DEFAULT_SUMMARY_PATH, dryRun: false };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === '--dry-run') {
      options.dryRun = true;
      index -= 1;
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value. ${USAGE}`);
    if (flag === '--base') options.base = value;
    else if (flag === '--mode') options.mode = value;
    else if (flag === '--summary') options.summary = value;
    else throw new Error(`unknown flag ${flag}. ${USAGE}`);
  }
  if (options.base === '') throw new Error(`--base is required. ${USAGE}`);
  if (!['selected', 'full', 'auto'].includes(options.mode)) throw new Error(`unknown mode ${options.mode}. ${USAGE}`);
  return options;
}

/**
 * Runs git in `cwd` and returns its standard output. It throws when git fails.
 *
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout;
}

/**
 * Lists the paths that differ between `base` and `HEAD`. The two-dot diff needs only the two commits, so a shallow checkout works.
 *
 * @param {string} base
 * @param {string} cwd
 * @returns {{ all: string[], present: string[] }}
 */
export function changedFiles(base, cwd = REPO_ROOT) {
  const lines = (output) => output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  const all = lines(git(['diff', '--name-only', '--no-renames', base, 'HEAD'], cwd));
  const present = lines(git(['diff', '--name-only', '--no-renames', '--diff-filter=d', base, 'HEAD'], cwd));
  return { all, present };
}

/**
 * Resolves `auto` to `full` when a changed path matches `fullModeGlobs`, or else to `selected`.
 *
 * @param {'selected' | 'full' | 'auto'} mode
 * @param {readonly string[]} changed
 * @param {readonly string[]} fullModeGlobs
 * @returns {'selected' | 'full'}
 */
export function resolveMode(mode, changed, fullModeGlobs) {
  if (mode !== 'auto') return mode;
  return changed.some((file) => matchesAny(fullModeGlobs, file)) ? 'full' : 'selected';
}

/**
 * Reads the CPU and memory limits of this process. A container limit in cgroup v2 wins over the host values.
 *
 * @returns {{ cpus: number, memoryBytes: number }}
 */
export function resourceLimits() {
  let cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  let memoryBytes = os.totalmem();
  try {
    const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota !== 'max' && Number(period) > 0) cpus = Math.min(cpus, Math.max(1, Math.floor(Number(quota) / Number(period))));
  } catch {
    cpus = Math.max(1, cpus);
  }
  try {
    const limit = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (limit !== 'max' && Number(limit) > 0) memoryBytes = Math.min(memoryBytes, Number(limit));
  } catch {
    memoryBytes = Math.max(GIB, memoryBytes);
  }
  return { cpus, memoryBytes };
}

/**
 * Returns the number of vitest workers that the CPU and memory limits allow, at least one.
 *
 * @param {{ cpus: number, memoryBytes: number }} limits
 * @param {number} perWorkerGiB
 * @returns {number}
 */
export function workerCount(limits, perWorkerGiB) {
  const byMemory = Math.floor((limits.memoryBytes / GIB - WORKER_MEMORY_GIB.reserve) / perWorkerGiB);
  return Math.max(1, Math.min(limits.cpus, byMemory));
}

/**
 * Selects the self-tests to run. In `full` mode, all of them run. In `selected` mode, a self-test runs when the diff
 * touches its test file, one of its own paths, or a shared trigger.
 *
 * @param {any} manifest
 * @param {'selected' | 'full'} mode
 * @param {readonly string[]} changed
 * @returns {Array<{ id: string, run: string }>}
 */
export function selectSelfTests(manifest, mode, changed) {
  const shared = manifest.static.selfTestSharedTriggers;
  return manifest.static.selfTests.filter((selfTest) => {
    if (mode === 'full') return true;
    const testFile = selfTest.run.replace(/^bash\s+/, '').trim();
    const triggers = [testFile, ...selfTest.paths, ...shared];
    return changed.some((file) => matchesAny(triggers, file));
  });
}

/**
 * Lists the tracked test files of the `core` project that read the repository tree, plus the forced globs of the manifest.
 * The module graph of `vitest related` cannot see a test that reads files from disk.
 *
 * @param {any} manifest
 * @param {string} cwd
 * @returns {string[]}
 */
export function forcedCoreFiles(manifest, cwd = REPO_ROOT) {
  const tracked = git(['ls-files'], cwd).split('\n').filter((line) => line.length > 0);
  const { forcedCore, coreTestGlobs, repoReaderPattern } = manifest.tests;
  const reader = new RegExp(repoReaderPattern);
  const coreTests = tracked.filter((file) => matchesAny(coreTestGlobs, file));
  const forced = new Set(coreTests.filter((file) => matchesAny(forcedCore, file)));
  for (const file of coreTests) {
    if (forced.has(file)) continue;
    if (reader.test(readFileSync(path.join(cwd, file), 'utf8'))) forced.add(file);
  }
  return [...forced].sort();
}

/**
 * Builds the step list of the `static` suite.
 *
 * @param {any} manifest
 * @param {{ base: string, mode: 'selected' | 'full', changed: string[], limits: { cpus: number, memoryBytes: number } }} context
 * The gates only read the tree, so they run in parallel. The self-tests plant fixtures in the live tree, so they run one at a time after the gates.
 *
 * @returns {{ build: Array<{ id: string, run: string }>, parallel: Array<{ id: string, run: string }>, selfTests: Array<{ id: string, run: string }>, exclusive: Array<{ id: string, run: string }> }}
 */
export function staticPlan(manifest, context) {
  const workers = String(workerCount(context.limits, WORKER_MEMORY_GIB.static));
  const fill = (run) => run.replaceAll('{base}', context.base).replaceAll('{workers}', workers);
  const gates = manifest.static.gates.map((gate) => ({ ...gate, run: fill(gate.run) }));
  return {
    build: manifest.static.build.map((step) => ({ ...step, run: fill(step.run) })),
    parallel: gates.filter((gate) => gate.exclusive !== true),
    selfTests: selectSelfTests(manifest, context.mode, context.changed),
    exclusive: gates.filter((gate) => gate.exclusive === true),
  };
}

/**
 * Lists the test files of the `unit` project outside `tests/architecture/`. The `static` suite runs the architecture files.
 * The `--exclude` flag of vitest does not reach a project that declares its own include, so the list comes from `vitest list`.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
function unitFilesOutsideArchitecture(env) {
  const vitestEntry = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
  const result = spawnSync(process.execPath, [vitestEntry, 'list', '--project', 'unit', '--filesOnly'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`vitest list --project unit failed: ${(result.stderr ?? '').trim()}`);
  return result.stdout
    .split('\n')
    .map((line) => line.replace(/^\[unit\]\s+/, '').trim())
    .filter((file) => file.endsWith('.ts') && !file.startsWith('tests/architecture/'));
}

/**
 * Returns the build target of this host in the form that `tools/release/build-binary.ts` takes, such as `linux-x64`.
 *
 * @returns {string}
 */
function hostTarget() {
  const platform = process.platform === 'win32' ? 'windows' : process.platform;
  return `${platform}-${process.arch}`;
}

/**
 * Builds the step list of the `tests` suite. Each step runs in order, and the suite stops at the first failure.
 *
 * @param {any} manifest
 * @param {{ base: string, mode: 'selected' | 'full', changed: string[], present: string[], limits: { cpus: number, memoryBytes: number }, binDir: string, scratch: string, forced: string[], unitFiles?: string[] }} context
 * @returns {Array<{ id: string, run: string }>}
 */
export function testsPlan(manifest, context) {
  const { mode, changed, present } = context;
  const full = mode === 'full';
  const unitWorkers = workerCount(context.limits, WORKER_MEMORY_GIB.unit);
  const coreWorkers = workerCount(context.limits, WORKER_MEMORY_GIB.core);
  const vitest = (args, workers) => `npx --no-install vitest ${args} --reporter=dot --bail=1 --maxWorkers=${workers}`;
  const quoted = (files) => files.map((file) => `'${file.replace(/'/g, `'\\''`)}'`).join(' ');
  const target = hostTarget();
  const steps = [
    { id: 'tsc-build', run: 'npx --no-install tsc' },
    {
      id: 'binary',
      run: `bun run tools/release/build-binary.ts --target ${target} && mkdir -p '${context.binDir}' && ln -sf "$PWD/dist/bin/exarchos-${target}" '${context.binDir}/exarchos' && exarchos --version`,
    },
    { id: 'unit', run: vitest(`run --project unit ${quoted(context.unitFiles ?? [])}`.trimEnd(), unitWorkers) },
  ];
  const tests = manifest.tests;
  if (full || changed.some((file) => matchesAny(tests.acceptanceFullGlobs, file))) {
    steps.push({ id: 'acceptance', run: vitest('run --project acceptance', unitWorkers) });
  } else if (present.length > 0) {
    steps.push({ id: 'acceptance', run: vitest(`related --run --passWithNoTests --project acceptance ${quoted(present)}`, unitWorkers) });
  }
  if (full || changed.some((file) => matchesAny(tests.binaryTierGlobs, file))) {
    const report = path.join(context.scratch, 'process-report.json');
    steps.push({
      id: 'process',
      run: `${vitest(`run --project process --passWithNoTests --reporter=json --outputFile='${report}'`, 1)} && node -e "const r=require('${report}');const n=(r.numPassedTests||0)+(r.numFailedTests||0);console.log('process tests executed: '+n);if(n<${tests.processFloor}){console.error('the process tier executed '+n+' tests, below the floor of ${tests.processFloor}');process.exit(1)}"`,
    });
    steps.push({ id: 'outcome', run: vitest('run --project outcome', 1) });
  }
  if (full) {
    steps.push({ id: 'core', run: vitest('run --project core', coreWorkers) });
  } else {
    steps.push({ id: 'core', run: vitest(`related --run --passWithNoTests --project core ${quoted([...new Set([...present, ...context.forced])])}`, coreWorkers) });
  }
  return steps;
}

/**
 * Runs one shell step. In stream mode, the output goes straight to this process. Otherwise the step collects it.
 *
 * @param {{ id: string, run: string }} step
 * @param {{ env: NodeJS.ProcessEnv, stream: boolean }} options
 * @returns {Promise<{ id: string, status: 'passed' | 'failed', exitCode: number | null, seconds: number, output: string }>}
 */
function runStep(step, options) {
  const started = Date.now();
  if (options.stream) process.stdout.write(`\n--- ${step.id}: ${step.run}\n`);
  return new Promise((resolve) => {
    const child = spawn('bash', ['-o', 'pipefail', '-c', step.run], {
      cwd: REPO_ROOT,
      env: options.env,
      stdio: options.stream ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    if (!options.stream) {
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
    }
    child.on('close', (code) => {
      const seconds = Math.round((Date.now() - started) / 100) / 10;
      resolve({ id: step.id, status: code === 0 ? 'passed' : 'failed', exitCode: code, seconds, output });
    });
  });
}

/**
 * Runs `steps` with at most `limit` steps at a time. It prints the output of each step as one block when the step ends.
 *
 * @param {Array<{ id: string, run: string }>} steps
 * @param {number} limit
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Array<{ id: string, status: string, exitCode: number | null, seconds: number }>>}
 */
async function runPool(steps, limit, env) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < steps.length) {
      const step = steps[next];
      next += 1;
      const result = await runStep(step, { env, stream: false });
      process.stdout.write(`\n--- ${step.id} (${result.status}, ${result.seconds}s): ${step.run}\n${result.output}`);
      results.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker));
  return results;
}

/**
 * Writes the summary file. A missing parent directory, such as `/out` on a developer machine, skips the write.
 *
 * @param {string} file
 * @param {unknown} summary
 */
function writeSummary(file, summary) {
  if (!existsSync(path.dirname(file))) return;
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
}

/**
 * Prints one line per step and returns the exit code of the suite.
 *
 * @param {Array<{ id: string, status: string, seconds: number }>} results
 * @returns {number}
 */
function report(results) {
  process.stdout.write('\n=== pull request lane summary\n');
  for (const result of results) process.stdout.write(`${result.status === 'passed' ? 'ok  ' : 'FAIL'} ${result.seconds}s ${result.id}\n`);
  const failed = results.filter((result) => result.status !== 'passed');
  process.stdout.write(failed.length === 0 ? 'all steps passed\n' : `${failed.length} step(s) failed: ${failed.map((r) => r.id).join(', ')}\n`);
  return failed.length === 0 ? 0 : 1;
}

/**
 * Runs the suite that the command line names and returns the exit code.
 *
 * @param {readonly string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const manifest = loadManifest();
  const { all, present } = changedFiles(options.base);
  const mode = resolveMode(options.mode, all, manifest.fullModeGlobs);
  const limits = resourceLimits();
  const scratch = path.join(os.tmpdir(), `exarchos-pr-lane-${process.pid}`);
  const binDir = path.join(scratch, 'bin');
  mkdirSync(scratch, { recursive: true });
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'pr-lane',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'pr-lane@example.com',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'pr-lane',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'pr-lane@example.com',
  };
  process.stdout.write(`pull request lane: suite=${options.suite} mode=${mode} base=${options.base} changed=${all.length} cpus=${limits.cpus} memory=${(limits.memoryBytes / GIB).toFixed(1)}GiB\n`);
  if (options.dryRun) {
    rmSync(scratch, { recursive: true, force: true });
    const forced = options.suite === 'tests' && mode === 'selected' ? forcedCoreFiles(manifest) : [];
    const plan =
      options.suite === 'static'
        ? Object.values(staticPlan(manifest, { base: options.base, mode, changed: all, limits })).flat()
        : testsPlan(manifest, { base: options.base, mode, changed: all, present, limits, binDir, scratch, forced });
    process.stdout.write(`changed present files: ${present.length}, forced core files: ${forced.length}\n`);
    for (const step of plan) process.stdout.write(`- ${step.id}: ${step.run.length > 240 ? `${step.run.slice(0, 240)}… (${step.run.length} chars)` : step.run}\n`);
    return 0;
  }
  const results = [];
  const summary = { suite: options.suite, mode, base: options.base, changedFiles: all.length, limits, steps: results };
  try {
    if (options.suite === 'static') {
      const plan = staticPlan(manifest, { base: options.base, mode, changed: all, limits });
      for (const step of plan.build) {
        const result = await runStep(step, { env, stream: true });
        results.push(result);
        if (result.status !== 'passed') break;
      }
      if (results.every((result) => result.status === 'passed')) {
        results.push(...(await runPool(plan.parallel, limits.cpus, env)));
        for (const step of [...plan.selfTests, ...plan.exclusive]) results.push(await runStep(step, { env, stream: true }));
      }
    } else {
      const forced = mode === 'full' ? [] : forcedCoreFiles(manifest);
      summary.forcedCoreFiles = forced.length;
      summary.changedPresentFiles = present.length;
      const unitFiles = unitFilesOutsideArchitecture(env);
      for (const step of testsPlan(manifest, { base: options.base, mode, changed: all, present, limits, binDir, scratch, forced, unitFiles })) {
        const result = await runStep(step, { env, stream: true });
        results.push(result);
        if (result.status !== 'passed') break;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const code = report(results);
  writeSummary(options.summary, { ...summary, steps: results.map(({ output: _output, ...rest }) => rest), exitCode: code });
  return code;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
