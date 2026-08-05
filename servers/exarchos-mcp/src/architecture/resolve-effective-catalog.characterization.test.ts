import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveEffectiveCatalog } from './resolve-effective-catalog.js';
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../config/yaml-schema.js';

/**
 * Characterization oracle for the DR-31 `devCatalog` retirement (T-41).
 *
 * ## Why this file was re-bound (oracle-integrity callout, T-41)
 *
 * The previous version of this file was NOT a valid oracle for the change it
 * claimed to guard. It had two defects:
 *
 *   (a) its subject was a HAND-BUILT config — `{ invariants: { devCatalog:
 *       'enabled' } }` with **no `catalogs:` entry**. That is a config this
 *       repository does not use: the real `.exarchos.yml` carries BOTH the
 *       sugar and the canonical explicit `catalogs: [{ path:
 *       .exarchos/invariants.md, tier: dev }]` registration. Pinning the
 *       hand-built shape could not tell anyone what happens to the REAL repo
 *       when the boolean is dropped.
 *   (b) its expectation was a vitest auto-snapshot of the subject's own
 *       output — a single-source comparison (the Class B shape DR-30 forbids).
 *       An auto-snapshot cannot disagree with the code that produced it; it
 *       only detects change, and it is re-baselined by `-u` without review.
 *
 * ## What this file asserts now — TWO INDEPENDENT AUTHORITIES (DR-30)
 *
 *   - **Authority 1 (subject):** the production pipeline
 *     `resolveEffectiveCatalog(...)` driven by the REAL `.exarchos.yml` read
 *     from disk and validated through the same `FullExarchosConfigSchema` the
 *     production config reader uses.
 *   - **Authority 2 (expectation):** an INDEPENDENT re-derivation of the
 *     expected id set, computed in this file from a hand-sliced parse of the
 *     `.exarchos/invariants.md` frontmatter plus a projection predicate
 *     written from the DR-5 affinity spec. It shares no code with
 *     `loadInvariants` (which parses via `gray-matter`), with
 *     `resolveCatalogSources`, or with `projectCatalog`.
 *
 * The two authorities can disagree, which is what makes this an oracle rather
 * than a tautology: if the resolver stops loading the registered dev source,
 * authority 1 goes empty while authority 2 keeps returning the file's
 * projected ids.
 *
 * ## The property T-42 / T-43 rely on
 *
 * DR-31 removes `invariants.devCatalog` from `.exarchos.yml`. The acceptance
 * criterion is: *the effective catalog resolved from the real repo config
 * before and after removal is identical.* That equality is asserted directly
 * below, in BOTH metamorphic directions (flag present / flag absent), so the
 * assertion stays load-bearing whether it runs before or after T-43 edits the
 * file on disk.
 *
 * ## Behavior re-baseline vs the retired golden — deliberate, not a regression
 *
 * The committed `__snapshots__` golden listed 8 ids (INV-5b, INV-5c, INV-7,
 * INV-8, INV-9, INV-10, INV-12, INV-15). It was produced by filtering the
 * projected entries down to the `INV-` id prefix, which silently DROPPED the
 * dev-catalog entry `basileus-boundary` — a real member of the effective
 * catalog at (`ideate`, `feature`). The re-bound oracle scopes the comparison
 * by SOURCE (every id declared in the dev catalog file) instead of by id
 * prefix, so the guarded set is 9 ids, not 8. The retired snapshot file is
 * deleted with this change: it pinned the hand-built-config behavior and is
 * not the golden for the real-config subject.
 */

/** Repo root — four levels up from `src/architecture/`, as the resolver does. */
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');
const DEV_CATALOG_FILE = path.join(REPO_ROOT, '.exarchos', 'invariants.md');

/**
 * The projection key the golden is pinned at. `ideate` + `feature` is the
 * canonical broad working set: it retains every dev entry whose affinity does
 * not exclude it, so the oracle sees the widest surface.
 */
const PHASE = 'ideate';
const WORKFLOW_TYPE = 'feature';

