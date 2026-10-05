/**
 * Grader for the quality A/B eval. A run is a directory named `<task>__<arm>__r<rep>` under the base directory.
 * The grader scores the `impl.ts` of each run against the hidden oracle of its task and against strict `tsc`.
 * It measures test adequacy with the production kill probe `runProbe`. No run reports its own score.
 * The module of `runProbe` loads no event store and no SQLite, so this file stays a small `tsx` script.
 *
 * Run: `tsx tests/evals/quality-ab/grade.ts <baseRunsDir> [tasksDir]`
 *
 * Oracle isolation: each `oracle.ts` under `tasks` is an answer key. The repo holds it so that a grade is reproducible.
 * An agent under test must run in a workspace that holds no oracle. Do not dispatch an agent from the repo checkout.
 * The grader copies the oracle into the run directory at grade time and removes it again.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execFileAsync, spawnAsync, SpawnFailure } from '../../../tools/test-helpers/spawn.js';

import {
  runProbe,
  type ProbeResult,
  type TestRunFn,
} from '../../../src/verbs/gates/test-adequacy.js';
import type { GitExec } from '../../../src/verbs/pure/execute-merge.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../../');
export const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
export const TSC = path.join(REPO_ROOT, 'node_modules/.bin/tsc');

/**
 * The adequacy of the tests of a run, as the kill probe measured it.
 * When the probe did not measure a suite, `score` is `null`. The grader never puts 0 or 1 in its place.
 */
export interface AdequacyResult {
  /** True when the probe ran the suite of the run and measured it. */
  readonly probed: boolean;
  /** True when at least one test went red after the probe reverted the impl to the stub. */
  readonly redObserved: boolean;
  /** `1` when a test went red (killed), `0` when the suite stayed green (survived), `null` when not measured. */
  readonly score: number | null;
  /** The cause of a result that is not nominal, such as `no-new-tests`, `revert-conflict` or `setup-failed`. */
  readonly discriminant?: string;
  /** The reason when the grader did not measure the suite. A run with no tests carries no error. */
  readonly error?: string;
}

export interface RunResult {
  run: string;
  task: string;
  arm: string;
  rep: string;
  oraclePassed: number;
  oracleTotal: number;
  oracleFailures: string[];
  typecheckOk: boolean;
  wroteTests: boolean;
  adequacyProbed: boolean;
  adequacyRedObserved: boolean;
  adequacyScore: number | null;
  adequacyDiscriminant?: string;
  error?: string;
}

/**
 * Runs the hidden oracle of `task` against the impl in `runDir`. It removes the oracle from the run directory in every case.
 * When the oracle cannot run (a missing export, a throw at load, a syntax error), the run passes 0 of the checks that {@link countOracleChecks} counts.
 */
export async function gradeOracle(
  runDir: string,
  task: string,
  tasksDir: string,
): Promise<Pick<RunResult, 'oraclePassed' | 'oracleTotal' | 'oracleFailures' | 'error'>> {
  const oracleSrc = path.join(tasksDir, task, 'oracle.ts');
  const oracleDst = path.join(runDir, 'oracle.ts');
  fs.copyFileSync(oracleSrc, oracleDst);
  try {
    const out = await execFileAsync(TSX, ['oracle.ts'], { cwd: runDir });
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
    const parsed = JSON.parse(line) as { passed: number; total: number; failures: string[] };
    return { oraclePassed: parsed.passed, oracleTotal: parsed.total, oracleFailures: parsed.failures };
  } catch (err) {
    const total = countOracleChecks(oracleSrc);
    const msg = err instanceof SpawnFailure && err.status !== null ? err.stderr : err instanceof Error ? err.message : String(err);
    return { oraclePassed: 0, oracleTotal: total, oracleFailures: ['oracle could not run against impl'], error: String(msg).split('\n').slice(0, 3).join(' ') };
  } finally {
    fs.rmSync(oracleDst, { force: true });
  }
}

