import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  diffClassifications,
  snapshotChanged,
  sequencesEqual,
  countChanged,
  stampBinaryProvenance,
  buildProvenanceArtifact,
  buildPairRows,
  toCsv,
  CSV_COLUMNS,
  loadCorpusTasks,
  runArmOverCorpus,
  setupServerRoot,
  EXP1_BINARY_REFS,
  RELEASED_WINDOW_CONFOUNDS,
  type ClassificationSnapshot,
  type BinaryRef,
  type CorpusSpecTasks,
} from './exp1-binary-driver.js';
import { ProvenanceError, assertMeasured } from '../provenance.js';

// ─── Pure diff core: property tests (symmetric + complete) ───────────────────

const snapshotArb = fc.record({
  taskId: fc.string({ minLength: 1, maxLength: 4 }),
  riskTier: fc.constantFrom<string | null>('low', 'medium', 'high', null),
  boundaryTouching: fc.constantFrom<boolean | null>(true, false, null),
  verificationSequence: fc.array(
    fc.constantFrom('check_static_analysis', 'check_test_adequacy', 'check_integration_suite', 'check_contract_drift'),
    { maxLength: 5 },
  ),
});

// Arrays with UNIQUE taskIds — mirrors the real classifications (one per task).
const snapshotSetArb = fc.uniqueArray(snapshotArb, {
  selector: (s) => s.taskId,
  maxLength: 8,
});

