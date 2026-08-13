// ─── Exp 3 run harness tests (#1670 · DR-4/DR-7 · task 010) ───────────────────
//
// The dispatch itself calls a live model, so the SEAM (`runModel`) is injected
// here — these tests exercise the deterministic machinery around it:
//   1. PARSE — the `===FILE:…===` block parser turns model text into files.
//   2. PROMPT — the E arm carries the production verification steer; N does not.
//   3. DISPATCH — an injected model result materializes a run dir; a failed /
//      empty result yields a BLOCKED cell (never fabricated) — DR-7.
//   4. CAPTURE (mechanical) — against a FIXTURE run dir, `captureCell` correctly
//      aggregates hidden-oracle pass rate + strict tsc + durable-tests + the REAL
//      diff-scoped kill-probe mutation score (genuine→1, vacuous→0, no-test→null).
//      This drives the actual `gradeAdequacy`/`runProbe` gate — measured, not
//      stubbed (DR-7 fail-honest).
//   5. CSV — rows are stamped with the task-001 provenance shape; a blocked cell
//      leaves EMPTY metric cells.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  parseProducedFiles,
  buildUserPrompt,
  dispatchCell,
  captureCell,
  buildCsv,
  aggregate,
  runName,
  cellRunDir,
  TASKS,
  type CellId,
  type CellRow,
  type RunModelFn,
  type ModelRunResult,
} from './run-underspec.js';
import type { Provenance } from '../../../tools/evals/evals/provenance.js';

const SUBPROCESS_TIMEOUT = 120_000;
// The grading path spawns `tsx`/`git` subprocesses (oracle run + diff-scoped
// mutation gate). These dev-only eval harnesses are Linux-oriented; the npm
// `.cmd` bin shims + tmpdir semantics don't spawn cleanly on win32, so the
// subprocess-grading blocks are skipped there (the pure parser/prompt/CSV blocks
// still run everywhere). Coverage is exercised on the Linux lane.
const WIN32 = process.platform === 'win32';

const TOKEN_BUCKET = TASKS.find((t) => t.name === 'token-bucket')!;
const PARSE_DURATION = TASKS.find((t) => t.name === 'parse-duration')!;

// ── 1. PARSE ──────────────────────────────────────────────────────────────────

describe('parseProducedFiles — model-output block parser', () => {
  it('extracts a single impl.ts block', () => {
    const out = '===FILE:impl.ts===\nexport const x = 1;\n===ENDFILE===';
    const files = parseProducedFiles(out);
    expect([...files.keys()]).toEqual(['impl.ts']);
    expect(files.get('impl.ts')).toBe('export const x = 1;\n');
  });

  it('extracts impl.ts + test.ts and tolerates prose around the blocks', () => {
    const out = [
      'Here you go:',
      '===FILE:impl.ts===',
      'export function add(a: number, b: number) { return a + b; }',
      '===ENDFILE===',
      'and a test:',
      '===FILE:test.ts===',
      "import { add } from './impl.ts';",
      '===ENDFILE===',
      'done.',
    ].join('\n');
    const files = parseProducedFiles(out);
    expect([...files.keys()].sort()).toEqual(['impl.ts', 'test.ts']);
    expect(files.get('impl.ts')).toContain('return a + b');
    expect(files.get('test.ts')).toContain("from './impl.ts'");
  });

  it('strips a whole-body code fence a model wrapped the file in', () => {
    const out = '===FILE:impl.ts===\n```ts\nexport const y = 2;\n```\n===ENDFILE===';
    expect(parseProducedFiles(out).get('impl.ts')).toBe('export const y = 2;\n');
  });

  it('returns an empty map when no block is present (→ blocked upstream)', () => {
    expect(parseProducedFiles('sorry, I could not do that').size).toBe(0);
  });
});

// ── 2. PROMPT ─────────────────────────────────────────────────────────────────