/** Counts the `['<name>', () =>` entries in the oracle source. The count is the denominator when the oracle cannot run. */
export function countOracleChecks(oraclePath: string): number {
  const src = fs.readFileSync(oraclePath, 'utf-8');
  const m = src.match(/\[\s*'[^']+',\s*\(\)\s*=>/g);
  return m ? m.length : 0;
}

/**
 * Type-checks `impl.ts` with strict `tsc`. The target and the lib are `es2022`, as in the repo.
 * A bare `tsc` uses an ES5 lib and rejects valid modern TypeScript, such as private fields and sticky regular expressions.
 */
export async function gradeTypecheck(runDir: string): Promise<boolean> {
  try {
    await execFileAsync(
      TSC,
      ['--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--lib', 'es2022', 'impl.ts'],
      { cwd: runDir },
    );
    return true;
  } catch {
    return false;
  }
}

/** True when `f` is a test file of the run. The impl, the oracle and the spec are not test files. */
function isTestFile(f: string): boolean {
  return f !== 'oracle.ts' && f !== 'impl.ts' && f !== 'SPEC.md' && /\.(test|spec)\.[tj]s$|(^|[^a-z])test[^a-z]/i.test(f);
}

export function detectTests(runDir: string): boolean {
  return fs.readdirSync(runDir).some(isTestFile);
}

/** The test files in the run directory, in sorted order. */
export function listTestFiles(runDir: string): string[] {
  return fs.readdirSync(runDir).filter(isTestFile).sort();
}

/** The git executor for the throwaway repo. It is total: a non-zero exit is a value, never a throw. */
export const evalGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout, exitCode: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    const out =
      (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf-8') ?? '') +
      (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '');
    return { stdout: out, exitCode: e.status ?? 1 };
  }
};

/** The asynchronous twin of {@link evalGitExec}, for the setup steps that run before the probe. */
async function evalGitAsync(repoRoot: string, args: readonly string[]): Promise<{ stdout: string; exitCode: number }> {
  const result = await spawnAsync('git', args, { cwd: repoRoot, timeout: 30_000 });
  if (result.status === 0 && result.error === undefined) return { stdout: result.stdout, exitCode: 0 };
  return { stdout: result.stdout + result.stderr, exitCode: result.status ?? 1 };
}

/**
 * Builds the test runner of the probe. The runner starts each test file of the run with `tsx` in the throwaway repo.
 * A test file is a `node:assert` script that exits non-zero on a failure. The run passes only when every file exits 0.
 */
export function makeEvalRunTests(tsx: string = TSX): TestRunFn {
  return async ({ repoRoot, testFiles }) => {
    for (const tf of testFiles) {
      try {
        await execFileAsync(tsx, [tf], { cwd: repoRoot, timeout: 120_000 });
      } catch {
        return { passed: false };
      }
    }
    return { passed: true };
  };
}

/** The injectable probe seam. The default is the production {@link runProbe}. */
export type ProbeFn = (args: Parameters<typeof runProbe>[0]) => Promise<ProbeResult>;

export interface GradeAdequacyOptions {
  readonly tasksDir: string;
  readonly tsx?: string;
  /**
   * The probe to run. The default is the production `runProbe`, so the real gate measures the score.
   * Only a characterization test injects a probe, to fix the adequacy value and keep the test fast.
   */
  readonly probe?: ProbeFn;
}

/**
 * Measures the test adequacy of a run with the diff-scoped kill probe.
 * A failed setup step or a failed probe gives `score: null` and an `error`, not a throw.
 * A run with no tests gives `no-new-tests` and no score. A revert conflict or a failed restore also gives no score.
 *
 * The probe needs a diff, so the function builds a throwaway git repo for each run and always removes it.
 * The base commit holds the task stub as `impl.ts`. The working tree holds the impl and the tests of the run.
 * Thus the diff is exactly the change from the stub to the impl, and the probe reverts those hunks.
 * The commit takes its identity and `commit.gpgsign=false` from `-c` flags, so it needs no global git config.
 * `testGlobs` holds the exact test file names, because the default globs do not match a bare `test.ts`.
 */
