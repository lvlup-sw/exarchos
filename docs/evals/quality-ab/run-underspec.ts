// ─── Exp 3: under-specified E-vs-N A/B, two models, mechanical grading ────────
// (#1670 · DR-4/DR-7 · task 010)
//
// The provisional full-spec A/B (RESULTS.md / ANALYSIS.md) tied both arms at
// 100% on the oracle: every task FULLY enumerated its edge cases, so a competent
// model implements-to-spec without any verification steer. The steer ("cover the
// edge cases / write tests that can fail") can only have CORRECTNESS value when
// the edge cases must be DISCOVERED — i.e. on UNDER-SPECIFIED tasks. This script
// runs exactly that missing condition:
//
//   arms   : E = the production `buildVerificationNote` (the exarchos implementer
//                verification steer, tier-selected per task);
//            N = no steer. BOTH arms are told to implement AND write a durable
//                test, so the ONLY cross-arm variable is the steer's CONTENT and
//                the contrast is test ADEQUACY (mutation kills), not test PRESENCE.
//                (Corrected from the first run, which asked only E to test.)
//   tasks  : the UNDER-SPEC variants (`SPEC.underspec.md`) for token-bucket,
//            parse-duration, csv-line — edge-case enumeration stripped, HIDDEN
//            oracle unchanged.
//   models : opus + sonnet.
//   metric : per cell — oracle pass rate (hidden oracle), strict tsc, durable
//            tests, and the task-009 MECHANICAL mutation-adequacy score
//            (`gradeAdequacy` runs the real diff-scoped kill-probe — NOT
//            self-reported).
//
// ── DR-7 fail-honest ─────────────────────────────────────────────────────────
// A cell whose model call errors, or that yields no parseable `impl.ts`, is
// recorded `status: 'blocked'` with NULL metrics — never a fabricated number.
// If the headless model cannot be invoked at all, the run is blocked wholesale
// and reported as such. The mutation score is measured by the real kill-probe
// (imported from grade.ts), so it is measured, not claimed.
//
// ── Oracle isolation (eval integrity) ────────────────────────────────────────
// The model is dispatched as a PURE TEXT generator (`claude -p --tools ""`): it
// has NO filesystem/tool access, so it structurally cannot read the hidden
// `tasks/*/oracle.ts` answer key. The spec + stub are the only task context it
// sees, passed inline. The oracle is copied in only at grade time (by grade.ts)
// and removed again.
//
// Run:  tsx docs/evals/quality-ab/run-underspec.ts [reps]
//   env QAB_REPS=<n>          replicates per cell (default 2)
//   env QAB_MODELS=opus,sonnet   models to run (default opus,sonnet)
//   env QAB_SKIP_EXISTING=0   re-dispatch cells that already produced an impl
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  gradeOracle,
  gradeTypecheck,
  detectTests,
  gradeAdequacy,
  REPO_ROOT,
  type ProbeFn,
} from './grade.js';
import { buildVerificationNote } from '../../../servers/exarchos-mcp/src/agents/definitions.js';
import type { RiskTier } from '../../../servers/exarchos-mcp/src/workflow/verification-policy.js';
import { stampProvenance, type Provenance } from '../../../servers/exarchos-mcp/src/evals/provenance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QAB = __dirname; // docs/evals/quality-ab
const TASKS_DIR = path.join(QAB, 'tasks');
// Nest under the existing `runs/` tree so vitest's `docs/**/runs/**` exclude
// covers any agent-authored `*.test.ts` here (their module-load `process.exit`
// harness must never be collected as a project test). The full-spec grader's
// `discoverRunDirs` ignores the `underspec/` subdir (not a `__[EN]__r<n>` name).
const RUNS_DIR = path.join(QAB, 'runs', 'underspec');
const DATA_DIR = path.resolve(REPO_ROOT, 'docs/evals/data/2026-07-09');
const CSV_PATH = path.join(DATA_DIR, 'exp3-underspec-ab.csv');

// ─── Study matrix ─────────────────────────────────────────────────────────────