describe('buildUserPrompt — both arms implement+test; ONLY the steer varies', () => {
  const spec = '# Task: parseDuration\nImplement it well.';
  const stub = 'export function parseDuration(s: string): number { throw new Error("x"); }';

  it('E arm embeds the production verification note + asks for a durable test.ts', () => {
    const p = buildUserPrompt(PARSE_DURATION, 'E', spec, stub);
    expect(p).toContain('check_test_adequacy');
    expect(p).toContain('outcome-based adequacy');
    expect(p).toContain('===FILE:test.ts===');
    expect(p).toContain(spec.trim());
  });

  it('N arm asks for the SAME durable test.ts but carries NO steer (symmetric test request)', () => {
    const p = buildUserPrompt(PARSE_DURATION, 'N', spec, stub);
    expect(p).toContain('===FILE:test.ts==='); // test request is held constant across arms
    expect(p).not.toContain('check_test_adequacy'); // …but the verification STEER is absent
    expect(p).not.toContain('kill-probe');
  });

  it('the test-request block is IDENTICAL across arms — the ONLY delta is the E steer', () => {
    const e = buildUserPrompt(PARSE_DURATION, 'E', spec, stub);
    const n = buildUserPrompt(PARSE_DURATION, 'N', spec, stub);
    const contract = '===FILE:test.ts===';
    // Both request the test; the E-only prefix is exactly the verification note.
    expect(e.slice(e.indexOf(contract))).toBe(n.slice(n.indexOf(contract)));
  });

  it('the high/boundary task adds the boundary mock steer only in the E arm', () => {
    const e = buildUserPrompt(TOKEN_BUCKET, 'E', spec, stub);
    const n = buildUserPrompt(TOKEN_BUCKET, 'N', spec, stub);
    expect(e).toContain('mock only what you own');
    expect(n).not.toContain('mock only what you own');
  });
});

// ── 3. DISPATCH (injected model) ──────────────────────────────────────────────

describe('dispatchCell — materialize a run dir from an injected model result', () => {
  let base: string;
  let tasksDir: string;

  const okModel = (result: string): RunModelFn => () => ({ ok: true, result, modelId: 'fake-model', costUsd: 0.01 });

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp3-dispatch-'));
    tasksDir = path.join(base, 'tasks');
    fs.mkdirSync(path.join(tasksDir, 'parse-duration'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'parse-duration', 'SPEC.underspec.md'), '# spec');
    fs.writeFileSync(path.join(tasksDir, 'parse-duration', 'impl.stub.ts'), 'export const stub = 1;');
  });
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

  const cell: CellId = { model: 'opus', task: PARSE_DURATION, arm: 'E', rep: 1 };

  it('writes impl.ts + test.ts from a well-formed E-arm result', () => {
    const runs = path.join(base, 'runs-ok');
    const model = okModel(
      '===FILE:impl.ts===\nexport const impl = 1;\n===ENDFILE===\n===FILE:test.ts===\nconsole.log("ok");\n===ENDFILE===',
    );
    const out = dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: false });
    expect(out.status).toBe('ok');
    expect(out.modelId).toBe('fake-model');
    expect(out.filesWritten).toEqual(['impl.ts', 'test.ts']);
    const runDir = cellRunDir(runs, cell);
    expect(fs.existsSync(path.join(runDir, 'impl.ts'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'test.ts'))).toBe(true);
  });

  it('BLOCKS (never fabricates) when the model call errors — DR-7', () => {
    const runs = path.join(base, 'runs-err');
    const model: RunModelFn = () => ({ ok: false, result: '', modelId: null, costUsd: null, error: 'boom' });
    const out = dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: false });
    expect(out.status).toBe('blocked');
    expect(out.error).toBe('boom');
    expect(fs.existsSync(cellRunDir(runs, cell))).toBe(false);
  });

  it('BLOCKS when the model output has no parseable impl.ts — DR-7', () => {
    const runs = path.join(base, 'runs-noimpl');
    const out = dispatchCell(runs, cell, { runModel: okModel('here is some prose, no files'), tasksDir, skipExisting: false });
    expect(out.status).toBe('blocked');
    expect(out.error).toMatch(/no parseable impl/);
  });

  it('resumes: skips re-dispatch when a non-empty impl.ts already exists', () => {
    const runs = path.join(base, 'runs-resume');
    const runDir = cellRunDir(runs, cell);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'impl.ts'), 'export const prior = 1;\n');
    let called = false;
    const model: RunModelFn = () => {
      called = true;
      return { ok: true, result: '===FILE:impl.ts===\nnew\n===ENDFILE===', modelId: 'x', costUsd: 0 };
    };
    const out = dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: true });
    expect(out.status).toBe('ok');
    expect(called).toBe(false); // did not re-spend
    expect(fs.readFileSync(path.join(runDir, 'impl.ts'), 'utf-8')).toContain('prior');
  });
});

// ── 4. CAPTURE (real mechanical grading against a fixture run dir) ─────────────

