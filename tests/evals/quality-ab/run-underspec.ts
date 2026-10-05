/**
 * Experiment 3 of the quality A/B eval: under-specified tasks, arm E against arm N, two models, graded by `grade.ts`.
 * On the full specs both arms scored 100% on the oracle, because each spec lists every edge case.
 * Each task here uses `SPEC.underspec.md`, which omits the edge-case list. The hidden oracle is the same.
 *
 * Arm E carries the production `buildVerificationNote` for the risk tier of the task. Arm N carries no steer.
 * Both arms must implement the task and write a durable test, so the only variable is the content of the steer.
 * The contrast is test adequacy (the kill-probe result), not the presence of a test.
 *
 * A cell with a failed model call or no parseable `impl.ts` gets `status: 'blocked'` and null metrics, never an invented number.
 * The model runs as a text generator (`claude -p --tools ""`) with no file access, so it cannot read an oracle.
 *
 * Run: `tsx tests/evals/quality-ab/run-underspec.ts [reps]`
 * Environment: `QAB_REPS` (default 2), `QAB_MODELS` (default `opus,sonnet`), `QAB_TASKS` (a task filter).
 * `QAB_SKIP_EXISTING=0` dispatches again each cell that already holds an impl.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  gradeOracle,
  gradeTypecheck,
  detectTests,
  gradeAdequacy,
  REPO_ROOT,
  type ProbeFn,
} from './grade.js';
import { buildVerificationNote } from '../../../src/runtime/agents/definitions.js';
import type { RiskTier } from '../../../src/workflow/verification-policy.js';
import { stampProvenance, type Provenance } from '../../../tools/evals/evals/provenance.js';
import { execFileAsync, spawnAsync } from '../../../tools/test-helpers/spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QAB = __dirname;
const TASKS_DIR = path.join(QAB, 'tasks');
/**
 * The runs of this experiment sit under the `runs` tree, which vitest excludes at any depth.
 * A run can hold a model-written test file that calls `process.exit`, and vitest must never collect it.
 * `discoverRunDirs` in `grade.ts` does not match the directory name `underspec`.
 */
const RUNS_DIR = path.join(QAB, 'runs', 'underspec');
const DATA_DIR = path.resolve(REPO_ROOT, 'tests/evals/data/2026-07-09');
const CSV_PATH = path.join(DATA_DIR, 'exp3-underspec-ab.csv');

/** One under-specified task. Its risk stamp selects the verification note of arm E. */
export interface TaskSpec {
  readonly name: string;
  readonly riskTier: RiskTier;
  readonly boundaryTouching: boolean;
}

/** The tasks of the study. Each risk stamp is the one in the header of the `SPEC.underspec.md` of the task. */
export const TASKS: readonly TaskSpec[] = [
  { name: 'token-bucket', riskTier: 'high', boundaryTouching: true },
  { name: 'parse-duration', riskTier: 'medium', boundaryTouching: false },
  { name: 'csv-line', riskTier: 'high', boundaryTouching: true },
];

export type Arm = 'E' | 'N';
export const ARMS: readonly Arm[] = ['E', 'N'];

/**
 * The system prompt, identical for every arm and model. It does not mention tests.
 * The test request is in the user prompt of both arms, so it is constant across arms.
 */
export const SYSTEM_PROMPT =
  'You are a senior TypeScript engineer implementing a small, self-contained module. Write correct, production-quality code.';

/** The output contract for `impl.ts`. The harness reads the `===FILE:<name>===` and `===ENDFILE===` markers to write the run directory. */
const IMPL_BLOCK = [
  '## Output format (STRICT)',
  'Wrap each file EXACTLY like this, with NO prose outside the markers:',
  '===FILE:impl.ts===',
  '<full contents of impl.ts>',
  '===ENDFILE===',
].join('\n');

/**
 * The request for a durable test, sent to both arms. The test must run by itself and exit non-zero on a failure.
 * The kill probe grades against that contract.
 */
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
 * Builds the user prompt for a cell. The function is pure.
 * The spec, the stub and the output contract are identical across arms.
 * Arm E also carries the production verification note for the risk stamp of the task, verbatim, and arm N carries no steer.
 * If only arm E gets the test request, "has a steer" and "must write a test" are one variable.
 * So both arms get the test request, and the contrast is test adequacy, not the presence of a test.
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
    parts.push(buildVerificationNote({ riskTier: task.riskTier, boundaryTouching: task.boundaryTouching }));
    parts.push('');
  }
  parts.push(IMPL_BLOCK + TEST_CONTRACT);
  return parts.join('\n');
}

/** The result of one headless model call. */
export interface ModelRunResult {
  readonly ok: boolean;
  /** The raw text output of the model, which holds the FILE blocks. */
  readonly result: string;
  /** The model id that the provider served, for example `claude-opus-4-8`. */
  readonly modelId: string | null;
  readonly costUsd: number | null;
  readonly error?: string;
}

/** Dispatches one headless model call. A test injects a fake, and {@link runModelViaClaude} is the real one. */
export type RunModelFn = (args: {
  readonly prompt: string;
  readonly model: string;
  readonly systemPrompt: string;
}) => Promise<ModelRunResult>;

/**
 * The real dispatch: `claude -p` as a text generator. It never throws.
 * A failed spawn, a non-zero exit or a provider error gives `{ ok: false, error }`, and the caller records a blocked cell.
 *
 * - `--tools ""`: no tool access, so the model cannot read the hidden oracle.
 * - `--system-prompt`: the neutral prompt.
 * - `--strict-mcp-config`: no MCP server loads.
 * - `--output-format json`: gives the result text, the resolved model id and the error status.
 */