/** One under-spec task: its risk stamp drives the E-arm verification note. */
export interface TaskSpec {
  readonly name: string;
  readonly riskTier: RiskTier;
  readonly boundaryTouching: boolean;
}

/** Risk stamps mirror each task's `SPEC.underspec.md` header (task 008). */
export const TASKS: readonly TaskSpec[] = [
  { name: 'token-bucket', riskTier: 'high', boundaryTouching: true },
  { name: 'parse-duration', riskTier: 'medium', boundaryTouching: false },
  { name: 'csv-line', riskTier: 'high', boundaryTouching: true },
];

export type Arm = 'E' | 'N';
export const ARMS: readonly Arm[] = ['E', 'N'];

/** Neutral system prompt — IDENTICAL across arms/models so the ONLY cross-arm
 *  variable is the verification note in the E-arm user prompt. Silent about
 *  testing (the test request lives symmetrically in BOTH arms' user prompts, so
 *  it is held constant and never a cross-arm variable). */
export const SYSTEM_PROMPT =
  'You are a senior TypeScript engineer implementing a small, self-contained module. Write correct, production-quality code.';

// ─── Prompt construction ──────────────────────────────────────────────────────

// The `===FILE:name===\n…\n===ENDFILE===` wrapper is shared harness plumbing (how
// the run dir is materialized). BOTH arms are asked to implement AND write a
// durable test — the ONLY cross-arm variable is the verification-steer CONTENT
// (E carries `buildVerificationNote`, N does not). See buildUserPrompt.
const IMPL_BLOCK = [
  '## Output format (STRICT)',
  'Wrap each file EXACTLY like this, with NO prose outside the markers:',
  '===FILE:impl.ts===',
  '<full contents of impl.ts>',
  '===ENDFILE===',
].join('\n');

// Requested from BOTH arms: a durable, runnable test alongside the impl. The
// contract (self-executing, exits non-zero on failure) is what the kill-probe
// grades. Symmetric across arms so "did a test get written" is held constant and
// the measured contrast is test ADEQUACY, not test PRESENCE.
const TEST_CONTRACT = [
  '',
  'Also emit a durable test file the SAME way, named `test.ts`:',
  '===FILE:test.ts===',
  '<full contents of test.ts>',
  '===ENDFILE===',
  "`test.ts` MUST be a self-executing Node script that imports from './impl.ts',",
  'runs via `tsx test.ts`, prints a short pass/fail summary, and exits non-zero',
  '(call `process.exit(1)` or throw) if ANY check fails.',
].join('\n');

/**
 * Build the user prompt for a cell. The spec + stub + the impl/test output
 * contract are IDENTICAL across arms — both are told to implement and to write a
 * durable `test.ts`. The E arm additionally carries the production verification
 * note (the steer, tier-selected from the task's risk stamp); the N arm carries
 * no steer. So the ONLY cross-arm variable is the steer's CONTENT, and the
 * measured contrast is test ADEQUACY (mutation kills) — not test PRESENCE.
 *
 * (Corrected design, #1670 review: the first run asked ONLY the E arm for a test,
 * which confounded "was steered" with "was told to test" and let the durable-test
 * delta be read as the note's persuasion. Holding the test request constant
 * isolates the steer's actual contribution.)
 *
 * Pure — depends only on inputs.
 */
export function buildUserPrompt(task: TaskSpec, arm: Arm, specText: string, stubText: string): string {
  const parts: string[] = [
    'Implement the task below in TypeScript.',
    '',
    '## Task spec',
    specText.trim(),
    '',
    '## Starting stub (impl.ts)',
    '```ts',
    stubText.trim(),
    '```',
    '',
  ];
  if (arm === 'E') {
    // The verbatim production steer, tier-selected from the task's risk stamp.
    parts.push(buildVerificationNote({ riskTier: task.riskTier, boundaryTouching: task.boundaryTouching }));
    parts.push('');
  }
  parts.push(IMPL_BLOCK + TEST_CONTRACT);
  return parts.join('\n');
}

// ─── Model dispatch seam (DI) ─────────────────────────────────────────────────