// A tiny self-contained `add` task: stub throws, oracle checks a few cases.
const ADD_STUB = `export function add(a: number, b: number): number {\n  throw new Error('not implemented');\n}\n`;
const ADD_IMPL = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
const ADD_ORACLE = `import { add } from './impl.ts';
function assert(c: boolean, m: string) { if (!c) throw new Error(m); }
const checks: Array<[string, () => void]> = [
  ['2+3', () => assert(add(2, 3) === 5, '2+3')],
  ['neg', () => assert(add(-1, 1) === 0, 'neg')],
  ['zero', () => assert(add(0, 0) === 0, 'zero')],
];
let passed = 0; const failures: string[] = [];
for (const [n, f] of checks) { try { f(); passed++; } catch (e) { failures.push(n + ': ' + (e as Error).message); } }
console.log(JSON.stringify({ passed, failed: failures.length, total: checks.length, failures }));
`;
// GENUINE test: asserts add() → red when impl reverts to the throwing stub.
const GENUINE_TEST = `import assert from 'node:assert/strict';\nimport { add } from './impl.ts';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('ok');\n`;
// VACUOUS test: imports impl but asserts nothing about add → stays green.
const VACUOUS_TEST = `import assert from 'node:assert/strict';\nimport './impl.ts';\nassert.equal(1 + 1, 2);\nconsole.log('ok');\n`;

describe.skipIf(WIN32)('captureCell — mechanical per-cell aggregation (oracle · tsc · mutation)', () => {
  let fixtureRoot: string;
  let tasksDir: string;
  let runsDir: string;
  const addTask = { name: 'add', riskTier: 'medium' as const, boundaryTouching: false };

  function seedRun(model: string, arm: 'E' | 'N', rep: number, impl: string, test?: string): CellId {
    const cell: CellId = { model, task: addTask, arm, rep };
    const dir = cellRunDir(runsDir, cell);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'impl.ts'), impl);
    if (test) fs.writeFileSync(path.join(dir, 'test.ts'), test);
    return cell;
  }

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp3-capture-'));
    tasksDir = path.join(fixtureRoot, 'tasks');
    runsDir = path.join(fixtureRoot, 'runs');
    fs.mkdirSync(path.join(tasksDir, 'add'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'add', 'impl.stub.ts'), ADD_STUB);
    fs.writeFileSync(path.join(tasksDir, 'add', 'oracle.ts'), ADD_ORACLE);
  });
  afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

  it(
    'GENUINE E cell: oracle full-pass, tsc ok, durable tests, mutation KILLED (score 1)',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const cell = seedRun('opus', 'E', 1, ADD_IMPL, GENUINE_TEST);
      const dispatch = { status: 'ok' as const, runDir: cellRunDir(runsDir, cell), modelId: 'm', costUsd: 0.02, filesWritten: ['impl.ts', 'test.ts'] };
      const row = await captureCell(runsDir, cell, dispatch, { tasksDir });
      expect(row.status).toBe('ok');
      expect(row.oraclePassed).toBe(3);
      expect(row.oracleTotal).toBe(3);
      expect(row.oracleRate).toBe(1);
      expect(row.typecheckOk).toBe(true);
      expect(row.wroteTests).toBe(true);
      expect(row.adequacyProbed).toBe(true);
      expect(row.adequacyScore).toBe(1); // mechanically KILLED, not self-reported
    },
  );

  it(
    'VACUOUS E cell: same impl but a non-binding test → mutation SURVIVED (score 0)',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const cell = seedRun('opus', 'E', 2, ADD_IMPL, VACUOUS_TEST);
      const dispatch = { status: 'ok' as const, runDir: cellRunDir(runsDir, cell), modelId: 'm', costUsd: 0.02, filesWritten: ['impl.ts', 'test.ts'] };
      const row = await captureCell(runsDir, cell, dispatch, { tasksDir });
      expect(row.wroteTests).toBe(true);
      expect(row.adequacyProbed).toBe(true);
      expect(row.adequacyScore).toBe(0); // survived the revert → vacuous
    },
  );

  it(
    'cell with no test file: mutation UNMEASURABLE (score null), never a fabricated 0 — DR-7',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      // Both arms are now asked to test, but a model can still fail to emit one —
      // the grader must stay honest (null, not 0) on that branch.
      const cell = seedRun('sonnet', 'N', 1, ADD_IMPL);
      const dispatch = { status: 'ok' as const, runDir: cellRunDir(runsDir, cell), modelId: 'm', costUsd: 0.01, filesWritten: ['impl.ts'] };
      const row = await captureCell(runsDir, cell, dispatch, { tasksDir });
      expect(row.wroteTests).toBe(false);
      expect(row.adequacyScore).toBeNull();
      expect(row.adequacyDiscriminant).toBe('no-new-tests');
    },
  );

  it('blocked dispatch → blocked row with all-NULL metrics (DR-7)', async () => {
    const cell: CellId = { model: 'opus', task: addTask, arm: 'E', rep: 9 };
    const dispatch = { status: 'blocked' as const, runDir: cellRunDir(runsDir, cell), modelId: null, costUsd: null, filesWritten: [], error: 'model call failed' };
    const row = await captureCell(runsDir, cell, dispatch, { tasksDir });
    expect(row.status).toBe('blocked');
    expect(row.oracleRate).toBeNull();
    expect(row.typecheckOk).toBeNull();
    expect(row.adequacyScore).toBeNull();
    expect(row.note).toBe('model call failed');
  });
});

