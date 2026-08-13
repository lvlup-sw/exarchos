// ─── Seeded-defect corpus — loader + derived-tier contract (#1675, task 003) ──
//
// Verifies the DR-2 acceptance criteria: ≥5 seeded defects + ≥5 controls per
// class, a deterministic/offline loader, the `{gate,defectMechanism,
// expectedVerdict,riskTier,boundaryTouching}` manifest, tier stamps DERIVED by
// the production classifier (never hand-assigned), a multi-tier span, and the
// tsconfig/lint exclusion that keeps intentionally-broken fixtures off repo CI.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSeededCorpus,
  deriveManifestTiers,
  runDroppedEdgeOracle,
  computeChangedFiles,
  SEEDED_GATE_CLASSES,
  MECHANICAL_GATE_CLASSES,
  GATE_FOR_CLASS,
  type SeededFixture,
} from './corpus.js';
import {
  deriveRiskTier,
  deriveBoundaryTouching,
} from '../../../../../src/verbs/team/prepare-delegation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');
const MCP_ROOT = path.resolve(HERE, '../../../../..');
const REPO_ROOT = path.resolve(MCP_ROOT, '../..');

describe('seeded-defect corpus', () => {
  it('SeededCorpus_EveryClass_HasFiveDefectsAndFiveControls', () => {
    for (const gateClass of SEEDED_GATE_CLASSES) {
      const fixtures = loadSeededCorpus(gateClass);
      const defects = fixtures.filter((f) => f.kind === 'defect');
      const controls = fixtures.filter((f) => f.kind === 'control');
      expect(defects.length, `${gateClass} defects`).toBeGreaterThanOrEqual(5);
      expect(controls.length, `${gateClass} controls`).toBeGreaterThanOrEqual(5);
      // every fixture belongs to the requested class
      expect(fixtures.every((f) => f.gateClass === gateClass)).toBe(true);
    }
    // Six classes total, 60 fixtures at the floor.
    expect(SEEDED_GATE_CLASSES).toHaveLength(6);
    expect(loadSeededCorpus().length).toBeGreaterThanOrEqual(60);
  });

  it('SeededCorpus_Load_DeterministicAndOffline', () => {
    // Two independent loads must be byte-for-byte identical (no clock, no rng,
    // no network, no temp dirs) — the offline determinism contract.
    const a = loadSeededCorpus();
    const b = loadSeededCorpus();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

    // Stable ordering: mechanical classes first (in table order), dropped-edge
    // last; within a class, defects before controls.
    const classOrder = a.map((f) => f.gateClass);
    const firstIndexOf = (c: string) => classOrder.indexOf(c);
    for (let i = 1; i < MECHANICAL_GATE_CLASSES.length; i++) {
      expect(firstIndexOf(MECHANICAL_GATE_CLASSES[i])).toBeGreaterThan(
        firstIndexOf(MECHANICAL_GATE_CLASSES[i - 1]),
      );
    }
    expect(firstIndexOf('dropped-edge-case')).toBe(
      Math.max(...SEEDED_GATE_CLASSES.map(firstIndexOf)),
    );

    // The loader touches only the committed JSON assets — a `.ts`/`.js` fixture
    // (which a compile/spawn step would need) must not exist. This makes the
    // "no compiled TypeScript / offline" claim structural, not aspirational.
    const assetFiles = fs.readdirSync(FIXTURES_DIR);
    expect(assetFiles.every((f) => f.endsWith('.json'))).toBe(true);
  });

  it('SeededCorpus_Manifest_DeclaresGateMechanismVerdict', () => {
    for (const f of loadSeededCorpus()) {
      const m = f.manifest;
      // gate: the exact orchestrate action for the class (null for dropped-edge).
      expect(m.gate).toBe(GATE_FOR_CLASS[f.gateClass]);
      // defectMechanism: a non-empty human description.
      expect(typeof m.defectMechanism).toBe('string');
      expect(m.defectMechanism.length).toBeGreaterThan(0);
      // expectedVerdict: fail for defects, pass for controls, ungated for the
      // hidden-oracle class.
      if (f.gateClass === 'dropped-edge-case') {
        expect(m.expectedVerdict).toBe('ungated');
        expect(m.gate).toBeNull();
      } else if (f.kind === 'defect') {
        expect(m.expectedVerdict).toBe('fail');
      } else {
        expect(m.expectedVerdict).toBe('pass');
      }
      // tier stamps are present and well-typed.
      expect(['low', 'medium', 'high']).toContain(m.riskTier);
      expect(typeof m.boundaryTouching).toBe('boolean');
    }
  });

  it('SeededCorpus_TierStamps_MatchProductionClassifierDerivation', () => {
    // Anti-pinning contract: the manifest tiers must be EXACTLY what the
    // production classifier derives from the fixture's real changed file paths —
    // never a hand-typed value. Re-derive independently and compare.
    for (const f of loadSeededCorpus()) {
      const files = [...f.changedFiles];
      const expectedTier = deriveRiskTier({ id: f.id, title: '', files });
      const expectedBoundary = deriveBoundaryTouching({ id: f.id, title: '', files });
      expect(f.manifest.riskTier, `${f.id} riskTier`).toBe(expectedTier);
      expect(f.manifest.boundaryTouching, `${f.id} boundaryTouching`).toBe(expectedBoundary);
      // changedFiles itself is the base→head diff (what a real git diff sees).
      expect(f.changedFiles).toEqual(computeChangedFiles(f.base, f.head));
      // and it is non-empty (a fixture with no diff would derive a meaningless tier)
      expect(f.changedFiles.length).toBeGreaterThan(0);
    }
    // deriveManifestTiers is the single derivation seam the loader uses.
    const sample = deriveManifestTiers(['contracts/openapi.json']);
    expect(sample.riskTier).toBe('high');
    expect(sample.boundaryTouching).toBe(true);

    // STRUCTURAL anti-pinning guarantee (stronger than the derivation-equality
    // check above, which re-derives with the same functions and so cannot catch
    // a hand-assignment regression): the raw fixture JSON assets carry NO tier
    // fields at all, so a tier physically cannot be hand-typed into the corpus.
    for (const file of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))) {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      expect(raw, `${file} must not hand-assign riskTier`).not.toMatch(/"riskTier"/);
      expect(raw, `${file} must not hand-assign boundaryTouching`).not.toMatch(/"boundaryTouching"/);
    }
  });

  it('SeededCorpus_DefectClasses_SpanMultipleTiers', () => {
    const defectTiers = new Set(
      loadSeededCorpus()
        .filter((f) => f.kind === 'defect')
        .map((f) => f.manifest.riskTier),
    );
    // The classifier-derived tiers span more than one lane, so downstream policy
    // replay exercises real routing variation rather than a single-tier corpus.
    expect(defectTiers.size).toBeGreaterThanOrEqual(2);

    // Concretely: the schema-boundary contract class derives HIGH, the source
    // classes derive MEDIUM — a genuine span, not an accident of one class.
    const tierOfClass = (c: string): string =>
      loadSeededCorpus(c as SeededFixture['gateClass'])[0].manifest.riskTier;
    expect(tierOfClass('contract-drift')).toBe('high');
    expect(tierOfClass('test-adequacy')).toBe('medium');

    // Boundary-touching also varies across classes (orthogonal to tier).
    const boundaries = new Set(loadSeededCorpus().map((f) => f.manifest.boundaryTouching));
    expect(boundaries).toEqual(new Set([true, false]));
  });

  it('SeededCorpus_FixtureAssets_ExcludedFromTypecheckAndLint', () => {
    // (1) tsconfig `exclude` names the fixtures tree, so `tsc --noEmit` never
    // reaches intentionally type-broken content.
    const tsconfig = JSON.parse(fs.readFileSync(path.join(MCP_ROOT, 'tsconfig.json'), 'utf-8')) as {
      exclude?: string[];
    };
    const excludesFixtures = (tsconfig.exclude ?? []).some((g) =>
      g.includes('seeded-defects/fixtures'),
    );
    expect(excludesFixtures, 'tsconfig.exclude must cover seeded-defects/fixtures').toBe(true);

    // (2) the eslint config ignores the fixtures tree.
    const eslintConfig = fs.readFileSync(path.join(REPO_ROOT, 'eslint.config.js'), 'utf-8');
    expect(eslintConfig).toContain('seeded-defects/fixtures');

    // (3) load-bearing check — the exclusion actually matters: the fixtures dir
    // holds NO compilable source (only JSON), AND at least one fixture carries
    // genuinely type/lint-broken content that WOULD fail CI if it were compiled.
    const assetFiles = fs.readdirSync(FIXTURES_DIR);
    expect(assetFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))).toBe(false);

    const staticDefects = loadSeededCorpus('static-analysis').filter((f) => f.kind === 'defect');
    const brokenContent = staticDefects.some((f) =>
      Object.values(f.head).some((src) => /"oops;|1 \+ ;|\bconst a = 1;[\s\S]*const a = 2;| @;| \]/.test(src)),
    );
    expect(brokenContent, 'a static-analysis defect must carry real broken source').toBe(true);
  });

  // Hidden-oracle detector (dropped-edge-case class): it catches what no
  // production gate can. Defects trip the oracle; controls pass it.
  it(
    'SeededCorpus_DroppedEdgeOracle_DetectsDefectNotControl',
    () => {
      const dropped = loadSeededCorpus('dropped-edge-case');
      for (const f of dropped) {
        const outcome = runDroppedEdgeOracle(f);
        if (f.kind === 'defect') {
          expect(outcome.detected, `${f.id} oracle should DETECT the dropped edge`).toBe(true);
          expect(outcome.failures.length).toBeGreaterThan(0);
        } else {
          expect(outcome.detected, `${f.id} oracle should PASS the control`).toBe(false);
          expect(outcome.failures).toHaveLength(0);
        }
      }
    },
    60_000,
  );
});
