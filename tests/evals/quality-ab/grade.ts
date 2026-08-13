// ─── Quality A/B grader (#1636 Phase 2 · #1670 mechanical adequacy) ───────────
//
// Grades each produced `impl.ts` against its task's HIDDEN oracle + strict tsc,
// and MECHANICALLY measures test adequacy with the repo's own diff-scoped
// kill-probe (mutation-testing-at-N=1). Runs are directories named
// `<task>__<arm>__r<rep>` under the base dir; each holds the arm's final
// `impl.ts` (and, for arms that wrote them, its test files). The oracle is
// copied in ONLY at grade time (the agent never saw it).
//
// Metrics per run:
//   - oraclePassRate  — fraction of hidden edge-case checks the impl passes
//                       (correctness / spec-conformance)
//   - typecheckOk     — `tsc --noEmit --strict` clean on impl.ts (errors)
//   - wroteTests      — did the agent leave its own test file? (behavioral)
//   - adequacyScore   — DR-4/DR-7: MECHANICALLY measured, never self-reported.
//                       The repo's `check_test_adequacy` kill-probe is run over
//                       a throwaway git repo whose BASE commit is the task stub
//                       and whose working tree is the produced impl + its tests,
//                       so the diff-scope is exactly stub→impl. The probe reverts
//                       the impl SOURCE hunks to the stub, re-runs the produced
//                       tests, and reports whether at least one went red. A test
//                       suite that goes red on the revert is non-vacuous (score
//                       1 / "killed"); one that stays green asserted nothing
//                       about the change (score 0 / "survived"). This reuses the
//                       production gate (`runProbe`) verbatim — no hand-rolled
//                       mutation engine — so the adequacy figure is measured, not
//                       claimed (DR-7 fail-honest).
//
// Run: tsx tests/evals/quality-ab/grade.ts <baseRunsDir> [tasksDir]
//
// ⚠️ ORACLE ISOLATION (eval integrity). The hidden oracles under `tasks/*/oracle.ts`
// are the answer key. They are committed for GRADE-TIME reproducibility only — an
// agent under test MUST run in a workspace that does NOT contain them, or it can
// read the answers. This harness enforces that by construction: run dirs are seeded
// with ONLY `SPEC.md` + the `impl.ts` stub, and the oracle is copied in (and removed
// again) here at grade time. NEVER dispatch an agent from the repo checkout or any
// dir that includes `tasks/*/oracle.ts`. CI-only / out-of-repo oracle storage is the
// durable hardening — tracked in #1670.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reuse the production diff-scoped kill-probe (check_test_adequacy). `runProbe`
// only type-imports `GitExec`, so importing it pulls in NO MCP runtime deps
// (no event store, no SQLite) — the grader stays a lightweight tsx script.
import {
  runProbe,
  type ProbeResult,
  type TestRunFn,
} from '../../../src/verbs/gates/test-adequacy.js';
import type { GitExec } from '../../../src/verbs/pure/execute-merge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../../');
export const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
export const TSC = path.join(REPO_ROOT, 'node_modules/.bin/tsc');

// ─── Result shapes ────────────────────────────────────────────────────────────

/**
 * Mechanically-measured adequacy of a run's own tests (DR-4/DR-7).
 *
 * `score` is `null` when the probe could not measure a suite (no tests written,
 * or the probe degraded to a revert/restore conflict) — never a fabricated 0/1.
 * When measured: `1` = the tests are non-vacuous (a test went red on the
 * source-revert / "killed"), `0` = vacuous (stayed green / "survived").
 */
export interface AdequacyResult {
  /** True when the probe actually ran a suite (tests existed and it measured them). */
  readonly probed: boolean;
  /** True when reverting the impl to the stub made at least one test go red. */
  readonly redObserved: boolean;
  /** 1 (killed) / 0 (survived) when measured; null when unmeasurable. */
  readonly score: number | null;
  /** Probe discriminant when non-nominal (`no-new-tests`, `revert-conflict`, …). */
  readonly discriminant?: string;
  /** Set when the probe could not be run at all (surfaced, never swallowed). */
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
  // ── #1670: mechanical adequacy (additive; existing cells above unchanged) ──
  adequacyProbed: boolean;
  adequacyRedObserved: boolean;
  adequacyScore: number | null;
  adequacyDiscriminant?: string;
  error?: string;
}

// ─── Oracle (unchanged behavior) ──────────────────────────────────────────────

