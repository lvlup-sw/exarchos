/**
 * How much of the toolchain registry the static-analysis gate can actually
 * check.
 *
 * The gate detects through the registry and runs checks for a subset of it.
 * That is a defensible arrangement — the gate skips honestly for the rest, and
 * a skip is inconclusive, never a pass. What was not defensible is that the
 * subset was invisible: `SUPPORTED_TOOLCHAINS` had no reader outside its own
 * module, so a toolchain added to the registry with no runner behind it
 * reddened nothing anywhere. The shortfall grew for free.
 *
 * This file makes the difference a measured, named quantity. Both sides are
 * LIVE imports, not a captured JSON snapshot: the point is to compare the gate
 * against the registry as it is right now, and a capture would let both drift
 * together while every assertion stayed green.
 *
 * The pinned list below can only shrink. Add a toolchain to the registry and
 * the uncovered set grows past the pin; wire a runner and it falls below.
 * Either way the equality names the id that moved.
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_TOOLCHAINS } from '../../src/config/toolchains.js';
import { SUPPORTED_TOOLCHAINS } from '../../src/verbs/pure/static-analysis.js';

/**
 * Registry toolchains the static-analysis gate cannot check today, each with
 * the reason it is still on this list.
 *
 * A defect ledger, not an allowance. Every entry means a repository of that
 * kind gets an inconclusive gate — which fails safe, and which is also the
 * reason the top rung of the verification ladder is unreachable there. A
 * repository can lift its own entry by declaring the commands in `.exarchos.yml`
 * `toolchains:`; the entries below are what it gets when it has not, which is
 * the case this list is a ledger of.
 */
const UNCOVERED_TOOLCHAINS: Readonly<Record<string, string>> = {
  python: 'the registry declares a linter (ruff) but no typecheck command; admitting it means deciding what a repository that lints with flake8 or pylint gets',
  'java-gradle': 'the registry declares neither a lint nor a typecheck command for it; the gradle task names are per-project',
  'java-maven': 'the registry declares neither a lint nor a typecheck command for it; the maven plugin bindings are per-project',
  ruby: 'the registry declares a linter (rubocop) but no typecheck command; a repository without a rubocop config would get a hard tool failure rather than a skip',
  php: 'the registry declares neither a lint nor a typecheck command for it; composer script names are per-project',
  elixir: 'the registry declares a linter (credo) but no typecheck command; credo is an optional dependency, so its absence must degrade rather than fail',
  swift: 'the registry declares neither a lint nor a typecheck command for it; the conventional linter is a third-party tool the registry does not name',
  cmake: 'the registry declares neither a lint nor a typecheck command for it; the compiler and its warning flags are chosen by the project, not the build system',
};

/**
 * The registry ids no runner covers.
 *
 * Takes its inputs as arguments rather than reading the imports directly, so
 * the same computation the live assertion depends on can be re-run against a
 * seeded registry. A guard that cannot be shown to fail is a guard nobody has
 * checked.
 */
function uncoveredIds(
  registry: readonly { readonly id: string }[],
  supported: ReadonlySet<string>,
): string[] {
  return registry
    .map((t) => t.id)
    .filter((id) => !supported.has(id))
    .sort();
}

const PINNED = Object.keys(UNCOVERED_TOOLCHAINS).sort();

/**
 * The two legs this gate runs. A shortfall entry has to account for both of
 * them, because "no runner" is always a statement about what the registry
 * declares for each.
 */
const LEG_TERMS: readonly RegExp[] = [/\blint(?:er|ing)?\b/i, /\btypecheck\b/i];

/**
 * Whether a shortfall reason explains the shortfall.
 *
 * A length threshold does not: thirty repeated characters clear it, and so does
 * any placeholder long enough to look like prose. What cannot be faked without
 * actually writing the reason is SAYING WHAT THE REGISTRY DECLARES FOR EACH
 * LEG — a reader can check that claim against the registry, and an author who
 * has not looked cannot produce it. The distinct-word floor is a second, weaker
 * condition that rules out a sentence assembled from one repeated word.
 *
 * Exported shape (a plain function taking the reason) so the guard can be run
 * against a seeded ledger below. A predicate that has never been shown to
 * reject anything is a predicate nobody has checked.
 */
function reasonIsSubstantive(reason: string): boolean {
  const words = reason.toLowerCase().match(/[a-z][a-z-]+/g) ?? [];
  if (new Set(words).size < 8) return false;
  return LEG_TERMS.every((term) => term.test(reason));
}

