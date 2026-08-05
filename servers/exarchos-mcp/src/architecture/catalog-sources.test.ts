import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveCatalogSources, type CatalogSource } from './catalog-sources.js';
import type {
  ExarchosConfig,
  ExarchosConfigInput,
} from '../config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../config/yaml-schema.js';

/**
 * P1, T2 / DR-31 — `resolveCatalogSources` normalizes `invariants.catalogs`
 * registrations (bare string | `{ path, tier }`) into the tier-tagged source
 * list the refactored `resolveEffectiveCatalog` (T3) iterates.
 *
 * ## What used to be asserted here, and why it is gone (T-42)
 *
 * Five tests in this block pinned a SECOND responsibility this function no
 * longer has: desugaring `devCatalog: 'enabled'` into a synthetic `{ path:
 * '.exarchos/invariants.md', tier: 'dev' }` source, with a `(path, tier:'dev')`
 * dedupe so the sugar and an explicit registration for the same path could not
 * double-load. DR-31 retired that branch — `resolveCatalogSources` was a direct
 * reader of the boolean, which is exactly the repo-only loading mode the
 * requirement removes. The tests were DELETED rather than inverted: an
 * "expect nothing happens" test for a branch that does not exist is noise, and
 * `CatalogSources_NoDesugarBranch_ResolvesRegisteredCatalogsOnly` below pins
 * the real contract (registrations in, registrations out) in one place.
 */
describe('resolveCatalogSources (T2)', () => {
  it('resolveCatalogSources_BareString_DefaultsUserTier', () => {
    const config: ExarchosConfig = {
      invariants: { catalogs: ['team-invariants.md'] },
    };
    const sources = resolveCatalogSources(config);
    expect(sources).toEqual([{ path: 'team-invariants.md', tier: 'user' }]);
  });

  it('resolveCatalogSources_NoRegistrations_ResolvesNothing', () => {
    // No `catalogs:` list, in every shape a config can take. Registration is
    // the ONLY opt-in, so all three resolve nothing.
    expect(resolveCatalogSources({ invariants: {} })).toEqual([]);
    expect(resolveCatalogSources({})).toEqual([]);
    expect(resolveCatalogSources(undefined)).toEqual([]);
  });

  it('CatalogSources_NoDesugarBranch_ResolvesRegisteredCatalogsOnly', () => {
    // THE DR-31 SITE-2 ACCEPTANCE TEST (relocated here from
    // invariants-loader.test.ts, where T-42 parked it because this file was
    // outside that task's declared file list — it belongs with its subject).
    //
    // `resolveCatalogSources` used to be a direct reader of the boolean:
    // `devCatalog: 'enabled'` synthesized a dev source out of thin air. That
    // branch is gone — registrations in, registrations out.
    const sugarOnly = {
      invariants: { devCatalog: 'enabled' as const },
    } satisfies ExarchosConfigInput;
    expect(resolveCatalogSources(sugarOnly)).toEqual([]);

    // With registrations present, the boolean adds nothing: the output is
    // exactly the normalized registrations, with no synthesized dev source.
    const withFlag = {
      invariants: {
        devCatalog: 'enabled' as const,
        catalogs: ['team.md', { path: 'design.md', tier: 'dev' as const }],
      },
    } satisfies ExarchosConfigInput;
    const withoutFlag = {
      invariants: {
        catalogs: ['team.md', { path: 'design.md', tier: 'dev' as const }],
      },
    } satisfies ExarchosConfigInput;
    const expected = [
      { path: 'team.md', tier: 'user' },
      { path: 'design.md', tier: 'dev' },
    ];
    expect(resolveCatalogSources(withFlag)).toEqual(expected);
    expect(resolveCatalogSources(withoutFlag)).toEqual(expected);
    // No synthesized built-in path anywhere in the result.
    expect(resolveCatalogSources(withFlag).map((s) => s.path)).not.toContain(
      '.exarchos/invariants.md',
    );
  });

  it('resolveCatalogSources_ObjectFormTierlessDefaultsUser', () => {
    const config: ExarchosConfig = {
      invariants: { catalogs: [{ path: 'team.yml' }] },
    };
    expect(resolveCatalogSources(config)).toEqual([
      { path: 'team.yml', tier: 'user' },
    ]);
  });

  it('resolveCatalogSources_MixedForms_AllNormalized', () => {
    const config: ExarchosConfig = {
      invariants: {
        catalogs: ['team.yml', { path: 'design.yml', tier: 'dev' }],
      },
    };
    const sources = resolveCatalogSources(config);
    expect(sources).toEqual([
      { path: 'team.yml', tier: 'user' },
      { path: 'design.yml', tier: 'dev' },
    ]);
  });
});

