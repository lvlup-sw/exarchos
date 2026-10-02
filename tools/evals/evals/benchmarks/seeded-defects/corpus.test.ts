/**
 * The seeded-defect corpus: the loader and the derived-tier contract.
 *
 * Each class holds at least five defects and five controls, and the loader is deterministic and offline.
 * Each manifest declares `{gate, defectMechanism, expectedVerdict, riskTier, boundaryTouching}`. The
 * production classifier derives the tier stamps, so a hand-assigned tier fails. The tsconfig and lint
 * exclusions keep the broken fixtures out of repo CI.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
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
/** The repository root. It is the same directory as `MCP_ROOT`. */
const REPO_ROOT = MCP_ROOT;

describe('seeded-defect corpus', () => {
  it('SeededCorpus_EveryClass_HasFiveDefectsAndFiveControls', () => {
    for (const gateClass of SEEDED_GATE_CLASSES) {
      const fixtures = loadSeededCorpus(gateClass);
      const defects = fixtures.filter((f) => f.kind === 'defect');
      const controls = fixtures.filter((f) => f.kind === 'control');
      expect(defects.length, `${gateClass} defects`).toBeGreaterThanOrEqual(5);
      expect(controls.length, `${gateClass} controls`).toBeGreaterThanOrEqual(5);
      expect(fixtures.every((f) => f.gateClass === gateClass)).toBe(true);
    }
    expect(SEEDED_GATE_CLASSES).toHaveLength(6);
    expect(loadSeededCorpus().length).toBeGreaterThanOrEqual(60);
  });

  /**
   * Two loads give identical output. Mechanical classes come first in table order, and `dropped-edge-case`
   * comes last. The fixtures directory holds only JSON, so the loader needs no compile or spawn step.
   */
  it('SeededCorpus_Load_DeterministicAndOffline', () => {
    const a = loadSeededCorpus();
    const b = loadSeededCorpus();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));

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

    const assetFiles = fs.readdirSync(FIXTURES_DIR);
    expect(assetFiles.every((f) => f.endsWith('.json'))).toBe(true);
  });

  /**
   * `gate` is the orchestrate action of the class, and null for `dropped-edge-case`. `expectedVerdict` is
   * `fail` for a defect, `pass` for a control, and `ungated` for the hidden-oracle class.
   */
  it('SeededCorpus_Manifest_DeclaresGateMechanismVerdict', () => {
    for (const f of loadSeededCorpus()) {
      const m = f.manifest;
      expect(m.gate).toBe(GATE_FOR_CLASS[f.gateClass]);
      expect(typeof m.defectMechanism).toBe('string');
      expect(m.defectMechanism.length).toBeGreaterThan(0);
      if (f.gateClass === 'dropped-edge-case') {
        expect(m.expectedVerdict).toBe('ungated');
        expect(m.gate).toBeNull();
      } else if (f.kind === 'defect') {
        expect(m.expectedVerdict).toBe('fail');
      } else {
        expect(m.expectedVerdict).toBe('pass');
      }
      expect(['low', 'medium', 'high']).toContain(m.riskTier);
      expect(typeof m.boundaryTouching).toBe('boolean');
    }
  });

  /**
   * The manifest tiers equal what the production classifier derives from the changed files of each fixture.
   * That check uses the same functions, so it cannot catch a hand-assigned tier. The test therefore also
   * requires that no fixture JSON holds a tier field.
   */
  it('SeededCorpus_TierStamps_MatchProductionClassifierDerivation', () => {
    for (const f of loadSeededCorpus()) {
      const files = [...f.changedFiles];
      const expectedTier = deriveRiskTier({ id: f.id, title: '', files });
      const expectedBoundary = deriveBoundaryTouching({ id: f.id, title: '', files });
      expect(f.manifest.riskTier, `${f.id} riskTier`).toBe(expectedTier);
      expect(f.manifest.boundaryTouching, `${f.id} boundaryTouching`).toBe(expectedBoundary);
      expect(f.changedFiles).toEqual(computeChangedFiles(f.base, f.head));
      expect(f.changedFiles.length).toBeGreaterThan(0);
    }
    const sample = deriveManifestTiers(['contracts/openapi.json']);
    expect(sample.riskTier).toBe('high');
    expect(sample.boundaryTouching).toBe(true);

    for (const file of fs.readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json'))) {
      const raw = fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      expect(raw, `${file} must not hand-assign riskTier`).not.toMatch(/"riskTier"/);
      expect(raw, `${file} must not hand-assign boundaryTouching`).not.toMatch(/"boundaryTouching"/);
    }
  });

  /**
   * The defect tiers differ by class: `contract-drift` derives high and `test-adequacy` derives medium.
   * `boundaryTouching` also varies across the corpus.
   */
  it('SeededCorpus_DefectClasses_SpanMultipleTiers', () => {
    const defectTiers = new Set(
      loadSeededCorpus()
        .filter((f) => f.kind === 'defect')
        .map((f) => f.manifest.riskTier),
    );
    expect(defectTiers.size).toBeGreaterThanOrEqual(2);

    const tierOfClass = (c: string): string =>
      loadSeededCorpus(c as SeededFixture['gateClass'])[0].manifest.riskTier;
    expect(tierOfClass('contract-drift')).toBe('high');
    expect(tierOfClass('test-adequacy')).toBe('medium');

    const boundaries = new Set(loadSeededCorpus().map((f) => f.manifest.boundaryTouching));
    expect(boundaries).toEqual(new Set([true, false]));
  });

  /**
   * `tsconfig.json` excludes the fixtures tree and ESLint ignores it. The exclusion matters: the tree holds no
   * TypeScript source, and a static-analysis defect carries broken source that fails CI when compiled.
   */
  it('SeededCorpus_FixtureAssets_ExcludedFromTypecheckAndLint', async () => {
    const tsconfig = JSON.parse(fs.readFileSync(path.join(MCP_ROOT, 'tsconfig.json'), 'utf-8')) as {
      exclude?: string[];
    };
    const excludesFixtures = (tsconfig.exclude ?? []).some((g) =>
      g.includes('seeded-defects/fixtures'),
    );
    expect(excludesFixtures, 'tsconfig.exclude must cover seeded-defects/fixtures').toBe(true);

    const eslint = new ESLint({ cwd: REPO_ROOT });
    expect(await eslint.isPathIgnored(path.join(FIXTURES_DIR, 'probe.ts'))).toBe(true);
    expect(await eslint.isPathIgnored(path.join(HERE, 'probe.ts'))).toBe(false);

    const assetFiles = fs.readdirSync(FIXTURES_DIR);
    expect(assetFiles.some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))).toBe(false);

    const staticDefects = loadSeededCorpus('static-analysis').filter((f) => f.kind === 'defect');
    const brokenContent = staticDefects.some((f) =>
      Object.values(f.head).some((src) => /"oops;|1 \+ ;|\bconst a = 1;[\s\S]*const a = 2;| @;| \]/.test(src)),
    );
    expect(brokenContent, 'a static-analysis defect must carry real broken source').toBe(true);
  });

  /**
   * The hidden oracle of the `dropped-edge-case` class detects each defect and passes each control. No
   * production gate catches this class.
   */
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