export function gradeOracle(
  runDir: string,
  task: string,
  tasksDir: string,
): Pick<RunResult, 'oraclePassed' | 'oracleTotal' | 'oracleFailures' | 'error'> {
  const oracleSrc = path.join(tasksDir, task, 'oracle.ts');
  const oracleDst = path.join(runDir, 'oracle.ts');
  fs.copyFileSync(oracleSrc, oracleDst);
  try {
    const out = execFileSync(TSX, ['oracle.ts'], { cwd: runDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const line = out.trim().split('\n').filter(Boolean).pop() ?? '{}';
    const parsed = JSON.parse(line) as { passed: number; total: number; failures: string[] };
    return { oraclePassed: parsed.passed, oracleTotal: parsed.total, oracleFailures: parsed.failures };
  } catch (err) {
    // Oracle crashed (missing export, runtime throw, syntax error) → 0 correct.
    const total = countOracleChecks(oracleSrc);
    const msg = err instanceof Error ? (err as Error & { stderr?: string }).stderr ?? err.message : String(err);
    return { oraclePassed: 0, oracleTotal: total, oracleFailures: ['oracle could not run against impl'], error: String(msg).split('\n').slice(0, 3).join(' ') };
  } finally {
    // Don't leave the hidden oracle behind in the run dir.
    fs.rmSync(oracleDst, { force: true });
  }
}

export function countOracleChecks(oraclePath: string): number {
  // Best-effort count of `['...', () => ...]` entries for a denominator when the
  // oracle can't run at all.
  const src = fs.readFileSync(oraclePath, 'utf-8');
  const m = src.match(/\[\s*'[^']+',\s*\(\)\s*=>/g);
  return m ? m.length : 0;
}

export function gradeTypecheck(runDir: string): boolean {
  try {
    // Realistic target/lib (es2022) matching the repo — a bare `tsc` defaults to
    // an ES5 lib and rejects modern-but-valid TS (private fields, sticky regex,
    // etc.), which would be a grader artifact rather than an impl defect.
    execFileSync(
      TSC,
      ['--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--lib', 'es2022', 'impl.ts'],
      { cwd: runDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}

/** True when `f` is one of the run's own test files (not impl/oracle/SPEC). */
function isTestFile(f: string): boolean {
  return f !== 'oracle.ts' && f !== 'impl.ts' && f !== 'SPEC.md' && /\.(test|spec)\.[tj]s$|(^|[^a-z])test[^a-z]/i.test(f);
}

export function detectTests(runDir: string): boolean {
  return fs.readdirSync(runDir).some(isTestFile);
}

/** The run's own test files (co-located `test.ts` / `*.test.ts` / `*.spec.ts`). */
export function listTestFiles(runDir: string): string[] {
  return fs.readdirSync(runDir).filter(isTestFile).sort();
}

// ─── Mechanical adequacy (DR-4/DR-7) ──────────────────────────────────────────

/**
 * Real git executor for the throwaway repo (mirrors the production `defaultGitExec`
 * contract: total — a non-zero exit is a value, never a throw).
 */
export const evalGitExec: GitExec = (repoRoot, args) => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: repoRoot,
      timeout: 30_000,
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

/**
 * Build the probe's test runner: run each produced test file via `tsx` in the
 * throwaway repo. A produced test is a module-load harness (`node:assert`) that
 * exits non-zero on failure, so a thrown/failed run is the "red" the kill-probe
 * looks for. PASS iff every test file exits 0.
 */
export function makeEvalRunTests(tsx: string = TSX): TestRunFn {
  return async ({ repoRoot, testFiles }) => {
    for (const tf of testFiles) {
      try {
        execFileSync(tsx, [tf], { cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 120_000 });
      } catch {
        return { passed: false };
      }
    }
    return { passed: true };
  };
}

/** Injectable probe seam (DI). Defaults to the real production {@link runProbe}. */
export type ProbeFn = (args: Parameters<typeof runProbe>[0]) => Promise<ProbeResult>;

export interface GradeAdequacyOptions {
  readonly tasksDir: string;
  readonly tsx?: string;
  /**
   * Probe seam. Defaults to the REAL `runProbe` (production kill-probe) — DR-7
   * fail-honest: the score is measured by the actual gate, never self-reported.
   * Injected only in characterization tests that fix the adequacy value to keep
   * the existing-metrics assertion fast and deterministic.
   */
  readonly probe?: ProbeFn;
}

/**
 * Mechanically measure a run's test adequacy with the diff-scoped kill-probe.
 *
 * Throwaway-repo diff base (the tricky part): the gate needs a diff scope + a
 * worktree. We synthesize one per run — `git init` a temp repo, commit the task
 * STUB as `impl.ts` (the base commit), then place the produced impl + its tests
 * as the working tree. The diff-scope is therefore exactly stub→impl: precisely
 * the source hunks the probe must find covered. The probe reverts those hunks
 * back to the stub, re-runs the tests, and reports red/green. The temp repo is
 * always torn down (finally).
 *
 * Never throws: any setup/probe failure degrades to `{ score: null, error }`.
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
    // No tests to probe — the ladder treats this as an advisory skip, not vacuous.
    return { probed: false, redObserved: false, score: null, discriminant: 'no-new-tests' };
  }

  const stubSrc = fs.readFileSync(stubPath, 'utf-8');
  const implSrc = fs.readFileSync(implPath, 'utf-8');
  const probeFn = options.probe ?? runProbe;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-adequacy-'));
  try {
    // 1. `git init` + a throwaway identity (robust to a missing global config;
    //    `-c` flags avoid a second config round-trip and any gpg-sign prompt).
    evalGitExec(tmp, ['init', '-q']);
    // 2. BASE commit = the task stub, written as `impl.ts`.
    fs.writeFileSync(path.join(tmp, 'impl.ts'), stubSrc);
    evalGitExec(tmp, ['add', 'impl.ts']);
    const commit = evalGitExec(tmp, [
      '-c', 'user.email=eval@exarchos.local',
      '-c', 'user.name=exarchos-eval',
      '-c', 'commit.gpgsign=false',
      'commit', '-q', '-m', 'base: task stub',
    ]);
    if (commit.exitCode !== 0) {
      return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: `git commit failed: ${commit.stdout.trim().slice(0, 200)}` };
    }
    const head = evalGitExec(tmp, ['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: `git rev-parse failed: ${head.stdout.trim().slice(0, 200)}` };
    }
    const baseRef = head.stdout.trim();

    // 3. Working tree = produced impl + its tests (diff-scope = stub→impl).
    fs.writeFileSync(path.join(tmp, 'impl.ts'), implSrc);
    for (const tf of testFiles) {
      fs.copyFileSync(path.join(runDir, tf), path.join(tmp, tf));
    }

    // 4. Run the production kill-probe over the synthesized diff. `testGlobs` are
    //    the exact produced test-file names so a `test.ts` (which the default
    //    co-located globs would miss) is still classified as a test, and `impl.ts`
    //    stays classified as the source to revert.
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
      // The probe could not measure cleanly — do NOT fabricate a 0/1 score.
      return { probed: false, redObserved: probe.redObserved, score: null, discriminant: probe.discriminant, error: `probe ${probe.discriminant}` };
    }
    return { probed: true, redObserved: probe.redObserved, score: probe.redObserved ? 1 : 0, ...(probe.discriminant ? { discriminant: probe.discriminant } : {}) };
  } catch (err) {
    return { probed: false, redObserved: false, score: null, discriminant: 'setup-failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ─── Per-run + aggregate ──────────────────────────────────────────────────────

export interface GradeRunOptions {
  readonly tasksDir: string;
  readonly tsx?: string;
  readonly probe?: ProbeFn;
}

/** Grade a single run directory: oracle + typecheck + wroteTests + adequacy. */
export async function gradeRun(baseDir: string, run: string, options: GradeRunOptions): Promise<RunResult> {
  const runDir = path.join(baseDir, run);
  const [task, arm, repRaw] = run.split('__');
  // A run directory is `<task>__<arm>__r<rep>`. Refuse a name that is not,
  // rather than grading with an empty task or arm — a silently mislabelled row
  // is worse than a missing one, because it still gets averaged in.
  if (task === undefined || arm === undefined || repRaw === undefined) {
    throw new Error(`Malformed run directory name (want <task>__<arm>__r<rep>): ${run}`);
  }
  const rep = repRaw.replace(/^r/, '');
  const oracle = gradeOracle(runDir, task, options.tasksDir);
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
    typecheckOk: gradeTypecheck(runDir),
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
  // ── adequacy: mean over PROBED runs (score != null) ──
  adequacyProbedRuns: number;
  adequacyScoreSum: number;
}

export interface GradeReport {
  results: RunResult[];
  agg: Record<string, Agg>;
  markdown: string;
}

/** Discover the run directories under `baseDir` (`<task>__<arm>__r<rep>`). */
export function discoverRunDirs(baseDir: string): string[] {
  return fs
    .readdirSync(baseDir)
    .filter((d) => /__[EN]__r\d+$/.test(d) && fs.statSync(path.join(baseDir, d)).isDirectory());
}

/** Human cell for a run's adequacy verdict. */
function adequacyCell(r: RunResult): string {
  if (r.adequacyScore === 1) return '✓ killed';
  if (r.adequacyScore === 0) return '✗ survived';
  return r.adequacyDiscriminant === 'no-new-tests' ? '— no tests' : `— ${r.adequacyDiscriminant ?? 'n/a'}`;
}

/** Grade every run under `baseDir`, aggregate by task × arm, and render the report. */
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
  // `Object.entries` rather than keys + subscript: the value comes back
  // non-optional, which is what the whole row below reads.
  for (const [key, a] of Object.entries(agg).sort(([l], [r]) => (l < r ? -1 : l > r ? 1 : 0))) {
    const [task, arm] = key.split('::');
    const adq = a.adequacyProbedRuns > 0 ? `${a.adequacyScoreSum}/${a.adequacyProbedRuns} (${((a.adequacyScoreSum / a.adequacyProbedRuns) * 100).toFixed(0)}%)` : '— none probed';
    lines.push(`| ${task} | ${arm} | ${a.runs} | ${((a.oracleRate / a.runs) * 100).toFixed(0)}% | ${a.typecheckOk}/${a.runs} | ${a.wroteTests}/${a.runs} | ${adq} |`);
  }
  lines.push('');

  return { results, agg, markdown: lines.join('\n') };
}

// ─── Script entry point (guarded — import-safe) ───────────────────────────────

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

// Only run the script when invoked directly (`tsx grade.ts …`); importing the
// module (tests) must NOT run main or call process.exit into the vitest worker.
const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