/** Result of one headless model invocation. */
export interface ModelRunResult {
  readonly ok: boolean;
  /** The model's raw text output (the fenced FILE blocks live here). */
  readonly result: string;
  /** Resolved model id the provider actually served (e.g. `claude-opus-4-8`). */
  readonly modelId: string | null;
  readonly costUsd: number | null;
  readonly error?: string;
}

/** Dispatch a single headless model call. Injected in tests; real impl below. */
export type RunModelFn = (args: {
  readonly prompt: string;
  readonly model: string;
  readonly systemPrompt: string;
}) => ModelRunResult;

/**
 * REAL dispatch: `claude -p` as a pure TEXT generator.
 *   --tools ""            no tool access → cannot read the hidden oracle (isolation)
 *   --system-prompt       neutral prompt (clean A/B, low overhead)
 *   --strict-mcp-config   no MCP servers loaded (no exarchos tools)
 *   --output-format json  capture result text + resolved model id + error status
 * Never throws: a spawn failure / non-zero exit / provider error degrades to
 * `{ ok: false, error }` so the caller records a BLOCKED cell (DR-7).
 */
export const runModelViaClaude: RunModelFn = ({ prompt, model, systemPrompt }) => {
  try {
    const stdout = execFileSync(
      'claude',
      [
        '-p', prompt,
        '--model', model,
        '--system-prompt', systemPrompt,
        '--tools', '',
        '--strict-mcp-config',
        '--output-format', 'json',
      ],
      { cwd: RUNS_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
    );
    const j = JSON.parse(stdout) as {
      is_error?: boolean;
      result?: string;
      total_cost_usd?: number;
      modelUsage?: Record<string, unknown>;
    };
    const modelId = j.modelUsage ? (Object.keys(j.modelUsage)[0] ?? null) : null;
    if (j.is_error) {
      return { ok: false, result: j.result ?? '', modelId, costUsd: j.total_cost_usd ?? null, error: `provider is_error (result: ${(j.result ?? '').slice(0, 200)})` };
    }
    return { ok: true, result: j.result ?? '', modelId, costUsd: j.total_cost_usd ?? null };
  } catch (err) {
    const e = err as Error & { stderr?: string | Buffer; stdout?: string | Buffer };
    const detail = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf-8') ?? '') || e.message;
    return { ok: false, result: '', modelId: null, costUsd: null, error: String(detail).split('\n').slice(0, 3).join(' ').slice(0, 300) };
  }
};

// ─── Output parsing ───────────────────────────────────────────────────────────

const FILE_BLOCK_RE = /===FILE:\s*([^\s=]+)\s*===\r?\n([\s\S]*?)\r?\n?===ENDFILE===/g;

/**
 * Parse the strict `===FILE:name===\n...\n===ENDFILE===` blocks a model emits
 * into a filename→contents map. Tolerant of a stray leading/trailing code fence
 * INSIDE a block (some models wrap the body in ```ts). Pure. Returns an empty
 * map when nothing parses (the caller treats a missing `impl.ts` as blocked).
 */
export function parseProducedFiles(result: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of result.matchAll(FILE_BLOCK_RE)) {
    const name = m[1].trim();
    let body = m[2];
    // Strip a whole-body ```lang … ``` fence if the model wrapped the file.
    const fenced = body.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
    if (fenced) body = fenced[1];
    files.set(name, body.endsWith('\n') ? body : body + '\n');
  }
  return files;
}

// ─── Cell dispatch (produce a run dir) ────────────────────────────────────────

export interface CellId {
  readonly model: string;
  readonly task: TaskSpec;
  readonly arm: Arm;
  readonly rep: number;
}

/** `<task>__<arm>__r<rep>` — compatible with grade.ts's run-name grammar. */
export function runName(task: string, arm: Arm, rep: number): string {
  return `${task}__${arm}__r${rep}`;
}

/** Absolute run dir for a cell: `<base>/<model>/<task>__<arm>__r<rep>`. */
export function cellRunDir(baseRunsDir: string, cell: CellId): string {
  return path.join(baseRunsDir, cell.model, runName(cell.task.name, cell.arm, cell.rep));
}