export async function gradeAdequacy(
  runDir: string,
  task: string,
  options: GradeAdequacyOptions,
): Promise<AdequacyResult> {
  const stubPath = path.join(options.tasksDir, task, 'impl.stub.ts');
  const implPath = path.join(runDir, 'impl.ts');
  if (!fs.existsSync(stubPath)) {
    return { probed: false, redObserved: false, score: null, discriminant: 'no-stub', error: `no stub at ${stubPath}` };
  }
  if (!fs.existsSync(implPath)) {
    return { probed: false, redObserved: false, score: null, discriminant: 'no-impl', error: `no impl at ${implPath}` };
  }

  const testFiles = listTestFiles(runDir);
  if (testFiles.length === 0) {
    return { probed: false, redObserved: false, score: null, discriminant: 'no-new-tests' };
  }

  const stubSrc = fs.readFileSync(stubPath, 'utf-8');
  const implSrc = fs.readFileSync(implPath, 'utf-8');
  const probeFn = options.probe ?? runProbe;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-adequacy-'));
  try {
    await evalGitAsync(tmp, ['init', '-q']);
    fs.writeFileSync(path.join(tmp, 'impl.ts'), stubSrc);
    await evalGitAsync(tmp, ['add', 'impl.ts']);
    const commit = await evalGitAsync(tmp, [
      '-c', 'user.email=eval@exarchos.local',
      '-c', 'user.name=exarchos-eval',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'base: task stub',
    ]);
    if (commit.exitCode !== 0) {
      return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: `git commit failed: ${commit.stdout.trim().slice(0, 200)}` };
    }
    const head = await evalGitAsync(tmp, ['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: `git rev-parse failed: ${head.stdout.trim().slice(0, 200)}` };
    }
    const baseRef = head.stdout.trim();

    fs.writeFileSync(path.join(tmp, 'impl.ts'), implSrc);
    for (const tf of testFiles) {
      fs.copyFileSync(path.join(runDir, tf), path.join(tmp, tf));
    }

    const probe = await probeFn({
      gitExec: evalGitExec,
      repoRoot: tmp,
      baseRef,
      changedFiles: ['impl.ts', ...testFiles],
      runTests: makeEvalRunTests(options.tsx ?? TSX),
      testGlobs: testFiles,
    });

    if (probe.discriminant === 'no-new-tests') {
      return { probed: false, redObserved: false, score: null, discriminant: 'no-new-tests' };
    }
    if (probe.discriminant === 'revert-conflict' || probe.discriminant === 'restore-failed') {
      return { probed: false, redObserved: probe.redObserved, score: null, discriminant: probe.discriminant, error: `probe ${probe.discriminant}` };
    }
    return { probed: true, redObserved: probe.redObserved, score: probe.redObserved ? 1 : 0, ...(probe.discriminant ? { discriminant: probe.discriminant } : {}) };
  } catch (err) {
    return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmrf(tmp);
  }
}

export interface GradeRunOptions {
  readonly tasksDir: string;
  readonly tsx?: string;
  readonly probe?: ProbeFn;
}

/**
 * Grades one run directory: oracle, typecheck, `wroteTests` and adequacy.
 * It throws when the directory name has fewer than three parts between `__` separators, because a mislabeled row still enters the averages.
 */
export async function gradeRun(baseDir: string, run: string, options: GradeRunOptions): Promise<RunResult> {
  const runDir = path.join(baseDir, run);
  const [task, arm, repRaw] = run.split('__');
  if (task === undefined || arm === undefined || repRaw === undefined) {
    throw new Error(`Malformed run directory name (want <task>__<arm>__r<rep>): ${run}`);
  }
  const rep = repRaw.replace(/^r/, '');
  const oracle = await gradeOracle(runDir, task, options.tasksDir);
  const adequacy = await gradeAdequacy(runDir, task, {
    tasksDir: options.tasksDir,
    ...(options.tsx ? { tsx: options.tsx } : {}),
    ...(options.probe ? { probe: options.probe } : {}),
  });
  return {
    run,
    task,
    arm,
    rep,
    ...oracle,
    typecheckOk: await gradeTypecheck(runDir),
    wroteTests: detectTests(runDir),
    adequacyProbed: adequacy.probed,
    adequacyRedObserved: adequacy.redObserved,
    adequacyScore: adequacy.score,
    ...(adequacy.discriminant ? { adequacyDiscriminant: adequacy.discriminant } : {}),
    ...(oracle.error ? {} : adequacy.error ? { error: adequacy.error } : {}),
  };
}

export interface Agg {
  runs: number;
  oracleRate: number;
  typecheckOk: number;
  wroteTests: number;
  /** The count of runs with a measured score, which is an `adequacyScore` that is not `null`. */
  adequacyProbedRuns: number;
  /** The sum of the measured scores. */
  adequacyScoreSum: number;
}

export interface GradeReport {
  results: RunResult[];
  agg: Record<string, Agg>;
  markdown: string;
}

/** Finds the run directories under `baseDir`. A name must end in `__E__r<rep>` or `__N__r<rep>`. */
export function discoverRunDirs(baseDir: string): string[] {
  return fs
    .readdirSync(baseDir)
    .filter((d) => /__[EN]__r\d+$/.test(d) && fs.statSync(path.join(baseDir, d)).isDirectory());
}

/** The report cell for the adequacy verdict of a run. */
function adequacyCell(r: RunResult): string {
  if (r.adequacyScore === 1) return '✓ killed';
  if (r.adequacyScore === 0) return '✗ survived';
  return r.adequacyDiscriminant === 'no-new-tests' ? '— no tests' : `— ${r.adequacyDiscriminant ?? 'n/a'}`;
}