/**
 * DR-31 / T-41 — the desugaring branch exercised against the REAL repo config.
 *
 * The block above builds every config by hand. That is fine for contract
 * coverage but it cannot answer the question DR-31 actually asks: *what
 * happens to THIS repository's catalog discovery when `invariants.devCatalog`
 * is deleted from `.exarchos.yml`?* `catalog-sources.ts` is the site that
 * removal changes (DR-31 site 2 — `resolveCatalogSources` is a direct reader
 * of the boolean), so the answer has to be pinned here, on the real file.
 *
 * ## Two independent authorities (DR-30)
 *
 *   - **Authority 1 (subject):** `resolveCatalogSources`, the function under
 *     test.
 *   - **Authority 2 (expectation):** `normalizeRegistrations` below — a
 *     re-implementation of the documented normalization contract (bare string
 *     ⇒ `tier: user`; object ⇒ `tier ?? 'user'`) applied to the `catalogs:`
 *     list read verbatim out of the real `.exarchos.yml`. It shares no code
 *     with the subject. Likewise the expected desugar target path is taken
 *     from the repo's OWN registration in that file, never from the module's
 *     `DEV_CATALOG_PATH` constant — so a constant that drifts away from what
 *     the repo registers is caught rather than mirrored.
 *
 * ## Note for T-42 — resolved
 *
 * `CatalogSources_RealRepoConfigRegistrationRemoved_SugarSynthesizesDevSource`
 * was the guard pinning the desugaring branch itself. T-42 deleted that
 * branch, so that ONE test was re-baselined (to "no sources") as part of the
 * deliberate behavior change, and renamed
 * `..._ResolvesNoSources` to match what it now asserts. The other three tests
 * in this block are unchanged and stayed green through the removal — they pin
 * the property the removal was claimed to preserve, and they are the reason
 * this file is an oracle rather than a changelog.
 */