export interface DispatchOutcome {
  readonly status: 'ok' | 'blocked';
  readonly runDir: string;
  readonly modelId: string | null;
  readonly costUsd: number | null;
  readonly filesWritten: string[];
  readonly error?: string;
}

/**
 * Dispatch one cell: build the arm prompt, call the model, parse the emitted
 * files, and materialize the run dir (`impl.ts` + any `test.ts`). Blocked (never
 * fabricated) when the call errors or no `impl.ts` is produced.
 */
export function dispatchCell(
  baseRunsDir: string,
  cell: CellId,
  deps: { readonly runModel: RunModelFn; readonly tasksDir: string; readonly skipExisting?: boolean },
): DispatchOutcome {
  const runDir = cellRunDir(baseRunsDir, cell);
  const implPath = path.join(runDir, 'impl.ts');
  if (deps.skipExisting !== false && fs.existsSync(implPath) && fs.readFileSync(implPath, 'utf-8').trim().length > 0) {
    // Resume: a prior run already produced this cell — do not re-spend.
    const existing = fs.readdirSync(runDir).filter((f) => f !== 'oracle.ts');
    return { status: 'ok', runDir, modelId: null, costUsd: null, filesWritten: existing };
  }

  const specText = fs.readFileSync(path.join(deps.tasksDir, cell.task.name, 'SPEC.underspec.md'), 'utf-8');
  const stubText = fs.readFileSync(path.join(deps.tasksDir, cell.task.name, 'impl.stub.ts'), 'utf-8');
  const prompt = buildUserPrompt(cell.task, cell.arm, specText, stubText);

  const res = deps.runModel({ prompt, model: cell.model, systemPrompt: SYSTEM_PROMPT });
  if (!res.ok) {
    return { status: 'blocked', runDir, modelId: res.modelId, costUsd: res.costUsd, filesWritten: [], error: res.error ?? 'model call failed' };
  }
  const files = parseProducedFiles(res.result);
  const impl = files.get('impl.ts');
  if (!impl || impl.trim().length === 0) {
    return { status: 'blocked', runDir, modelId: res.modelId, costUsd: res.costUsd, filesWritten: [], error: 'no parseable impl.ts in model output' };
  }

  fs.mkdirSync(runDir, { recursive: true });
  const written: string[] = [];
  for (const [name, body] of files) {
    // Only materialize impl.ts + test files; ignore any stray blocks.
    if (name === 'impl.ts' || /\.(test|spec)\.[tj]s$|^test\.ts$/.test(name)) {
      fs.writeFileSync(path.join(runDir, name), body);
      written.push(name);
    }
  }
  return { status: 'ok', runDir, modelId: res.modelId, costUsd: res.costUsd, filesWritten: written.sort() };
}

// ─── Cell capture (grade the produced run dir) ────────────────────────────────

export interface CellRow {
  readonly model: string;
  readonly modelId: string;
  readonly task: string;
  readonly arm: Arm;
  readonly rep: number;
  readonly status: 'ok' | 'blocked';
  readonly oraclePassed: number | null;
  readonly oracleTotal: number | null;
  readonly oracleRate: number | null;
  readonly typecheckOk: boolean | null;
  readonly wroteTests: boolean | null;
  readonly adequacyProbed: boolean | null;
  readonly adequacyScore: number | null;
  readonly adequacyDiscriminant: string;
  readonly costUsd: number | null;
  readonly note: string;
}

/**
 * Grade a produced run dir: hidden-oracle pass rate + strict tsc + durable-tests
 * + the MECHANICAL mutation-adequacy score (real kill-probe via `gradeAdequacy`).
 * A blocked dispatch is passed through as a blocked row with NULL metrics.
 */