/** Grades every run under `baseDir`, aggregates the results by task and arm, and renders the report. */
export async function gradeAll(
  baseDir: string,
  tasksDir: string,
  options?: { tsx?: string; probe?: ProbeFn },
): Promise<GradeReport> {
  const runDirs = discoverRunDirs(baseDir);
  const results: RunResult[] = [];
  for (const run of runDirs) {
    results.push(
      await gradeRun(baseDir, run, {
        tasksDir,
        ...(options?.tsx ? { tsx: options.tsx } : {}),
        ...(options?.probe ? { probe: options.probe } : {}),
      }),
    );
  }
  results.sort((a, b) => a.run.localeCompare(b.run));

  const agg: Record<string, Agg> = {};
  for (const r of results) {
    const key = `${r.task}::${r.arm}`;
    const a = (agg[key] ??= { runs: 0, oracleRate: 0, typecheckOk: 0, wroteTests: 0, adequacyProbedRuns: 0, adequacyScoreSum: 0 });
    a.runs++;
    a.oracleRate += r.oracleTotal > 0 ? r.oraclePassed / r.oracleTotal : 0;
    a.typecheckOk += r.typecheckOk ? 1 : 0;
    a.wroteTests += r.wroteTests ? 1 : 0;
    if (r.adequacyScore !== null) {
      a.adequacyProbedRuns++;
      a.adequacyScoreSum += r.adequacyScore;
    }
  }

  const lines: string[] = [];
  lines.push('# Quality A/B — pilot results (#1636 Phase 2)');
  lines.push('');
  lines.push('Same task, same env, same model. The only variable is the verification regime: **E** = the production `renderImplementerPrompt` tier-selected verification note; **N** = none (bare "implement it"). `impl.ts` graded against a HIDDEN oracle the agent never saw, plus strict `tsc`.');
  lines.push('');
  lines.push('The **adequacy** column is measured MECHANICALLY (#1670, DR-4/DR-7): the repo\'s diff-scoped `check_test_adequacy` kill-probe is run over a throwaway git repo whose base commit is the task stub and whose working tree is the produced impl + tests. "killed" = a test went red when the impl was reverted to the stub (non-vacuous); "survived" = the suite stayed green (vacuous). No score is self-reported.');
  lines.push('');
  lines.push('> ⚠️ **PROVISIONAL — does not run exarchos end-to-end (#1670).** The verification note was pasted into a generic subagent; the exarchos binary/pipeline was never executed, and all tasks are fully specified (so both arms tie at 100% on the ORACLE by implementing-to-spec). The adequacy column IS now mechanically measured; the executed end-to-end test + under-specified tasks live in #1670.');
  lines.push('');
  lines.push('## Per-run');
  lines.push('');
  lines.push('| run | oracle | typecheck | wrote tests | adequacy | key failures |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of results) {
    const rate = `${r.oraclePassed}/${r.oracleTotal}`;
    const fails = r.oracleFailures.slice(0, 2).join('; ').slice(0, 80);
    lines.push(`| ${r.run} | ${rate} | ${r.typecheckOk ? '✓' : '✗'} | ${r.wroteTests ? '✓' : '✗'} | ${adequacyCell(r)} | ${fails} |`);
  }
  lines.push('');
  lines.push('## Aggregate (task × arm)');
  lines.push('');
  lines.push('| task | arm | runs | mean oracle pass rate | typecheck ok | wrote tests | adequacy (killed/probed) |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [key, a] of Object.entries(agg).sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))) {
    const [task, arm] = key.split('::');
    const adq = a.adequacyProbedRuns > 0 ? `${a.adequacyScoreSum}/${a.adequacyProbedRuns} (${((a.adequacyScoreSum / a.adequacyProbedRuns) * 100).toFixed(0)}%)` : '— none probed';
    lines.push(`| ${task} | ${arm} | ${a.runs} | ${((a.oracleRate / a.runs) * 100).toFixed(0)}% | ${a.typecheckOk}/${a.runs} | ${a.wroteTests}/${a.runs} | ${adq} |`);
  }
  lines.push('');

  return { results, agg, markdown: lines.join('\n') };
}

async function main(): Promise<void> {
  const baseDir = process.argv[2];
  const tasksDir = process.argv[3] ?? path.join(__dirname, 'tasks');
  if (!baseDir) {
    console.error('usage: tsx grade.ts <baseRunsDir> [tasksDir]');
    process.exit(2);
  }

  const { results, agg, markdown } = await gradeAll(baseDir, tasksDir);

  const outMd = path.join(__dirname, 'RESULTS.md');
  const outJson = path.join(__dirname, 'results.json');
  fs.writeFileSync(outMd, markdown);
  fs.writeFileSync(outJson, JSON.stringify({ results, agg }, null, 2));
  process.stdout.write(markdown + '\n');
  process.stdout.write(`\n[written] ${path.relative(REPO_ROOT, outMd)}\n[written] ${path.relative(REPO_ROOT, outJson)}\n`);
}

/** The URL of the invoked script. `main` runs only when that script is this module, so an import by a test never calls `process.exit`. */
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
