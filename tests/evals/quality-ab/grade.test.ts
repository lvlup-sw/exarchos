/**
 * Tests for the quality A/B grader.
 *
 * - Discrimination: `gradeAdequacy` runs the real `runProbe` kill-probe in a temporary git
 *   repository, with no injected result. A suite that goes red when the implementation reverts
 *   to the stub scores 1. A suite that stays green scores 0.
 * - Characterization: `gradeRun` returns the oracle, typecheck and `wroteTests` cells that
 *   `results.json` holds, and it adds the adequacy cells.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeAdequacy, gradeRun, type ProbeFn } from './grade.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The `tests/evals/quality-ab` directory. */
const QAB = __dirname;

/** Each case starts `git` and `tsx` subprocesses, which can take longer than the vitest default. */
const SUBPROCESS_TIMEOUT = 120_000;
/**
 * `gradeAdequacy` and `gradeRun` start `tsx` and `git`. The npm `.cmd` shims do not start cleanly
 * on win32, so both suites skip there.
 */
const WIN32 = process.platform === 'win32';

const STUB = `export function add(a: number, b: number): number {\n  throw new Error('not implemented');\n}\n`;
const IMPL = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
/** Calls `add()` and asserts its result, so it goes red when the implementation reverts to the stub. */
const GENUINE_TEST = `import assert from 'node:assert/strict';\nimport { add } from './impl.ts';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('ok');\n`;
/** Imports the module and asserts nothing about `add()`, so it stays green when the implementation reverts. */
const VACUOUS_TEST = `import assert from 'node:assert/strict';\nimport './impl.ts';\nassert.equal(1 + 1, 2);\nconsole.log('ok');\n`;

/**
 * The fixture holds three runs over one implementation: a genuine suite, a vacuous suite, and a
 * run with no test file. The run with no test file must get no score, not a score of 0.
 */
describe.skipIf(WIN32)('gradeAdequacy — mechanical diff-scoped kill-probe (DR-4/DR-7)', () => {
  let fixtureRoot: string;
  let tasksDir: string;
  let genuineRunDir: string;
  let vacuousRunDir: string;
  let notestRunDir: string;

  beforeAll(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-grade-test-'));
    tasksDir = path.join(fixtureRoot, 'tasks');
    fs.mkdirSync(path.join(tasksDir, 'add'), { recursive: true });
    fs.writeFileSync(path.join(tasksDir, 'add', 'impl.stub.ts'), STUB);

    const runs = path.join(fixtureRoot, 'runs');
    genuineRunDir = path.join(runs, 'add__E__r1');
    vacuousRunDir = path.join(runs, 'add__N__r1');
    notestRunDir = path.join(runs, 'add__N__r2');
    for (const [dir, test] of [
      [genuineRunDir, GENUINE_TEST],
      [vacuousRunDir, VACUOUS_TEST],
    ] as const) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'impl.ts'), IMPL);
      fs.writeFileSync(path.join(dir, 'test.ts'), test);
    }
    fs.mkdirSync(notestRunDir, { recursive: true });
    fs.writeFileSync(path.join(notestRunDir, 'impl.ts'), IMPL);
  });

  afterAll(() => {
    rmrf(fixtureRoot);
  });

  it(
    'scores a GENUINE suite HIGH (killed → 1)',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const r = await gradeAdequacy(genuineRunDir, 'add', { tasksDir });
      expect(r.probed).toBe(true);
      expect(r.redObserved).toBe(true);
      expect(r.score).toBe(1);
      expect(r.error).toBeUndefined();
    },
  );

  it(
    'scores a VACUOUS suite LOW (survived → 0)',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const r = await gradeAdequacy(vacuousRunDir, 'add', { tasksDir });
      expect(r.probed).toBe(true);
      expect(r.redObserved).toBe(false);
      expect(r.score).toBe(0);
    },
  );

  it(
    'DISCRIMINATES: the genuine suite outscores the vacuous one on the same impl',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const genuine = await gradeAdequacy(genuineRunDir, 'add', { tasksDir });
      const vacuous = await gradeAdequacy(vacuousRunDir, 'add', { tasksDir });
      expect(genuine.score).not.toBe(vacuous.score);
      expect((genuine.score ?? 0) > (vacuous.score ?? 0)).toBe(true);
    },
  );

  it(
    'leaves NO adequacy score when the run wrote no tests (never fabricates 0)',
    { timeout: SUBPROCESS_TIMEOUT },
    async () => {
      const r = await gradeAdequacy(notestRunDir, 'add', { tasksDir });
      expect(r.probed).toBe(false);
      expect(r.score).toBeNull();
      expect(r.discriminant).toBe('no-new-tests');
    },
  );
});

/**
 * `fixedProbe` replaces the real kill-probe, so these tests pin the oracle, typecheck and
 * `wroteTests` cells without the timing of the probe. The real probe derives `passed` and
 * `disposition` from `verdict`, so the stand-in states all three consistently.
 *
 * The baseline is the committed `results.json`. `beforeAll` copies the csv-line task and the first
 * run directory of each arm to a temporary tree. Thus the grader writes its oracle copy outside
 * the committed fixtures.
 */
describe.skipIf(WIN32)('gradeRun — characterization: adequacy is additive, existing cells unchanged', () => {
  const fixedProbe: ProbeFn = async () => ({
    verdict: { kind: 'passed', probedTests: ['test.ts'] },
    passed: true,
    disposition: 'proved',
    probedTests: ['test.ts'],
    redObserved: true,
    restoredClean: true,
  });

  const baseline = JSON.parse(
    fs.readFileSync(path.join(QAB, 'results.json'), 'utf-8'),
  ) as { results: Array<{ run: string; oraclePassed: number; oracleTotal: number; oracleFailures: string[]; typecheckOk: boolean; wroteTests: boolean }> };

  let workRoot: string;

  beforeAll(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-char-'));
    fs.cpSync(path.join(QAB, 'tasks', 'csv-line'), path.join(workRoot, 'tasks', 'csv-line'), { recursive: true });
    for (const run of ['csv-line__E__r1', 'csv-line__N__r1']) {
      fs.cpSync(path.join(QAB, 'runs', run), path.join(workRoot, 'runs', run), { recursive: true });
    }
  });

  afterAll(() => {
    rmrf(workRoot);
  });

  for (const run of ['csv-line__E__r1', 'csv-line__N__r1']) {
    it(
      `preserves the pre-change cells for ${run}`,
      { timeout: SUBPROCESS_TIMEOUT },
      async () => {
        const base = baseline.results.find((r) => r.run === run);
        expect(base, `baseline for ${run} present in results.json`).toBeDefined();

        const result = await gradeRun(path.join(workRoot, 'runs'), run, {
          tasksDir: path.join(workRoot, 'tasks'),
          probe: fixedProbe,
        });

        expect(result.oraclePassed).toBe(base!.oraclePassed);
        expect(result.oracleTotal).toBe(base!.oracleTotal);
        expect(result.oracleFailures).toEqual(base!.oracleFailures);
        expect(result.typecheckOk).toBe(base!.typecheckOk);
        expect(result.wroteTests).toBe(base!.wroteTests);

        expect(result).toHaveProperty('adequacyScore');
        expect(result).toHaveProperty('adequacyProbed');
      },
    );
  }
});