export async function captureCell(
  baseRunsDir: string,
  cell: CellId,
  dispatch: DispatchOutcome,
  deps: { readonly tasksDir: string; readonly probe?: ProbeFn },
): Promise<CellRow> {
  const base = {
    model: cell.model,
    modelId: dispatch.modelId ?? cell.model,
    task: cell.task.name,
    arm: cell.arm,
    rep: cell.rep,
    costUsd: dispatch.costUsd,
  };
  if (dispatch.status === 'blocked') {
    return {
      ...base,
      status: 'blocked',
      oraclePassed: null, oracleTotal: null, oracleRate: null,
      typecheckOk: null, wroteTests: null,
      adequacyProbed: null, adequacyScore: null, adequacyDiscriminant: 'blocked',
      note: dispatch.error ?? 'blocked',
    };
  }

  const runDir = dispatch.runDir;
  const oracle = gradeOracle(runDir, cell.task.name, deps.tasksDir);
  const typecheckOk = gradeTypecheck(runDir);
  const wroteTests = detectTests(runDir);
  const adequacy = await gradeAdequacy(runDir, cell.task.name, {
    tasksDir: deps.tasksDir,
    ...(deps.probe ? { probe: deps.probe } : {}),
  });
  const oracleRate = oracle.oracleTotal > 0 ? oracle.oraclePassed / oracle.oracleTotal : 0;
  return {
    ...base,
    status: 'ok',
    oraclePassed: oracle.oraclePassed,
    oracleTotal: oracle.oracleTotal,
    oracleRate,
    typecheckOk,
    wroteTests,
    adequacyProbed: adequacy.probed,
    adequacyScore: adequacy.score,
    adequacyDiscriminant: adequacy.discriminant ?? (adequacy.probed ? 'probed' : 'unmeasured'),
    note: oracle.error ? `oracle: ${oracle.error}` : '',
  };
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

const CSV_COLUMNS = [
  'model', 'modelId', 'task', 'arm', 'rep', 'status',
  'oraclePassed', 'oracleTotal', 'oracleRate',
  'typecheckOk', 'wroteTests', 'adequacyProbed', 'adequacyScore', 'adequacyDiscriminant',
  'costUsd', 'source', 'binaryTag', 'gitSha', 'date', 'modelIds', 'note',
] as const;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialize graded rows to CSV, stamping the task-001 provenance shape onto each
 * row (`stampProvenance` — throws if provenance is incomplete). `source` is
 * `measured`: every number is produced by a real model call + the real grader;
 * a blocked cell carries `status=blocked` with EMPTY metric cells, never a
 * fabricated value (DR-7). Pure.
 */
export function buildCsv(rows: readonly CellRow[], provenance: Provenance): string {
  const modelIdsJoined = provenance.modelIds.join('|');
  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const stamped = stampProvenance({ ...r, source: 'measured' as const }, provenance);
    const record: Record<string, unknown> = {
      ...stamped,
      oracleRate: r.oracleRate === null ? null : Number(r.oracleRate.toFixed(4)),
      binaryTag: provenance.binaryTag,
      gitSha: provenance.gitSha,
      date: provenance.date,
      modelIds: modelIdsJoined,
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(record[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

// ─── Report ───────────────────────────────────────────────────────────────────

/** Mean-over-ok-cells summary per model×task×arm (for the console table). */
export interface CellAgg {
  readonly key: string;
  readonly runs: number;
  readonly okRuns: number;
  readonly blocked: number;
  readonly oracleMeanPct: number | null;
  readonly typecheckOk: number;
  readonly wroteTests: number;
  readonly adequacyProbed: number;
  readonly adequacyKilled: number;
}

export function aggregate(rows: readonly CellRow[]): CellAgg[] {
  const groups = new Map<string, CellRow[]>();
  for (const r of rows) {
    const key = `${r.model}::${r.task}::${r.arm}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const out: CellAgg[] = [];
  for (const [key, rs] of [...groups.entries()].sort()) {
    const ok = rs.filter((r) => r.status === 'ok');
    const oracleVals = ok.map((r) => r.oracleRate).filter((v): v is number => v !== null);
    out.push({
      key,
      runs: rs.length,
      okRuns: ok.length,
      blocked: rs.length - ok.length,
      oracleMeanPct: oracleVals.length ? (oracleVals.reduce((a, b) => a + b, 0) / oracleVals.length) * 100 : null,
      typecheckOk: ok.filter((r) => r.typecheckOk === true).length,
      wroteTests: ok.filter((r) => r.wroteTests === true).length,
      adequacyProbed: ok.filter((r) => r.adequacyProbed === true).length,
      adequacyKilled: ok.filter((r) => r.adequacyScore === 1).length,
    });
  }
  return out;
}

export function renderReport(rows: readonly CellRow[]): string {
  const agg = aggregate(rows);
  const lines: string[] = [];
  lines.push('## Exp 3 — under-spec E-vs-N (per model × task × arm)');
  lines.push('');
  lines.push('| model | task | arm | runs | blocked | mean oracle | tsc ok | wrote tests | adequacy killed/probed |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of agg) {
    const [model, task, arm] = a.key.split('::');
    const oracle = a.oracleMeanPct === null ? '—' : `${a.oracleMeanPct.toFixed(0)}%`;
    lines.push(
      `| ${model} | ${task} | ${arm} | ${a.okRuns}/${a.runs} | ${a.blocked} | ${oracle} | ${a.typecheckOk}/${a.okRuns} | ${a.wroteTests}/${a.okRuns} | ${a.adequacyKilled}/${a.adequacyProbed} |`,
    );
  }
  return lines.join('\n');
}

// ─── Script entry point (guarded — import-safe) ───────────────────────────────

function gitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function binaryTag(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version?: string };
    return pkg.version ? `v${pkg.version}` : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const reps = Number(process.argv[2] ?? process.env.QAB_REPS ?? 2);
  const models = (process.env.QAB_MODELS ?? 'opus,sonnet').split(',').map((m) => m.trim()).filter(Boolean);
  const skipExisting = process.env.QAB_SKIP_EXISTING !== '0';
  const taskFilter = (process.env.QAB_TASKS ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const tasks = taskFilter.length ? TASKS.filter((t) => taskFilter.includes(t.name)) : TASKS;
  fs.mkdirSync(RUNS_DIR, { recursive: true });

  const cells: CellId[] = [];
  for (const model of models) {
    for (const task of tasks) {
      for (const arm of ARMS) {
        for (let rep = 1; rep <= reps; rep++) cells.push({ model, task, arm, rep });
      }
    }
  }
  process.stderr.write(`[exp3] ${cells.length} cells (${models.join('+')} × ${tasks.length} tasks × ${ARMS.length} arms × ${reps} reps)\n`);

  const rows: CellRow[] = [];
  const resolvedModelIds = new Set<string>();
  let blocked = 0;
  for (const cell of cells) {
    const label = `${cell.model}/${runName(cell.task.name, cell.arm, cell.rep)}`;
    process.stderr.write(`[exp3] dispatch ${label} … `);
    const dispatch = dispatchCell(RUNS_DIR, cell, { runModel: runModelViaClaude, tasksDir: TASKS_DIR, skipExisting });
    if (dispatch.modelId) resolvedModelIds.add(dispatch.modelId);
    const row = await captureCell(RUNS_DIR, cell, dispatch, { tasksDir: TASKS_DIR });
    rows.push(row);
    if (row.status === 'blocked') {
      blocked++;
      process.stderr.write(`BLOCKED (${row.note})\n`);
    } else {
      process.stderr.write(
        `oracle ${row.oraclePassed}/${row.oracleTotal} tsc=${row.typecheckOk ? 'y' : 'n'} tests=${row.wroteTests ? 'y' : 'n'} adq=${row.adequacyScore ?? '—'}\n`,
      );
    }
  }

  // Provenance: model ids default to the study matrix if nothing resolved (e.g.
  // wholesale-blocked run) so the stamp is always complete/honest.
  const modelIds = resolvedModelIds.size ? [...resolvedModelIds].sort() : models;
  const provenance: Provenance = { binaryTag: binaryTag(), gitSha: gitSha(), modelIds, date: '2026-07-09' };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CSV_PATH, buildCsv(rows, provenance));

  const report = renderReport(rows);
  process.stdout.write(report + '\n\n');
  process.stdout.write(`[exp3] ${rows.length} cells, ${blocked} blocked → ${path.relative(REPO_ROOT, CSV_PATH)}\n`);
  if (blocked === rows.length) {
    process.stderr.write('[exp3] ALL cells blocked — headless model could not be invoked (DR-7: no numbers fabricated)\n');
    process.exit(3);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
