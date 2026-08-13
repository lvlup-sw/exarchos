// ─── Gate catch-rate driver — real-handler measurement (#1675, task 004) ──────
//
// Verifies the DR-3/DR-5/DR-8 contract: the driver runs each seeded fixture
// through its REAL class gate handler in a disposable worktree with an EPHEMERAL
// event store, records per-cell verdict + wall-clock ms + payload tokens, treats
// the dropped-edge-case class as ungated pass-through, and emits an explicit
// `invalid` record (never a fabricated verdict) when a handler crashes.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runCatchRate,
  verdictFromResult,
  estimateTokens,
  type CatchRateReport,
  type GateDispatch,
} from './catch-rate-driver.js';
import { loadSeededCorpus, MECHANICAL_GATE_CLASSES, type SeededFixture } from './corpus.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');

/** One defect + one control per mechanical class, plus one dropped-edge pair. */
function subset(): SeededFixture[] {
  const all = loadSeededCorpus();
  const picked: SeededFixture[] = [];
  for (const cls of [...MECHANICAL_GATE_CLASSES, 'dropped-edge-case'] as const) {
    const cf = all.filter((f) => f.gateClass === cls);
    const defect = cf.find((f) => f.kind === 'defect');
    const control = cf.find((f) => f.kind === 'control');
    if (defect) picked.push(defect);
    if (control) picked.push(control);
  }
  return picked;
}

