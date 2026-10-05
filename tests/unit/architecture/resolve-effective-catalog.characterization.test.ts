// Characterization oracle for the effective catalog that the real repository config resolves.
//
// The subject is `resolveEffectiveCatalog`. The tests drive it with the real `.exarchos.yml`,
// validated through `FullExarchosConfigSchema`.
// The expectation is an independent derivation in this file. It slices the frontmatter of
// `.exarchos/invariants.md` by hand and applies the affinity rules.
// It shares no code with `loadInvariants`, `resolveCatalogSources` or `projectCatalog`, so the two can disagree.
//
// The tests assert that the catalog is the same with and without the `invariants.devCatalog` flag.
// The comparison covers each id that the dev catalog file declares.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveEffectiveCatalog } from '../../../src/architecture/resolve-effective-catalog.js';
import type { ExarchosConfigInput } from '../../../src/config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';

/** The repository root. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..');
const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');
const DEV_CATALOG_FILE = path.join(REPO_ROOT, '.exarchos', 'invariants.md');

/**
 * The projection key of the comparison. `ideate` with `feature` is a broad working set.
 * It keeps each dev entry whose affinity does not exclude it.
 */
const PHASE = 'ideate';
const WORKFLOW_TYPE = 'feature';

/** A loose view of the `invariants:` block. A variant can add or remove a key that the schema type does not hold. */
type InvariantsBlock = Record<string, unknown>;

/** Reads the real `.exarchos.yml` from disk and validates it with the production schema. */
function readRealRepoInvariantsBlock(): InvariantsBlock {
  expect(
    fs.existsSync(REPO_CONFIG_PATH),
    `real repo config missing at ${REPO_CONFIG_PATH}`,
  ).toBe(true);
  const doc: unknown = parseYaml(fs.readFileSync(REPO_CONFIG_PATH, 'utf8'));
  const parsed = FullExarchosConfigSchema.safeParse(doc);
  expect(
    parsed.success,
    `real .exarchos.yml failed the production config schema: ` +
      (parsed.success ? '' : JSON.stringify(parsed.error.issues)),
  ).toBe(true);
  if (!parsed.success) throw new Error('unreachable');
  const invariants = parsed.data.invariants;
  expect(
    invariants,
    'real .exarchos.yml declares no `invariants:` block — the subject of this ' +
      'oracle does not exist',
  ).toBeDefined();
  return structuredClone(invariants) as InvariantsBlock;
}

/** Build a config from an invariants block, mutated by `mutate`. */
function configWith(
  block: InvariantsBlock,
  mutate: (b: InvariantsBlock) => void,
): ExarchosConfigInput {
  const next = structuredClone(block);
  mutate(next);
  return { invariants: next } as ExarchosConfigInput;
}

/**
 * Returns the ids that the production pipeline resolves and that the dev catalog file declares.
 * `resolveEffectiveCatalog` turns a load error into a warning, so this function asserts that no warning exists.
 * An unexpected warning weakens every assertion that uses the result.
 */
function resolveDevLayerIds(config: ExarchosConfigInput): string[] {
  const { entries, warnings } = resolveEffectiveCatalog({
    config,
    phase: PHASE,
    workflowType: WORKFLOW_TYPE,
  });
  expect(warnings, 'resolver degraded a layer instead of loading it').toEqual([]);
  const universe = declaredCatalogIds();
  return entries
    .map((e) => e.id)
    .filter((id) => universe.has(id))
    .sort();
}

/**
 * Returns each entry that the dev catalog file declares. The parse slices the frontmatter by hand
 * and uses `yaml`, so it is independent of `loadInvariants`.
 */
function declaredCatalogEntries(): Array<Record<string, unknown>> {
  const md = fs.readFileSync(DEV_CATALOG_FILE, 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  expect(match, `no YAML frontmatter found in ${DEV_CATALOG_FILE}`).not.toBeNull();
  const frontmatter = parseYaml(match![1]) as {
    invariants?: Array<Record<string, unknown>>;
  };
  const entries = frontmatter.invariants;
  expect(Array.isArray(entries), 'dev catalog frontmatter has no invariants[]').toBe(
    true,
  );
  return entries!;
}

function declaredCatalogIds(): Set<string> {
  return new Set(declaredCatalogEntries().map((e) => String(e.id)));
}

/**
 * Returns the expected projected ids, computed here from the affinity rules without `projectCatalog`.
 * An absent `phase-affinity` matches every phase, and a present one must list the phase.
 * `workflow-affinity` obeys the same rule for the workflow type.
 */
function independentlyProjectedIds(): string[] {
  return declaredCatalogEntries()
    .filter((entry) => {
      const phaseAffinity = entry['phase-affinity'];
      if (Array.isArray(phaseAffinity) && !phaseAffinity.includes(PHASE)) {
        return false;
      }
      const workflowAffinity = entry['workflow-affinity'];
      if (
        Array.isArray(workflowAffinity) &&
        !workflowAffinity.includes(WORKFLOW_TYPE)
      ) {
        return false;
      }
      return true;
    })
    .map((entry) => String(entry.id))
    .sort();
}

describe('resolveEffectiveCatalog — real-repo-config characterization (DR-31 / T-41)', () => {
  /** The floor on `expected` matters: an empty expectation equals the output of a resolver that returns nothing. */
  it('RealRepoConfig_EffectiveCatalog_MatchesIndependentlyDerivedCatalog', () => {
    const block = readRealRepoInvariantsBlock();
    const resolved = resolveDevLayerIds({ invariants: block } as ExarchosConfigInput);
    const expected = independentlyProjectedIds();

    expect(expected.length).toBeGreaterThan(0);
    expect(resolved).toEqual(expected);
  });

  /**
   * The acceptance property of the `devCatalog` retirement, asserted in both directions.
   * One of the two variants always differs from the committed file, with the flag or without it.
   * The pair must differ, or the equality is a tautology.
   */
  it('RealRepoConfig_DevCatalogFlagPresentOrAbsent_ResolvesIdenticalCatalog', () => {
    const block = readRealRepoInvariantsBlock();
    const withFlag = configWith(block, (b) => {
      b.devCatalog = 'enabled';
    });
    const withoutFlag = configWith(block, (b) => {
      delete b.devCatalog;
    });

    expect(withFlag).not.toEqual(withoutFlag);

    const expected = independentlyProjectedIds();
    expect(resolveDevLayerIds(withFlag)).toEqual(expected);
    expect(resolveDevLayerIds(withoutFlag)).toEqual(expected);
  });

  /**
   * Sensitivity proof. Without the `catalogs:` registration and without the flag, the dev layer is empty.
   * Without this case, a resolver that ignores the config also satisfies the equality tests.
   */
  it('RealRepoConfig_NoRegistrationAndNoFlag_ResolvesEmptyDevLayer', () => {
    const block = readRealRepoInvariantsBlock();
    const stripped = configWith(block, (b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(resolveDevLayerIds(stripped)).toEqual([]);
    expect(independentlyProjectedIds()).not.toEqual([]);
  });
});