export const runModelViaClaude: RunModelFn = async ({ prompt, model, systemPrompt }) => {
  try {
    const run = await spawnAsync(
      'claude',
      [
        '-p', prompt,
        '--model', model,
        '--system-prompt', systemPrompt,
        '--tools', '',
        '--strict-mcp-config',
        '--output-format', 'json',
      ],
      { cwd: RUNS_DIR, timeout: 300_000 },
    );
    if (run.error !== undefined) throw run.error;
    if (run.status !== 0) throw Object.assign(new Error(`claude exited ${String(run.status ?? run.signal)}`), { stderr: run.stderr });
    const j = JSON.parse(run.stdout) as {
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

const FILE_BLOCK_RE = /===FILE:\s*([^\s=]+)\s*===\r?\n([\s\S]*?)\r?\n?===ENDFILE===/g;

/**
 * Parses the `===FILE:<name>===` blocks in the model output into a map of file name to contents.
 * It removes a code fence that wraps the whole body of a block.
 * It skips a match that lacks a name or a body, so no file gets the name `undefined`.
 * When nothing parses, it returns an empty map, and the caller treats a missing `impl.ts` as blocked.
 * The function is pure.
 */
export function parseProducedFiles(result: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const m of result.matchAll(FILE_BLOCK_RE)) {
    const rawName = m[1];
    let body = m[2];
    if (rawName === undefined || body === undefined) continue;
    const name = rawName.trim();
    const fenced = body.match(/^\s*```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n?```\s*$/);
    if (fenced?.[1] !== undefined) body = fenced[1];
    files.set(name, body.endsWith('\n') ? body : body + '\n');
  }
  return files;
}

export interface CellId {
  readonly model: string;
  readonly task: TaskSpec;
  readonly arm: Arm;
  readonly rep: number;
}

/** The run name `<task>__<arm>__r<rep>`, in the grammar that `grade.ts` reads. */
export function runName(task: string, arm: Arm, rep: number): string {
  return `${task}__${arm}__r${rep}`;
}

/** The run directory of a cell: `<base>/<model>/<task>__<arm>__r<rep>`. */
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
 * Dispatches one cell: builds the arm prompt, calls the model, parses the files and writes the run directory.
 * It writes only `impl.ts` and test files, and ignores every other block.
 * When the call fails or the output holds no `impl.ts`, the cell is blocked.
 * When `skipExisting` is not `false` and the run directory holds a non-empty `impl.ts`, it reuses that run and calls no model.
 */
export async function dispatchCell(
  baseRunsDir: string,
  cell: CellId,
  deps: { readonly runModel: RunModelFn; readonly tasksDir: string; readonly skipExisting?: boolean },
): Promise<DispatchOutcome> {
  const runDir = cellRunDir(baseRunsDir, cell);
  const implPath = path.join(runDir, 'impl.ts');
  if (deps.skipExisting !== false && fs.existsSync(implPath) && fs.readFileSync(implPath, 'utf-8').trim().length > 0) {
    const existing = fs.readdirSync(runDir).filter((f) => f !== 'oracle.ts');
    return { status: 'ok', runDir, modelId: null, costUsd: null, filesWritten: existing };
  }

  const specText = fs.readFileSync(path.join(deps.tasksDir, cell.task.name, 'SPEC.underspec.md'), 'utf-8');
  const stubText = fs.readFileSync(path.join(deps.tasksDir, cell.task.name, 'impl.stub.ts'), 'utf-8');
  const prompt = buildUserPrompt(cell.task, cell.arm, specText, stubText);

  const res = await deps.runModel({ prompt, model: cell.model, systemPrompt: SYSTEM_PROMPT });
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
    if (name === 'impl.ts' || /\.(test|spec)\.[tj]s$|^test\.ts$/.test(name)) {
      fs.writeFileSync(path.join(runDir, name), body);
      written.push(name);
    }
  }
  return { status: 'ok', runDir, modelId: res.modelId, costUsd: res.costUsd, filesWritten: written.sort() };
}

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
 * Grades a run directory: oracle pass rate, strict `tsc`, the presence of tests, and the adequacy score from `gradeAdequacy`.
 * A blocked dispatch gives a blocked row with null metrics.
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
  const oracle = await gradeOracle(runDir, cell.task.name, deps.tasksDir);
  const typecheckOk = await gradeTypecheck(runDir);
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
 * Serializes the graded rows to CSV. `stampProvenance` stamps each row and throws when the provenance is incomplete.
 * Each row gets `source: 'measured'`, because the numbers come from a model call and the grader.
 * A blocked cell has `status=blocked` and empty metric cells. The function is pure.
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

/** The summary of one model, task and arm for the console table. The fields after `blocked` cover only the `ok` cells. */
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

async function gitSha(): Promise<string> {
  try {
    return (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })).trim();
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

/**
 * Runs every cell of the matrix, writes the CSV and prints the report. It exits 3 when every cell is blocked.
 * When no cell resolves a model id, the provenance stamp takes the requested model names, so the stamp stays complete.
 */
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
    const dispatch = await dispatchCell(RUNS_DIR, cell, { runModel: runModelViaClaude, tasksDir: TASKS_DIR, skipExisting });
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

  const modelIds = resolvedModelIds.size ? [...resolvedModelIds].sort() : models;
  const provenance: Provenance = { binaryTag: binaryTag(), gitSha: await gitSha(), modelIds, date: '2026-07-09' };

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