/** Loosely-typed view of the `invariants:` block, so variants can add/remove
 * keys (including a `devCatalog` the schema may later retire) without the test
 * depending on the field still existing in the type. */
type InvariantsBlock = Record<string, unknown>;

/**
 * Read the REAL `.exarchos.yml` from disk and validate it with the production
 * schema. Defect (a) of the retired version of this file was that it never
 * touched this file; the subject must be the config the repo actually ships.
 */
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

/** Ids the production pipeline resolves that ORIGINATE in the dev catalog file. */
function resolveDevLayerIds(config: ExarchosConfigInput): string[] {
  const { entries, warnings } = resolveEffectiveCatalog({
    config,
    phase: PHASE,
    workflowType: WORKFLOW_TYPE,
  });
  // A load failure must never be laundered into an empty-but-green result:
  // `resolveEffectiveCatalog` degrades load errors into warnings (DR-9), so an
  // unexpected warning here would silently weaken every assertion below.
  expect(warnings, 'resolver degraded a layer instead of loading it').toEqual([]);
  const universe = declaredCatalogIds();
  return entries
    .map((e) => e.id)
    .filter((id) => universe.has(id))
    .sort();
}

/**
 * AUTHORITY 2, part 1 — every id declared in the dev catalog file, parsed
 * independently of `loadInvariants` (hand-sliced frontmatter + `yaml`, not
 * `gray-matter`).
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
 * AUTHORITY 2, part 2 — the expected projected id set, recomputed here from
 * the DR-5 affinity rules: `phase-affinity` absent ⇒ all phases, present ⇒
 * must list the phase; `workflow-affinity` absent ⇒ all workflow types,
 * present ⇒ must list the type. No call into `projectCatalog`.
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
  it('RealRepoConfig_EffectiveCatalog_MatchesIndependentlyDerivedCatalog', () => {
    const block = readRealRepoInvariantsBlock();
    const resolved = resolveDevLayerIds({ invariants: block } as ExarchosConfigInput);
    const expected = independentlyProjectedIds();

    // Non-vacuity floor: an empty expectation would make the equality below
    // hold for a resolver that returns nothing at all.
    expect(expected.length).toBeGreaterThan(0);
    expect(resolved).toEqual(expected);
  });

  it('RealRepoConfig_DevCatalogFlagPresentOrAbsent_ResolvesIdenticalCatalog', () => {
    // THE DR-31 ACCEPTANCE PROPERTY. Both metamorphic directions are asserted
    // so this stays load-bearing before AND after T-43 edits `.exarchos.yml`:
    // whichever way the committed file goes, one of these two variants differs
    // from it.
    const block = readRealRepoInvariantsBlock();
    const withFlag = configWith(block, (b) => {
      b.devCatalog = 'enabled';
    });
    const withoutFlag = configWith(block, (b) => {
      delete b.devCatalog;
    });

    // The metamorphic pair must genuinely differ, or the equality below is a
    // tautology (this is the check that keeps the test non-vacuous once the
    // flag is gone from disk).
    expect(withFlag).not.toEqual(withoutFlag);

    const expected = independentlyProjectedIds();
    expect(resolveDevLayerIds(withFlag)).toEqual(expected);
    expect(resolveDevLayerIds(withoutFlag)).toEqual(expected);
  });

  it('RealRepoConfig_NoRegistrationAndNoFlag_ResolvesEmptyDevLayer', () => {
    // SENSITIVITY PROOF: the oracle is not a constant. Strip BOTH the explicit
    // `catalogs:` registration and the sugar from the real config and the dev
    // layer disappears entirely. Without this, "before == after" above could
    // be satisfied by a resolver that ignores config completely.
    const block = readRealRepoInvariantsBlock();
    const stripped = configWith(block, (b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(resolveDevLayerIds(stripped)).toEqual([]);
    // ...and that empty result is genuinely different from the real one.
    expect(independentlyProjectedIds()).not.toEqual([]);
  });
});