describe('diffClassifications — pure diff core (property)', () => {
  it('is COMPLETE: exactly one diff per taskId in the union of both arms', () => {
    fc.assert(
      fc.property(snapshotSetArb, snapshotSetArb, (before, after) => {
        const diffs = diffClassifications(before, after);
        const union = new Set([...before, ...after].map((s) => s.taskId));
        expect(diffs).toHaveLength(union.size);
        expect(new Set(diffs.map((d) => d.taskId))).toEqual(union);
        // deterministic ordering (sorted)
        const ids = diffs.map((d) => d.taskId);
        expect([...ids].sort()).toEqual(ids);
      }),
    );
  });

  it('is SYMMETRIC: swapping arms mirrors before/after and preserves `changed`', () => {
    fc.assert(
      fc.property(snapshotSetArb, snapshotSetArb, (a, b) => {
        const fwd = diffClassifications(a, b);
        const rev = diffClassifications(b, a);
        expect(rev.map((d) => d.taskId)).toEqual(fwd.map((d) => d.taskId));
        for (let i = 0; i < fwd.length; i++) {
          expect(rev[i].changed).toBe(fwd[i].changed);
          expect(rev[i].beforeTier).toBe(fwd[i].afterTier);
          expect(rev[i].afterTier).toBe(fwd[i].beforeTier);
          expect(rev[i].beforeSteps).toBe(fwd[i].afterSteps);
          expect(rev[i].afterSteps).toBe(fwd[i].beforeSteps);
        }
      }),
    );
  });

  it('is REFLEXIVE: diffing a set against itself changes nothing', () => {
    fc.assert(
      fc.property(snapshotSetArb, (a) => {
        const diffs = diffClassifications(a, a);
        expect(countChanged(diffs)).toBe(0);
      }),
    );
  });

  it('`changed` is exactly (tier XOR boundary XOR sequence) differing', () => {
    const base: ClassificationSnapshot = {
      taskId: 't',
      riskTier: 'medium',
      boundaryTouching: false,
      verificationSequence: ['check_static_analysis', 'check_test_adequacy'],
    };
    // identical → unchanged
    expect(snapshotChanged(base, { ...base })).toBe(false);
    // tier differs
    expect(snapshotChanged(base, { ...base, riskTier: 'high' })).toBe(true);
    // boundary differs
    expect(snapshotChanged(base, { ...base, boundaryTouching: true })).toBe(true);
    // sequence differs
    expect(snapshotChanged(base, { ...base, verificationSequence: ['check_static_analysis'] })).toBe(true);
    // one side absent → changed
    expect(snapshotChanged(base, undefined)).toBe(true);
    expect(snapshotChanged(undefined, undefined)).toBe(false);
  });

  it('sequencesEqual is order-sensitive', () => {
    expect(sequencesEqual(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sequencesEqual(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sequencesEqual(['a'], ['a', 'b'])).toBe(false);
  });
});

// ─── Provenance stamping (task 003) ──────────────────────────────────────────

const CAUSAL_BEFORE: BinaryRef = {
  label: 'causal-before',
  arm: 'before',
  binaryTag: 'v2.12.0-preview.1',
  gitSha: '585c154cb978013b82264b8502d9226bb92ed49c',
  buildDate: '2026-07-09T18:50:14-07:00',
  has1659: true,
  has1669: false,
  binaryPath: '/tmp/1670-exp1/causal-before/dist/bin/exarchos-linux-x64',
};

describe('stampBinaryProvenance — task-001 shape, no ambient clock', () => {
  it('pins binaryTag/gitSha/date and the model-free sentinel', () => {
    const rec = stampBinaryProvenance(CAUSAL_BEFORE, 'before-arm (no planPath)');
    expect(rec.provenance.binaryTag).toBe('v2.12.0-preview.1');
    expect(rec.provenance.gitSha).toBe('585c154cb978013b82264b8502d9226bb92ed49c');
    expect(rec.provenance.date).toBe('2026-07-09T18:50:14-07:00');
    expect(rec.provenance.modelIds).toEqual(['none']);
    expect(rec.source).toBe('measured');
    expect(rec.has1669).toBe(false);
  });

  it('throws (never silently drops) when the git SHA is empty (DR-7 backstop)', () => {
    expect(() => stampBinaryProvenance({ ...CAUSAL_BEFORE, gitSha: '' }, 'x')).toThrow(ProvenanceError);
  });
});

describe('buildProvenanceArtifact — 4 stamped binaries + enumerated confounds', () => {
  it('stamps all four refs measured, and each survives assertMeasured', () => {
    const art = buildProvenanceArtifact();
    expect(art.binaries).toHaveLength(4);
    expect(art.binaries.map((b) => b.label).sort()).toEqual([
      'causal-after', 'causal-before', 'released-after', 'released-before',
    ]);
    for (const b of art.binaries) {
      expect(() => assertMeasured(b)).not.toThrow();
      expect(b.provenance.gitSha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('names #1669 (fix) and #1659 (confound) in the released window', () => {
    const art = buildProvenanceArtifact();
    const refs = art.releasedWindow.confounds.map((c) => c.ref);
    expect(refs).toContain('#1669');
    expect(refs).toContain('#1659');
    const confound = art.releasedWindow.confounds.find((c) => c.ref === '#1659');
    expect(confound?.role.toLowerCase()).toContain('confound');
    expect(art.causalPairIsolates).toContain('#1669');
  });

  it('the causal pair carries #1659 on BOTH arms (isolating #1669)', () => {
    const cb = EXP1_BINARY_REFS.find((r) => r.label === 'causal-before')!;
    const ca = EXP1_BINARY_REFS.find((r) => r.label === 'causal-after')!;
    expect(cb.has1659).toBe(true);
    expect(cb.has1669).toBe(false);
    expect(ca.has1659).toBe(true);
    expect(ca.has1669).toBe(true);
    // released-before has NEITHER — the confound source.
    const rb = EXP1_BINARY_REFS.find((r) => r.label === 'released-before')!;
    expect(rb.has1659).toBe(false);
    expect(rb.has1669).toBe(false);
    expect(RELEASED_WINDOW_CONFOUNDS.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── CSV emission (task 004) ─────────────────────────────────────────────────

describe('buildPairRows + toCsv', () => {
  const corpus: CorpusSpecTasks[] = [
    { specId: 'spec-a.md', specPath: '/x/spec-a.md', tasks: [{ id: '001', title: 't1' }] },
  ];
  const before: BinaryRef = { ...CAUSAL_BEFORE };
  const after: BinaryRef = {
    ...CAUSAL_BEFORE,
    label: 'causal-after',
    arm: 'after',
    gitSha: 'a240b4d84c932fcbe1fa8519fb8efbb04a2fa4d8',
    has1669: true,
  };

  it('emits one row per (pair, spec, task) with both binaries` SHAs for traceability', () => {
    const beforeRuns = new Map([
      ['spec-a.md', { ok: true as const, classifications: [{ taskId: '001', riskTier: 'medium', boundaryTouching: false, verificationSequence: ['check_static_analysis', 'check_test_adequacy'] }] }],
    ]);
    const afterRuns = new Map([
      ['spec-a.md', { ok: true as const, classifications: [{ taskId: '001', riskTier: 'high', boundaryTouching: true, verificationSequence: ['check_static_analysis', 'check_test_adequacy', 'check_integration_suite'] }] }],
    ]);
    const rows = buildPairRows('causal', before, after, beforeRuns, afterRuns, corpus);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.pair).toBe('causal');
    expect(r.spec).toBe('spec-a.md');
    expect(r.task).toBe('001');
    expect(r.beforeTier).toBe('medium');
    expect(r.afterTier).toBe('high');
    expect(r.beforeSteps).toBe(2);
    expect(r.afterSteps).toBe(3);
    expect(r.changed).toBe(true);
    expect(r.beforeSha).toBe('585c154cb978013b82264b8502d9226bb92ed49c');
    expect(r.afterSha).toBe('a240b4d84c932fcbe1fa8519fb8efbb04a2fa4d8');

    const csv = toCsv(rows);
    expect(csv.split('\n')[0]).toBe(CSV_COLUMNS.join(','));
    // No stray commas inside a field would corrupt the column count.
    expect(csv.trim().split('\n')[1].split(',')).toHaveLength(CSV_COLUMNS.length);
  });

  it('emits a fail-honest BLOCKED row (never a fabricated diff) when an arm did not dispatch', () => {
    const beforeRuns = new Map([
      ['spec-a.md', { ok: false as const, blocked: { reason: 'PHASE_BLOCKED', detail: 'x' } }],
    ]);
    const afterRuns = new Map([
      ['spec-a.md', { ok: true as const, classifications: [] }],
    ]);
    const rows = buildPairRows('causal', before, after, beforeRuns, afterRuns, corpus);
    expect(rows).toHaveLength(1);
    expect(rows[0].beforeTier).toBe('BLOCKED');
    expect(rows[0].changed).toBe(false);
  });
});

// ─── Corpus loading (harness) ────────────────────────────────────────────────

describe('loadCorpusTasks', () => {
  it('reduces a stamped spec to its {id,title} task list and skips unstamped docs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp1-corpus-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'stamped.md'),
        '### Task 001: Do a thing\n**Risk Tier:** high\n**Boundary Touching:** true\n\n### Task 002: Other\n**Risk Tier:** low\n',
      );
      fs.writeFileSync(path.join(dir, 'unstamped.md'), '# Notes\nno task headers here\n');
      const corpus = loadCorpusTasks(dir);
      expect(corpus).toHaveLength(1);
      expect(corpus[0].specId).toBe('stamped.md');
      expect(corpus[0].tasks.map((t) => t.id)).toEqual(['001', '002']);
      expect(corpus[0].tasks[0].title).toBe('Do a thing');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Real-binary integration (fixture pair) — spawns the built binaries ──────
//
// Skips when the throwaway Exp1 binaries are absent (they live under /tmp and
// are NOT committed — CI reproduces them via task 003's build steps). Present in
// the authoring environment, so this runs green there and documents the exact
// before→after contract #1669 changes at the binary boundary.

const BIN_DIR = process.env['EXP1_BINARIES_DIR'] ?? '/tmp/1670-exp1';
const beforeBin = path.join(BIN_DIR, 'causal-before/dist/bin/exarchos-linux-x64');
const afterBin = path.join(BIN_DIR, 'causal-after/dist/bin/exarchos-linux-x64');
const binariesPresent = fs.existsSync(beforeBin) && fs.existsSync(afterBin);

function seqHas(snap: ClassificationSnapshot | undefined, gate: string): boolean {
  return !!snap && snap.verificationSequence.includes(gate);
}

describe.skipIf(!binariesPresent)('Exp1 real-binary fixture pair (causal-before → causal-after)', () => {
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'exp1-integ-'));
  const serverRoot = path.join(workRoot, 'serverroot');
  const fixtureSpec = path.join(workRoot, 'fixture-spec.md');
  fs.writeFileSync(
    fixtureSpec,
    [
      '### Task 001: edit the shared event schema',
      '**Risk Tier:** high',
      '**Boundary Touching:** true',
      '**Test Layer:** integration',
      '',
      '### Task 002: add a small validation helper',
      '**Risk Tier:** medium',
      '',
    ].join('\n'),
  );
  const corpus: CorpusSpecTasks[] = [
    { specId: 'fixture-spec.md', specPath: fixtureSpec, tasks: [
      { id: '001', title: 'edit the shared event schema' },
      { id: '002', title: 'add a small validation helper' },
    ] },
  ];

  it('before-arm (no planPath) → heuristic medium/no-boundary; after-arm (planPath) → high/boundary + check_integration_suite', async () => {
    setupServerRoot(serverRoot);

    const beforeRef: BinaryRef = {
      label: 'causal-before', arm: 'before', binaryTag: 'v2.12.0-preview.1',
      gitSha: '585c154c', buildDate: '2026-07-09T18:50:14-07:00',
      has1659: true, has1669: false, binaryPath: beforeBin,
    };
    const afterRef: BinaryRef = {
      label: 'causal-after', arm: 'after', binaryTag: 'v2.12.0-preview.1',
      gitSha: 'a240b4d8', buildDate: '2026-07-09T21:14:09-07:00',
      has1659: true, has1669: true, binaryPath: afterBin,
    };

    const beforeRuns = await runArmOverCorpus(beforeRef, corpus, serverRoot);
    const afterRuns = await runArmOverCorpus(afterRef, corpus, serverRoot);

    const b = beforeRuns.get('fixture-spec.md');
    const a = afterRuns.get('fixture-spec.md');
    expect(b?.ok).toBe(true);
    expect(a?.ok).toBe(true);
    if (!b?.ok || !a?.ok) return;

    const b001 = b.classifications.find((c) => c.taskId === '001');
    const a001 = a.classifications.find((c) => c.taskId === '001');

    // before-arm: the stamp is invisible (no planPath) → heuristic medium/no-boundary,
    // and the high-tier-only check_integration_suite gate is ABSENT.
    expect(b001?.riskTier).toBe('medium');
    expect(b001?.boundaryTouching).toBe(false);
    expect(seqHas(b001, 'check_integration_suite')).toBe(false);

    // after-arm: the plan's stamp is lifted → high/boundary, WITH check_integration_suite.
    expect(a001?.riskTier).toBe('high');
    expect(a001?.boundaryTouching).toBe(true);
    expect(seqHas(a001, 'check_integration_suite')).toBe(true);

    // and the diff core flags task 001 as changed.
    const diffs = diffClassifications(b.classifications, a.classifications);
    expect(diffs.find((d) => d.taskId === '001')?.changed).toBe(true);

    fs.rmSync(workRoot, { recursive: true, force: true });
  });
});