describe('resolveCatalogSources — real repo config (DR-31 / T-41)', () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../..',
  );
  const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');

  type InvariantsBlock = Record<string, unknown>;

  /** Read + schema-validate the REAL `.exarchos.yml` invariants block. */
  function realInvariantsBlock(): InvariantsBlock {
    expect(
      fs.existsSync(REPO_CONFIG_PATH),
      `real repo config missing at ${REPO_CONFIG_PATH}`,
    ).toBe(true);
    const doc: unknown = parseYaml(fs.readFileSync(REPO_CONFIG_PATH, 'utf8'));
    const parsed = FullExarchosConfigSchema.safeParse(doc);
    expect(
      parsed.success,
      'real .exarchos.yml failed the production config schema: ' +
        (parsed.success ? '' : JSON.stringify(parsed.error.issues)),
    ).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(parsed.data.invariants, 'real .exarchos.yml has no invariants block')
      .toBeDefined();
    return structuredClone(parsed.data.invariants) as InvariantsBlock;
  }

  function configWith(mutate: (b: InvariantsBlock) => void): ExarchosConfigInput {
    const block = realInvariantsBlock();
    mutate(block);
    return { invariants: block } as ExarchosConfigInput;
  }

  /** AUTHORITY 2 — the documented normalization contract, re-implemented. */
  function normalizeRegistrations(block: InvariantsBlock): CatalogSource[] {
    const raw = (block.catalogs ?? []) as Array<
      string | { path: string; tier?: 'dev' | 'user' }
    >;
    return raw.map((registration) =>
      typeof registration === 'string'
        ? { path: registration, tier: 'user' }
        : { path: registration.path, tier: registration.tier ?? 'user' },
    );
  }

  /** The dev-tier catalog path the repo registers in its OWN config file. */
  function registeredDevPath(): string {
    const devSource = normalizeRegistrations(realInvariantsBlock()).find(
      (s) => s.tier === 'dev',
    );
    expect(
      devSource,
      'real .exarchos.yml registers no `tier: dev` catalog — the DR-31 ' +
        'premise (registration, not the boolean, is the opt-in) no longer holds',
    ).toBeDefined();
    return devSource!.path;
  }

  it('CatalogSources_RealRepoConfig_DedupesSugarAgainstExplicitDevRegistration', () => {
    // PATH-DEDUPE, on the real config. The committed file carries the sugar
    // AND an explicit `{ path, tier: dev }` registration for the same path;
    // the result must carry that path exactly ONCE (a second copy would
    // double-load the catalog).
    const block = realInvariantsBlock();
    const sources = resolveCatalogSources({
      invariants: block,
    } as ExarchosConfigInput);
    const devPath = registeredDevPath();

    expect(sources.filter((s) => s.path === devPath)).toEqual([
      { path: devPath, tier: 'dev' },
    ]);
    // And the whole list equals the independently-normalized registrations —
    // i.e. the sugar contributes nothing extra for this repo's config.
    expect(sources).toEqual(normalizeRegistrations(block));
  });

  it('CatalogSources_RealRepoConfigFlagPresentOrAbsent_ResolvesIdenticalSources', () => {
    // THE DR-31 PROPERTY AT SITE 2. Both metamorphic directions, so the guard
    // survives T-43 deleting the key from disk.
    const withFlag = configWith((b) => {
      b.devCatalog = 'enabled';
    });
    const withoutFlag = configWith((b) => {
      delete b.devCatalog;
    });
    expect(withFlag).not.toEqual(withoutFlag);

    const expected = normalizeRegistrations(realInvariantsBlock());
    expect(expected.length).toBeGreaterThan(0);
    expect(resolveCatalogSources(withFlag)).toEqual(expected);
    expect(resolveCatalogSources(withoutFlag)).toEqual(expected);
  });

  it('CatalogSources_RealRepoConfigRegistrationRemoved_ResolvesNoSources', () => {
    // RE-BASELINED BY T-42 — this was
    // `..._SugarSynthesizesDevSource`, and it asserted the desugaring branch
    // itself: strip the explicit `catalogs:` registration from the real config,
    // keep only the boolean, and the branch synthesized the dev source the
    // removed registration named. T-41 flagged it as the one test in this
    // block that T-42 would legitimately re-baseline, and this is it.
    //
    // The new contract is the inverse and it is NOT a weaker assertion: the
    // sugar alone resolves NOTHING. Registration is the only opt-in, so a
    // config carrying the boolean and no registration discovers no catalog —
    // which is precisely what makes the boolean inert rather than merely
    // redundant. Restoring the desugar branch reddens this test.
    const sugarOnly = configWith((b) => {
      b.devCatalog = 'enabled';
      delete b.catalogs;
    });
    // The subject really does still carry the retired flag — otherwise this
    // would be testing "empty config resolves nothing", a much weaker claim.
    expect(sugarOnly.invariants).toHaveProperty('devCatalog', 'enabled');
    expect(resolveCatalogSources(sugarOnly)).toEqual([]);

    // ...and the registration this config had stripped is what WOULD have
    // resolved, so the emptiness above is caused by its removal and nothing
    // else. This keeps the test sensitive to a resolver that ignores config.
    expect(registeredDevPath()).toBeTruthy();
    expect(
      resolveCatalogSources(configWith((b) => { delete b.devCatalog; })),
    ).not.toEqual([]);
  });

  it('CatalogSources_RealRepoConfigNoRegistrationNoFlag_ResolvesNoSources', () => {
    // SENSITIVITY FLOOR: with neither the registration nor the sugar there is
    // nothing to discover. Without this, the equalities above could be
    // satisfied by a function that ignores its config.
    const stripped = configWith((b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(resolveCatalogSources(stripped)).toEqual([]);
  });
});