describe('static-analysis toolchain coverage', () => {
  it('GateToolchainCoverage_Denominator_IsNonEmptyOnBothSides', () => {
    // Neither side may be empty. An emptied registry would make the shortfall
    // vanish and every comparison below pass over nothing; an emptied runner
    // set would make the whole gate a skip while still reading as consistent.
    expect(BUILTIN_TOOLCHAINS.length).toBeGreaterThan(0);
    expect(SUPPORTED_TOOLCHAINS.size).toBeGreaterThan(0);
    expect(PINNED.length).toBeGreaterThan(0);
  });

  it('GateToolchainCoverage_EveryRunner_NamesARegistryToolchain', () => {
    const registryIds = new Set<string>(BUILTIN_TOOLCHAINS.map((t) => t.id));
    const phantom = [...SUPPORTED_TOOLCHAINS].filter((id) => !registryIds.has(id)).sort();

    expect(
      phantom,
      'the gate claims to run checks for ids the registry does not declare, so detection can never produce them',
    ).toEqual([]);
  });

  it('SupportedToolchains_ShortfallIsAsserted', () => {
    expect(
      uncoveredIds(BUILTIN_TOOLCHAINS, SUPPORTED_TOOLCHAINS),
      'the set of registry toolchains with no static-analysis runner changed; update UNCOVERED_TOOLCHAINS — removing an entry when a runner lands, adding one only with the reason it cannot be covered yet',
    ).toEqual(PINNED);
  });

  it('SupportedToolchains_CoverageAndShortfall_PartitionTheRegistry', () => {
    // Equality on the uncovered set alone would still hold if a registry id
    // were counted twice or if a supported id were also pinned as uncovered.
    expect(SUPPORTED_TOOLCHAINS.size + PINNED.length).toBe(BUILTIN_TOOLCHAINS.length);
    expect(new Set(BUILTIN_TOOLCHAINS.map((t) => t.id)).size).toBe(BUILTIN_TOOLCHAINS.length);
  });

  it('SupportedToolchains_EveryShortfallEntry_CarriesAReason', () => {
    // An entry with a blank or perfunctory reason is an omission wearing a
    // name, and the list would stop being a ledger of decisions.
    const unexplained = Object.entries(UNCOVERED_TOOLCHAINS)
      .filter(([, reason]) => !reasonIsSubstantive(reason))
      .map(([id]) => id);

    expect(
      unexplained,
      'shortfall entries whose reason does not say what the registry declares for the lint and typecheck legs',
    ).toEqual([]);
  });

  it('SupportedToolchains_NoTwoEntries_ShareAReason', () => {
    // A reason copied from the row above is about the toolchain it was written
    // for, not this one. Two identical ledger rows are one decision claiming to
    // be two.
    const reasons = Object.values(UNCOVERED_TOOLCHAINS).map((r) => r.trim().toLowerCase());

    expect(new Set(reasons).size, 'a shortfall reason is repeated verbatim').toBe(reasons.length);
  });

  it('FillerReason_RedensTheGuard', () => {
    // The kill fixture for the reason check. The predicate it replaced asserted
    // a string length, which thirty repeated characters satisfy — so it could
    // name an unexplained entry only by accident.
    expect(reasonIsSubstantive('x'.repeat(120))).toBe(false);
    expect(reasonIsSubstantive('reason to be supplied later, pending a decision')).toBe(false);
    // Long and wordy, but it accounts for neither leg.
    expect(
      reasonIsSubstantive('this ecosystem is unusual and nobody on the team has wired it up yet'),
    ).toBe(false);
    // Half an account is still not one.
    expect(reasonIsSubstantive('the registry declares a linter for it but nothing else')).toBe(
      false,
    );
    // And a real entry from the ledger above passes.
    expect(reasonIsSubstantive(UNCOVERED_TOOLCHAINS['python'] ?? '')).toBe(true);
  });

  it('NewToolchain_WithoutARunner_RedensTheGuard', () => {
    // The kill fixture. Seeding the real registry would mean editing a module
    // another change is holding open, so the seed goes through the same
    // function the live assertion calls, with the same runner set.
    const seeded = [...BUILTIN_TOOLCHAINS, { id: 'zig' }];
    const withSeed = uncoveredIds(seeded, SUPPORTED_TOOLCHAINS);

    expect(withSeed).toContain('zig');
    expect(withSeed).not.toEqual(PINNED);
  });

  it('RetiredRunner_AlsoRedensTheGuard', () => {
    // The other direction: a runner quietly dropped must not read as covered
    // just because the registry did not move.
    const fewer = new Set([...SUPPORTED_TOOLCHAINS].filter((id) => id !== 'go'));
    const withoutGo = uncoveredIds(BUILTIN_TOOLCHAINS, fewer);

    expect(withoutGo).toContain('go');
    expect(withoutGo).not.toEqual(PINNED);
  });
});
