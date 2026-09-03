/**
 * One root for evidence artifacts, kept by a census rather than a comment.
 *
 * A `ContentAddressedStore` reference carries a digest and no root, so a
 * producer and a reader that construct the store two different ways are
 * indistinguishable, from the reference's own point of view, from a blob that
 * was never written — the two gate-evidence producers used to disagree on
 * the root this way, and this pass gave them one shared constructor. This
 * walks the shipped tree for every direct `ContentAddressedStore`
 * construction and requires each one to be a named, reasoned-about owner.
 *
 * The vacuity guard: a scan that stopped finding construction sites at all
 * would report zero violations and read as a clean tree. The scanned
 * population is corroborated against `git ls-files`, the site count is
 * asserted non-empty against a measured floor, and the seeded-module case
 * proves the walk actually reaches and names a real file on disk rather than
 * a row spliced into a value the test already controls.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { scanEvidenceStoreConstructions } from '../../tools/test-helpers/evidence-store-construction-census.js';
import { listTrackedFiles } from '../../tools/test-helpers/tracked-population.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'src');

/**
 * Every module allowed to construct a `ContentAddressedStore` directly, and
 * why. Anything else that constructs one is a second, disagreeing root.
 */
const OWNERS: readonly string[] = [
  // The sanctioned evidence-artifact constructor every admission producer
  // and reader binds through.
  'src/workflow/admission/evidence-artifact.ts',
  // A different subject entirely — run bundles, not admission evidence —
  // already root-owned by its own directory-name constant.
  'src/events/bundle/run-bundle-store.ts',
  // A throwaway `mkdtemp` root inside a self-contained witness. It reads and
  // writes nothing a durable-evidence check ever consults, so it names no
  // custody this census protects.
  'src/verbs/gates/gate-ownership-census.ts',
];

describe('EvidenceStoreConstructionCensus — one root for evidence artifacts', () => {
  it('Census_ScannedPopulation_IsNotVacuous', () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    expect(census.scannedModuleCount).toBeGreaterThan(300);

    const tracked = listTrackedFiles(REPO_ROOT, {
      exclude: (file) => !file.startsWith('src/') || file.endsWith('.test.ts'),
    });
    expect(tracked.length).toBeGreaterThan(0);
    // Second authority: a scanner that lost most of the tree would still
    // report a plausible-looking count on its own. Agreement with `git
    // ls-files` is what rules that out.
    expect(census.scannedModuleCount).toBe(tracked.length);
  });

  it('Census_EveryProductionConstruction_IsOwned', () => {
    const census = scanEvidenceStoreConstructions(REPO_ROOT, {
      sourceDir: SOURCE_DIR,
      owners: OWNERS,
    });
    // Denominator, asserted non-empty: a walk that found zero construction
    // sites at all would pass the next assertion vacuously. The three owners
    // above each construct the store at least once — the measured floor.
    expect(census.sites.length).toBeGreaterThanOrEqual(4);
    expect(
      census.unowned,
      'every construction outside the allowlist must bind through evidenceArtifactStore() instead',
    ).toEqual([]);
  });

  it('Census_BothEvidenceProducers_BindToTheRootConstant', () => {
    // The half a construction-site scan cannot see on its own: a producer
    // could call the shared helper AND still carry a stray literal root
    // somewhere else in the same file. Read the source directly.
    for (const file of [
      'src/verbs/gates/durable-gate-producer.ts',
      'src/verbs/gates/gate-runner.ts',
    ]) {
      const source = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).toContain('evidenceArtifactStore(');
      expect(source, file).not.toContain("'admission-evidence'");
      expect(source, file).not.toContain("'gate-evidence'");
    }
  });

  it('Census_SeededModuleOnDisk_IsWalkedAndNamed', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'exarchos-evidence-census-'));
    try {
      const sourceDir = path.join(root, 'src');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(
        path.join(sourceDir, 'seeded-evidence-store.ts'),
        [
          "export const s = new ContentAddressedStore(join(stateDir, 'admission-evidence'));",
          '',
        ].join('\n'),
        'utf8',
      );

      const seeded = scanEvidenceStoreConstructions(root, { sourceDir, owners: [] });
      expect(seeded.scannedModuleCount).toBe(1);
      expect(seeded.unowned.length).toBe(1);
      expect(seeded.unowned[0]?.file).toBe('src/seeded-evidence-store.ts');
      expect(seeded.unowned[0]?.text).toContain('new ContentAddressedStore(');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
