/**
 * Lint for catalog-registration gating over the `content/` source tree.
 * Registration in `invariants.catalogs` is the only opt-in for the dev-invariants catalog (see `src/architecture/catalog-sources.ts`).
 * The lint reads the sources, not the rendered variants that `build:skills` generates from them.
 *
 * 1. No tracked Markdown source names the retired `devCatalog` key, in any letter case.
 * 2. Each source that gates a Constraints step on the catalog names catalog registration as the gate.
 *
 * The two authorities are independent. `git ls-files` gives the population of sources.
 * The discriminant for a gated source is the catalog path together with a Constraints step.
 * Neither signal is the registration vocabulary that the second assertion checks, so the assertion can fail.
 * @oracle-sources: git ls-files over skills-src/, the catalog-path + Constraints-step discriminant read from each source
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileAsync } from '../../../tools/test-helpers/spawn.js';

const SKILLS_SRC = join(process.cwd(), 'content');

const CATALOG_REGISTRATION_RE =
  /invariants\.catalogs|catalog[- ]registration|catalog is registered|no catalog is registered/i;

/** The dev-invariants catalog a gated Constraints step anchors to. */
const CATALOG_PATH_RE = /\.exarchos\/invariants\.md/;

/** A Constraints step — the surface the catalog gate applies to. */
const CONSTRAINTS_STEP_RE = /\bConstraints\b/;

/**
 * Returns each Markdown source that git tracks under `content/`.
 * `git ls-files` does not know which files this lint selects, so it is an independent authority.
 * The function throws on an empty list, because both sweeps pass on an empty corpus.
 */
async function trackedSkillSources(): Promise<string[]> {
  const stdout = await execFileAsync('git', ['ls-files', '-z', '--', '*.md'], {
    cwd: SKILLS_SRC,
  });
  const files = stdout.split('\0').filter((line) => line.length > 0).sort();
  if (files.length === 0) {
    throw new Error(
      `no markdown source tracked under ${SKILLS_SRC} — the corpus is empty, so ` +
        'every sweep over it would pass for the wrong reason',
    );
  }
  return files;
}

const read = (file: string): string => readFileSync(join(SKILLS_SRC, file), 'utf8');

/** Sources that anchor a Constraints step to the dev-invariants catalog. */
function catalogGatedSources(files: readonly string[]): string[] {
  return files.filter((file) => {
    const content = read(file);
    return CATALOG_PATH_RE.test(content) && CONSTRAINTS_STEP_RE.test(content);
  });
}

describe('catalog-registration gating lint (DR-33)', () => {
  /** The claim is about the whole tree, so the sweep reads every tracked source. */
  it('SkillsSrc_NoSourceAnywhereMentionsTheRetiredDevCatalogFlag', async () => {
    const files = await trackedSkillSources();
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) => /devCatalog/i.test(read(file)));
    expect(
      offenders,
      'these skills-src sources instruct the reader to set `invariants.devCatalog`, ' +
        'a flag DR-31/T-43 retired — re-point them at `invariants.catalogs` registration',
    ).toEqual([]);
  });

  /**
   * The gated set must be non-empty, because an empty set makes the assertion vacuous.
   * It must also be smaller than the whole tree.
   */
  it('SkillsSrc_EveryCatalogGatedSource_ExpressesTheRegistrationGate', async () => {
    const files = await trackedSkillSources();
    const gated = catalogGatedSources(files);

    expect(
      gated.length,
      'no skills-src source was identified as catalog-gated — the discriminant ' +
        'stopped matching, so this lint is asserting nothing',
    ).toBeGreaterThan(0);
    expect(gated.length).toBeLessThan(files.length);

    const missing = gated.filter((file) => !CATALOG_REGISTRATION_RE.test(read(file)));
    expect(
      missing,
      'these sources gate a Constraints step on the dev-invariants catalog but ' +
        'never say the gate is catalog REGISTRATION — a reader is left without ' +
        'the opt-in condition',
    ).toEqual([]);
  });

  /**
   * If the discriminant is the registration vocabulary, it selects only sources that pass, and the gate assertion cannot fail.
   * The discriminant here is the catalog path and a Constraints step, and neither is `CATALOG_REGISTRATION_RE`.
   * Synthetic text shows this, so the proof does not depend on the live corpus.
   */
  it('SkillsSrcGating_DiscriminantIsIndependentOfTheAssertedVocabulary', () => {
    const gatedButSilent = 'Load `.exarchos/invariants.md` and emit Constraints before the brief.';
    expect(CATALOG_PATH_RE.test(gatedButSilent) && CONSTRAINTS_STEP_RE.test(gatedButSilent)).toBe(
      true,
    );
    expect(
      CATALOG_REGISTRATION_RE.test(gatedButSilent),
      'a source can be selected by the discriminant and still FAIL the assertion — ' +
        'which is what makes the assertion capable of failing at all',
    ).toBe(false);
  });

  /**
   * The population comes from the tree. When a source starts to gate on the catalog, it enters the population.
   * The corpus must be more than two times the size of the gated set.
   */
  it('SkillsSrcGating_PopulationTracksTheTree_NotATranscribedList', async () => {
    const files = await trackedSkillSources();
    const gated = catalogGatedSources(files);

    expect(files.length).toBeGreaterThan(gated.length * 2);

    for (const file of gated) {
      expect(file.endsWith('.md')).toBe(true);
      expect(read(file).length).toBeGreaterThan(0);
    }
  });
});
