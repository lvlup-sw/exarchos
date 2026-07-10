// ─── Quality A/B grader (#1636 Phase 2) ──────────────────────────────────────
//
// Grades each produced `impl.ts` against its task's HIDDEN oracle + strict tsc.
// Runs are directories named `<task>__<arm>__r<rep>` under the base dir; each
// holds the arm's final `impl.ts`. The oracle is copied in ONLY at grade time
// (the agent never saw it).
//
// Metrics per run:
//   - oraclePassRate  — fraction of hidden edge-case checks the impl passes
//                       (correctness / spec-conformance)
//   - typecheckOk     — `tsc --noEmit --strict` clean on impl.ts (errors)
//   - wroteTests      — did the agent leave its own test file? (behavioral)
//
// Run: tsx docs/evals/quality-ab/grade.ts <baseRunsDir> [tasksDir]
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../');
const TSX = path.join(REPO_ROOT, 'node_modules/.bin/tsx');
const TSC = path.join(REPO_ROOT, 'node_modules/.bin/tsc');

const baseDir = process.argv[2];
const tasksDir = process.argv[3] ?? path.join(__dirname, 'tasks');
if (!baseDir) {
  console.error('usage: tsx grade.ts <baseRunsDir> [tasksDir]');
  process.exit(2);
}

interface RunResult {
  run: string;
  task: string;
  arm: string;
  rep: string;
  oraclePassed: number;
  oracleTotal: number;
  oracleFailures: string[];
  typecheckOk: boolean;
  wroteTests: boolean;
  error?: string;
}

function gradeOracle(runDir: string, task: string): Pick<RunResult, 'oraclePassed' | 'oracleTotal' | 'oracleFailures' | 'error'> {
  const oracleSrc = path.join(tasksDir, task, 'oracle.ts');
  fs.copyFileSync(oracleSrc, path.join(runDir, 'oracle.ts'));
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
  }
}

function countOracleChecks(oraclePath: string): number {
  // Best-effort count of `['...', () => ...]` entries for a denominator when the
  // oracle can't run at all.
  const src = fs.readFileSync(oraclePath, 'utf-8');
  const m = src.match(/\[\s*'[^']+',\s*\(\)\s*=>/g);
  return m ? m.length : 0;
}

function gradeTypecheck(runDir: string): boolean {
  try {
    execFileSync(TSC, ['--noEmit', '--strict', '--skipLibCheck', 'impl.ts'], { cwd: runDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function detectTests(runDir: string): boolean {
  return fs
    .readdirSync(runDir)
    .some((f) => f !== 'oracle.ts' && f !== 'impl.ts' && f !== 'SPEC.md' && /\.(test|spec)\.[tj]s$|(^|[^a-z])test[^a-z]/i.test(f));
}

const runDirs = fs
  .readdirSync(baseDir)
  .filter((d) => /__[EN]__r\d+$/.test(d) && fs.statSync(path.join(baseDir, d)).isDirectory());

const results: RunResult[] = [];
for (const run of runDirs) {
  const runDir = path.join(baseDir, run);
  const [task, arm, repRaw] = run.split('__');
  const rep = repRaw.replace(/^r/, '');
  const oracle = gradeOracle(runDir, task);
  results.push({
    run,
    task,
    arm,
    rep,
    ...oracle,
    typecheckOk: gradeTypecheck(runDir),
    wroteTests: detectTests(runDir),
  });
}

results.sort((a, b) => a.run.localeCompare(b.run));

// Aggregate by task × arm.
type Agg = { runs: number; oracleRate: number; typecheckOk: number; wroteTests: number };
const agg: Record<string, Agg> = {};
for (const r of results) {
  const key = `${r.task}::${r.arm}`;
  const a = (agg[key] ??= { runs: 0, oracleRate: 0, typecheckOk: 0, wroteTests: 0 });
  a.runs++;
  a.oracleRate += r.oracleTotal > 0 ? r.oraclePassed / r.oracleTotal : 0;
  a.typecheckOk += r.typecheckOk ? 1 : 0;
  a.wroteTests += r.wroteTests ? 1 : 0;
}

const lines: string[] = [];
lines.push('# Quality A/B — pilot results (#1636 Phase 2)');
lines.push('');
lines.push('Same task, same env, same model. The only variable is the verification regime: **E** = the production `renderImplementerPrompt` tier-selected verification note; **N** = none (bare "implement it"). `impl.ts` graded against a HIDDEN oracle the agent never saw, plus strict `tsc`.');
lines.push('');
lines.push('## Per-run');
lines.push('');
lines.push('| run | oracle | typecheck | wrote tests | key failures |');
lines.push('|---|---|---|---|---|');
for (const r of results) {
  const rate = `${r.oraclePassed}/${r.oracleTotal}`;
  const fails = r.oracleFailures.slice(0, 2).join('; ').slice(0, 80);
  lines.push(`| ${r.run} | ${rate} | ${r.typecheckOk ? '✓' : '✗'} | ${r.wroteTests ? '✓' : '✗'} | ${fails} |`);
}
lines.push('');
lines.push('## Aggregate (task × arm)');
lines.push('');
lines.push('| task | arm | runs | mean oracle pass rate | typecheck ok | wrote tests |');
lines.push('|---|---|---|---|---|---|');
for (const key of Object.keys(agg).sort()) {
  const [task, arm] = key.split('::');
  const a = agg[key];
  lines.push(`| ${task} | ${arm} | ${a.runs} | ${((a.oracleRate / a.runs) * 100).toFixed(0)}% | ${a.typecheckOk}/${a.runs} | ${a.wroteTests}/${a.runs} |`);
}
lines.push('');

const report = lines.join('\n');
const outMd = path.join(__dirname, 'RESULTS.md');
const outJson = path.join(__dirname, 'results.json');
fs.writeFileSync(outMd, report);
fs.writeFileSync(outJson, JSON.stringify({ results, agg }, null, 2));
process.stdout.write(report + '\n');
process.stdout.write(`\n[written] ${path.relative(REPO_ROOT, outMd)}\n[written] ${path.relative(REPO_ROOT, outJson)}\n`);