describe('gate catch-rate driver', () => {
  let report: CatchRateReport;
  let tmpRoot: string;

  beforeAll(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-rate-test-'));
    report = await runCatchRate({ corpus: subset(), tmpRoot });
  }, 180_000);

  afterAll(() => {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('CatchRateDriver_SeededDefectFixture_RecordsGateFail', () => {
    // Every mechanical gate must FLAG its seeded defect — the true positive.
    for (const cls of MECHANICAL_GATE_CLASSES) {
      const defectRow = report.rows.find((r) => r.gateClass === cls && r.kind === 'defect');
      expect(defectRow, `${cls} defect row`).toBeDefined();
      expect(defectRow!.verdict, `${cls} defect verdict`).toBe('fail');
      expect(defectRow!.correct).toBe(true);
      expect(defectRow!.gate).not.toBe('none');
    }
  });

  it('CatchRateDriver_ControlFixture_RecordsGatePass', () => {
    // Every mechanical gate must leave its matched control CLEAN — no false positive.
    for (const cls of MECHANICAL_GATE_CLASSES) {
      const controlRow = report.rows.find((r) => r.gateClass === cls && r.kind === 'control');
      expect(controlRow, `${cls} control row`).toBeDefined();
      expect(controlRow!.verdict, `${cls} control verdict`).toBe('pass');
      expect(controlRow!.correct).toBe(true);
    }
  });

  it('CatchRateDriver_RecordsWallClockAndPayloadTokensPerCell', () => {
    // The DR-5 cost columns exist and are measured for every gated cell.
    const gated = report.rows.filter((r) => r.gate !== 'none');
    expect(gated.length).toBeGreaterThan(0);
    for (const r of gated) {
      expect(r.wallClockMs, `${r.fixtureId} wallClockMs`).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(r.wallClockMs)).toBe(true);
      expect(r.payloadChars, `${r.fixtureId} payloadChars`).toBeGreaterThan(0);
      expect(r.payloadTokens, `${r.fixtureId} payloadTokens`).toBe(estimateTokens(r.payloadChars));
      expect(r.payloadTokens).toBeGreaterThan(0);
    }
    // Aggregates surface per-gate mean cost sourced from the cells.
    for (const a of report.aggregates) {
      expect(a.meanWallClockMs).toBeGreaterThanOrEqual(0);
      expect(a.meanPayloadTokens).toBeGreaterThan(0);
    }
  });

  it('CatchRateDriver_DroppedEdgeCaseClass_RecordedAsUngated', () => {
    const dropped = report.rows.filter((r) => r.gateClass === 'dropped-edge-case');
    expect(dropped.length).toBeGreaterThan(0);
    for (const r of dropped) {
      // No production gate targets it — recorded structurally as ungated.
      expect(r.verdict).toBe('ungated');
      expect(r.gate).toBe('none');
      expect(r.expectedVerdict).toBe('ungated');
      // The hidden-oracle verdict is carried (feeds task 006's escape math):
      // a defect trips the oracle, a control does not.
      expect(typeof r.oracleDetected).toBe('boolean');
      expect(r.oracleDetected).toBe(r.kind === 'defect');
    }
    // Dropped-edge rows are NOT in any per-gate catch-rate aggregate.
    expect(report.aggregates.some((a) => a.gateClass === 'dropped-edge-case')).toBe(false);
  });

  it('CatchRateDriver_GateCrash_EmitsInvalidRecordNotVerdict', async () => {
    // A handler that THROWS must yield an explicit `invalid` cell — never a
    // fabricated fail/pass verdict (DR-8 fail-honest).
    const crashDispatch: GateDispatch = () => {
      throw new Error('simulated gate crash');
    };
    const crashTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-rate-crash-'));
    try {
      const oneDefect = loadSeededCorpus('static-analysis').filter((f) => f.kind === 'defect').slice(0, 1);
      const crashed = await runCatchRate({ corpus: oneDefect, tmpRoot: crashTmp, dispatch: crashDispatch });
      const row = crashed.rows[0];
      expect(row.verdict).toBe('invalid');
      expect(row.verdict).not.toBe('fail');
      expect(row.verdict).not.toBe('pass');
      expect(row.note).toContain('threw');
      expect(row.correct).toBe(false);
      // And the aggregate counts it as invalid, not as a catch.
      const agg = crashed.aggregates.find((a) => a.gateClass === 'static-analysis');
      expect(agg!.invalidCells).toBeGreaterThanOrEqual(1);
      expect(agg!.defectsCaught).toBe(0);
    } finally {
      fs.rmSync(crashTmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('CatchRateDriver_Events_NeverTouchProjectStore', () => {
    // The ephemeral event store lives under the injected temp root — never the
    // project's event store, never inside the repo.
    expect(report.eventStoreDir.startsWith(tmpRoot)).toBe(true);
    expect(report.eventStoreDir.startsWith(os.tmpdir())).toBe(true);
    expect(report.eventStoreDir.startsWith(REPO_ROOT)).toBe(false);
    // The store dir was actually created (events had somewhere ephemeral to go).
    expect(fs.existsSync(report.eventStoreDir)).toBe(true);
    // The store never lands in an agent worktree inside the repo either.
    // (The driver only ever writes under tmpRoot — asserted above.)
    expect(report.eventStoreDir.includes(path.join('.claude', 'worktrees'))).toBe(false);
  });

  it('CatchRateDriver_GitMaterializeFailure_EmitsInvalidRecordNotVerdict', async () => {
    // A git setup failure during materialization must yield an explicit `invalid`
    // cell, never a verdict off a partial worktree (DR-8 fail-honest). Distinct
    // from the handler-threw path: the note is `materialize-failed`, not `threw`.
    const failingGit: (root: string, args: readonly string[]) => { stdout: string; exitCode: number } =
      (_root, args) => (args[0] === 'commit' ? { stdout: 'nothing to commit', exitCode: 1 } : { stdout: '', exitCode: 0 });
    const matTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-rate-mat-'));
    try {
      const oneDefect = loadSeededCorpus('static-analysis').filter((f) => f.kind === 'defect').slice(0, 1);
      const out = await runCatchRate({ corpus: oneDefect, tmpRoot: matTmp, git: failingGit });
      const row = out.rows[0];
      expect(row.verdict).toBe('invalid');
      expect(row.verdict).not.toBe('fail');
      expect(row.verdict).not.toBe('pass');
      expect(row.note).toContain('materialize-failed');
      expect(row.correct).toBe(false);
      const agg = out.aggregates.find((a) => a.gateClass === 'static-analysis');
      expect(agg!.invalidCells).toBeGreaterThanOrEqual(1);
      expect(agg!.defectsCaught).toBe(0);
    } finally {
      fs.rmSync(matTmp, { recursive: true, force: true });
    }
  }, 60_000);

  it('VerdictFromResult_MockBoundaryUsesFindingsNotPassed', () => {
    // Unit contract: mock-boundary is advisory (passed stays true) — a catch is
    // signalled by findings, NOT by passed:false. A crashed envelope is invalid.
    expect(
      verdictFromResult('mock-boundary', { success: true, data: { passed: true, findings: [{ x: 1 }] } }).verdict,
    ).toBe('fail');
    expect(
      verdictFromResult('mock-boundary', { success: true, data: { passed: true, findings: [] } }).verdict,
    ).toBe('pass');
    expect(
      verdictFromResult('static-analysis', { success: true, data: { passed: false } }).verdict,
    ).toBe('fail');
    expect(
      verdictFromResult('static-analysis', { success: true, data: { skipped: true, passed: false } }).verdict,
    ).toBe('invalid');
    expect(verdictFromResult('test-adequacy', { success: false, error: { code: 'X', message: 'y' } }).verdict).toBe(
      'invalid',
    );
  });
});