// ── 5. CSV / provenance ───────────────────────────────────────────────────────

describe('buildCsv — provenance-stamped rows; blocked cells stay empty', () => {
  const provenance: Provenance = {
    binaryTag: 'v2.12.0-preview.1',
    gitSha: 'abc123',
    modelIds: ['claude-opus-4-8', 'claude-sonnet-5'],
    date: '2026-07-09',
  };
  const okRow: CellRow = {
    model: 'opus', modelId: 'claude-opus-4-8', task: 'parse-duration', arm: 'E', rep: 1, status: 'ok',
    oraclePassed: 21, oracleTotal: 21, oracleRate: 1, typecheckOk: true, wroteTests: true,
    adequacyProbed: true, adequacyScore: 1, adequacyDiscriminant: 'probed', costUsd: 0.3, note: '',
  };
  const blockedRow: CellRow = {
    model: 'sonnet', modelId: 'sonnet', task: 'csv-line', arm: 'N', rep: 2, status: 'blocked',
    oraclePassed: null, oracleTotal: null, oracleRate: null, typecheckOk: null, wroteTests: null,
    adequacyProbed: null, adequacyScore: null, adequacyDiscriminant: 'blocked', costUsd: null, note: 'timeout',
  };

  it('emits a header + one row per cell, provenance stamped on every row', () => {
    const csv = buildCsv([okRow, blockedRow], provenance);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('model,modelId,task,arm,rep,status');
    expect(lines[0]).toContain('binaryTag');
    expect(lines).toHaveLength(3); // header + 2 rows
    // ok row carries measured numbers + provenance
    expect(lines[1]).toContain('v2.12.0-preview.1');
    expect(lines[1]).toContain('claude-opus-4-8|claude-sonnet-5');
    expect(lines[1]).toContain('measured');
    // blocked row: empty metric cells, never a fabricated number
    const blockedFields = (lines[2] ?? '').split(',');
    expect(blockedFields[5]).toBe('blocked'); // status
    expect(blockedFields[6]).toBe(''); // oraclePassed empty
    expect(blockedFields[12]).toBe(''); // adequacyScore empty
  });

  it('throws (fail-loud) when provenance is incomplete — no unstamped data', () => {
    const bad = { ...provenance, gitSha: '' } as unknown as Provenance;
    expect(() => buildCsv([okRow], bad)).toThrow(/gitSha/);
  });
});

// ── aggregate (report table) ──────────────────────────────────────────────────

describe('aggregate — per model×task×arm summary over ok cells', () => {
  const row = (over: Partial<CellRow>): CellRow => ({
    model: 'opus', modelId: 'm', task: 'parse-duration', arm: 'E', rep: 1, status: 'ok',
    oraclePassed: 21, oracleTotal: 21, oracleRate: 1, typecheckOk: true, wroteTests: true,
    adequacyProbed: true, adequacyScore: 1, adequacyDiscriminant: 'probed', costUsd: 0, note: '',
    ...over,
  });

  it('groups by model::task::arm and counts ok/blocked/killed correctly', () => {
    const rows = [
      row({ rep: 1, adequacyScore: 1 }),
      row({ rep: 2, adequacyScore: 0 }),
      row({ rep: 3, status: 'blocked', oracleRate: null, adequacyScore: null, adequacyProbed: null, typecheckOk: null, wroteTests: null }),
    ];
    const agg = aggregate(rows);
    expect(agg).toHaveLength(1);
    const [group] = agg;
    expect(group?.key).toBe('opus::parse-duration::E');
    expect(group?.runs).toBe(3);
    expect(group?.okRuns).toBe(2);
    expect(group?.blocked).toBe(1);
    expect(group?.adequacyProbed).toBe(2);
    expect(group?.adequacyKilled).toBe(1);
    expect(group?.oracleMeanPct).toBe(100);
  });

  it('leaves oracleMeanPct null when every cell in a group is blocked', () => {
    const rows = [row({ status: 'blocked', oracleRate: null })];
    expect(aggregate(rows)[0]?.oracleMeanPct).toBeNull();
  });
});

// runName sanity (grade.ts-compatible grammar)
describe('runName', () => {
  it('produces the <task>__<arm>__r<rep> grammar grade.ts expects', () => {
    expect(runName('csv-line', 'E', 3)).toBe('csv-line__E__r3');
  });
});
