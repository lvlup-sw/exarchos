// ─── Quality A/B grader tests (#1670 · DR-4/DR-7) ─────────────────────────────
//
// Two guarantees:
//   1. DISCRIMINATION (the point of the mechanical gate): the diff-scoped
//      kill-probe run by `gradeAdequacy` actually distinguishes a GENUINE test
//      suite (goes red when the impl is reverted to the stub → "killed" →
//      score 1) from a VACUOUS one (stays green → "survived" → score 0). This
//      test drives the REAL `runProbe` gate over a real throwaway git repo — no
//      injected/fake result — so it also proves the production path (DR-7
//      fail-honest: the score is measured, never self-reported).
//   2. CHARACTERIZATION: adding the adequacy column is ADDITIVE — the existing
//      fully-specified cells (oracle pass rate, typecheck, wroteTests) are byte-
//      identical to the pre-change grader output captured in `results.json`.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gradeAdequacy, gradeRun, type ProbeFn } from './grade.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QAB = __dirname; // docs/evals/quality-ab

// Generous per-test timeout: each case spawns git + tsx subprocesses (avoids the
// vitest 5s default spawn-timeout flake on process-spawning tests).
const SUBPROCESS_TIMEOUT = 120_000;
// gradeAdequacy/gradeRun spawn `tsx`/`git` (oracle run + diff-scoped mutation
// gate). Dev-only Linux-oriented eval tooling — the npm `.cmd` shims don't spawn
// cleanly on win32 — so these subprocess suites are skipped there and covered on
// the Linux lane.
const WIN32 = process.platform === 'win32';

// ── fixture sources for the discrimination test ──────────────────────────────
const STUB = `export function add(a: number, b: number): number {\n  throw new Error('not implemented');\n}\n`;
const IMPL = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
// GENUINE: calls add() and asserts its result → red when impl reverts to stub.
const GENUINE_TEST = `import assert from 'node:assert/strict';\nimport { add } from './impl.ts';\nassert.equal(add(2, 3), 5);\nassert.equal(add(-1, 1), 0);\nconsole.log('ok');\n`;
// VACUOUS: imports the module but asserts NOTHING about add() → stays green under
// the revert (the classic non-binding suite the kill-probe must catch).
const VACUOUS_TEST = `import assert from 'node:assert/strict';\nimport './impl.ts';\nassert.equal(1 + 1, 2);\nconsole.log('ok');\n`;

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
    // A run that wrote NO tests at all (the N-arm shape) — must be unmeasurable,
    // never a fabricated 0.
    fs.mkdirSync(notestRunDir, { recursive: true });
    fs.writeFileSync(path.join(notestRunDir, 'impl.ts'), IMPL);
  });

  afterAll(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
      // The whole reason the mechanical gate exists: the two must differ.
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

describe.skipIf(WIN32)('gradeRun — characterization: adequacy is additive, existing cells unchanged', () => {
  // Deterministic probe seam so this test pins the EXISTING metrics (oracle /
  // typecheck / wroteTests) without depending on the real kill-probe's timing;
  // the real gate's correctness is covered by the discrimination suite above.
  const fixedProbe: ProbeFn = async () => ({
    passed: true,
    probedTests: ['test.ts'],
    redObserved: true,
    restoredClean: true,
  });

  // The pre-change grader output committed at `results.json` — the baseline the
  // additive change must not perturb.
  const baseline = JSON.parse(
    fs.readFileSync(path.join(QAB, 'results.json'), 'utf-8'),
  ) as { results: Array<{ run: string; oraclePassed: number; oracleTotal: number; oracleFailures: string[]; typecheckOk: boolean; wroteTests: boolean }> };

  let workRoot: string;

  beforeAll(() => {
    workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qab-char-'));
    // Copy the committed csv-line task + its E/N run dirs into a scratch tree so
    // the grader's transient oracle copy never touches the committed fixtures.
    fs.cpSync(path.join(QAB, 'tasks', 'csv-line'), path.join(workRoot, 'tasks', 'csv-line'), { recursive: true });
    for (const run of ['csv-line__E__r1', 'csv-line__N__r1']) {
      fs.cpSync(path.join(QAB, 'runs', run), path.join(workRoot, 'runs', run), { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(workRoot, { recursive: true, force: true });
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

        // EXISTING cells — byte-identical to the captured baseline.
        expect(result.oraclePassed).toBe(base!.oraclePassed);
        expect(result.oracleTotal).toBe(base!.oracleTotal);
        expect(result.oracleFailures).toEqual(base!.oracleFailures);
        expect(result.typecheckOk).toBe(base!.typecheckOk);
        expect(result.wroteTests).toBe(base!.wroteTests);

        // NEW cell — additive, present alongside the unchanged ones.
        expect(result).toHaveProperty('adequacyScore');
        expect(result).toHaveProperty('adequacyProbed');
      },
    );
  }
});
