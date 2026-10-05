/**
 * Tests for the run harness of experiment 3. The dispatch calls a live model, so each test injects the `runModel` seam.
 * The tests cover the deterministic parts:
 * - Parse: the `===FILE:<name>===` block parser turns model text into files.
 * - Prompt: arm E carries the production verification steer, and arm N does not.
 * - Dispatch: an injected model result writes a run directory. A failed or empty result gives a blocked cell.
 * - Capture: `captureCell` grades a fixture run directory with the real `gradeAdequacy` and `runProbe`, not a stub.
 * - CSV: each row carries the provenance stamp, and a blocked cell has empty metric cells.
 */

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
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const SUBPROCESS_TIMEOUT = 120_000;
/**
 * The grading path starts `tsx` and `git` subprocesses, and the npm `.cmd` shims do not spawn cleanly on win32.
 * The suite that grades skips there and runs on the Linux lane. The other suites run on every platform.
 */
const WIN32 = process.platform === 'win32';

const TOKEN_BUCKET = TASKS.find((t) => t.name === 'token-bucket')!;
const PARSE_DURATION = TASKS.find((t) => t.name === 'parse-duration')!;

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
    expect(p).toContain('===FILE:test.ts===');
    expect(p).not.toContain('check_test_adequacy');
    expect(p).not.toContain('kill-probe');
  });

  it('the test-request block is IDENTICAL across arms — the ONLY delta is the E steer', () => {
    const e = buildUserPrompt(PARSE_DURATION, 'E', spec, stub);
    const n = buildUserPrompt(PARSE_DURATION, 'N', spec, stub);
    const contract = '===FILE:test.ts===';
    expect(e.slice(e.indexOf(contract))).toBe(n.slice(n.indexOf(contract)));
  });

  it('the high/boundary task adds the boundary mock steer only in the E arm', () => {
    const e = buildUserPrompt(TOKEN_BUCKET, 'E', spec, stub);
    const n = buildUserPrompt(TOKEN_BUCKET, 'N', spec, stub);
    expect(e).toContain('mock only what you own');
    expect(n).not.toContain('mock only what you own');
  });
});

describe('dispatchCell — materialize a run dir from an injected model result', () => {
  let base: string;
  let tasksDir: string;

  const okModel = (result: string): RunModelFn => async () => ({ ok: true, result, modelId: 'fake-model', costUsd: 0.01 });

  beforeAll(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'exp3-dispatch-'));
    tasksDir = path.join(base, 'tasks');
    fs.mkdirSync(path.join(tasksDir, 'parse-duration'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'parse-duration', 'SPEC.underspec.md'), '# spec');
    fs.writeFileSync(path.join(tasksDir, 'parse-duration', 'impl.stub.ts'), 'export const stub = 1;');
  });
  afterAll(() => rmrf(base));

  const cell: CellId = { model: 'opus', task: PARSE_DURATION, arm: 'E', rep: 1 };

  it('writes impl.ts + test.ts from a well-formed E-arm result', async () => {
    const runs = path.join(base, 'runs-ok');
    const model = okModel(
      '===FILE:impl.ts===\nexport const impl = 1;\n===ENDFILE===\n===FILE:test.ts===\nconsole.log("ok");\n===ENDFILE===',
    );
    const out = await dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: false });
    expect(out.status).toBe('ok');
    expect(out.modelId).toBe('fake-model');
    expect(out.filesWritten).toEqual(['impl.ts', 'test.ts']);
    const runDir = cellRunDir(runs, cell);
    expect(fs.existsSync(path.join(runDir, 'impl.ts'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'test.ts'))).toBe(true);
  });

  it('BLOCKS (never fabricates) when the model call errors — DR-7', async () => {
    const runs = path.join(base, 'runs-err');
    const model: RunModelFn = async () => ({ ok: false, result: '', modelId: null, costUsd: null, error: 'boom' });
    const out = await dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: false });
    expect(out.status).toBe('blocked');
    expect(out.error).toBe('boom');
    expect(fs.existsSync(cellRunDir(runs, cell))).toBe(false);
  });

  it('BLOCKS when the model output has no parseable impl.ts — DR-7', async () => {
    const runs = path.join(base, 'runs-noimpl');
    const out = await dispatchCell(runs, cell, { runModel: okModel('here is some prose, no files'), tasksDir, skipExisting: false });
    expect(out.status).toBe('blocked');
    expect(out.error).toMatch(/no parseable impl/);
  });

  it('resumes: skips re-dispatch when a non-empty impl.ts already exists', async () => {
    const runs = path.join(base, 'runs-resume');
    const runDir = cellRunDir(runs, cell);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'impl.ts'), 'export const prior = 1;\n');
    let called = false;
    const model: RunModelFn = async () => {
      called = true;
      return { ok: true, result: '===FILE:impl.ts===\nnew\n===ENDFILE===', modelId: 'x', costUsd: 0 };
    };
    const out = await dispatchCell(runs, cell, { runModel: model, tasksDir, skipExisting: true });
    expect(out.status).toBe('ok');
    expect(called).toBe(false);
    expect(fs.readFileSync(path.join(runDir, 'impl.ts'), 'utf-8')).toContain('prior');
  });
});

/** The stub of the fixture task `add`. The stub throws, and `ADD_ORACLE` checks three cases. */
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
/** A genuine test. It asserts the result of `add`, so it goes red when the impl reverts to the stub. */
const GENUINE_TEST = `import assert from 'node:assert/strict';\nimport { add } from './impl.ts';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('ok');\n`;
/** A vacuous test. It imports the impl and asserts nothing about `add`, so it stays green after the revert. */
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
  afterAll(() => rmrf(fixtureRoot));

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
      expect(row.adequacyScore).toBe(1);
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
      expect(row.adequacyScore).toBe(0);
    },
  );

  /** Both arms get the test request, but a model can omit the test file. The score must then be `null`, not 0. */
  it(
    'cell with no test file: mutation UNMEASURABLE (score null), never a fabricated 0 — DR-7',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
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

  /** In the blocked row, field 5 is `status`, field 6 is `oraclePassed` and field 12 is `adequacyScore`. */
  it('emits a header + one row per cell, provenance stamped on every row', () => {
    const csv = buildCsv([okRow, blockedRow], provenance);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toContain('model,modelId,task,arm,rep,status');
    expect(lines[0]).toContain('binaryTag');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('v2.12.0-preview.1');
    expect(lines[1]).toContain('claude-opus-4-8|claude-sonnet-5');
    expect(lines[1]).toContain('measured');
    const blockedFields = (lines[2] ?? '').split(',');
    expect(blockedFields[5]).toBe('blocked');
    expect(blockedFields[6]).toBe('');
    expect(blockedFields[12]).toBe('');
  });

  it('throws (fail-loud) when provenance is incomplete — no unstamped data', () => {
    const bad = { ...provenance, gitSha: '' } as unknown as Provenance;
    expect(() => buildCsv([okRow], bad)).toThrow(/gitSha/);
  });
});

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

describe('runName', () => {
  it('produces the <task>__<arm>__r<rep> grammar grade.ts expects', () => {
    expect(runName('csv-line', 'E', 3)).toBe('csv-line__E__r3');
  });
});
