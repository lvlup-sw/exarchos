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
 * P1, T2 — `resolveCatalogSources` normalizes `invariants.catalogs`
 * registrations (bare string | `{ path, tier }`) AND desugars the legacy
 * `devCatalog: 'enabled'` flag into a `tier: dev` source pointing at the
 * built-in dev catalog. This is the single discovery surface the refactored
 * `resolveEffectiveCatalog` (T3) iterates.
 */
describe('resolveCatalogSources (T2)', () => {
  it('resolveCatalogSources_BareString_DefaultsUserTier', () => {
    const config: ExarchosConfig = {
      invariants: { catalogs: ['team-invariants.md'] },
    };
    const sources = resolveCatalogSources(config);
    expect(sources).toEqual([{ path: 'team-invariants.md', tier: 'user' }]);
  });

  it('resolveCatalogSources_DevCatalogEnabled_RegistersDevSource', () => {
    const config: ExarchosConfig = {
      invariants: { devCatalog: 'enabled' },
    };
    const sources = resolveCatalogSources(config);
    expect(sources).toEqual([
      { path: '.exarchos/invariants.md', tier: 'dev' },
    ]);
  });

  it('resolveCatalogSources_DevCatalogEnabled_RegistersExarchosDirPath', () => {
    // P5, T19 — the dev catalog now lives at `.exarchos/invariants.md`
    // (relocated from `docs/architecture/invariants.md`). The `devCatalog:
    // 'enabled'` sugar must desugar to the NEW location so the resolver picks
    // up the move with no logic change beyond the path constant.
    const config: ExarchosConfig = {
      invariants: { devCatalog: 'enabled' },
    };
    const sources = resolveCatalogSources(config);
    const devSource = sources.find((s) => s.tier === 'dev');
    expect(devSource?.path).toBe('.exarchos/invariants.md');
  });

  it('resolveCatalogSources_DevCatalogDisabled_OmitsDevSource', () => {
    // Disabled.
    expect(
      resolveCatalogSources({ invariants: { devCatalog: 'disabled' } }),
    ).toEqual([]);
    // Absent invariants block.
    expect(resolveCatalogSources({})).toEqual([]);
    // Absent config entirely.
    expect(resolveCatalogSources(undefined)).toEqual([]);
  });

  it('resolveCatalogSources_NoDuplicateDevSource', () => {
    // `devCatalog: enabled` sugar AND an explicit `{ path: invariants.md,
    // tier: dev }` registration must produce exactly ONE dev source (deduped
    // by resolved path). The explicit registration wins its place; the sugar
    // does not double-register it.
    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: [{ path: '.exarchos/invariants.md', tier: 'dev' }],
      },
    };
    const sources = resolveCatalogSources(config);
    const devSources = sources.filter((s) => s.tier === 'dev');
    expect(devSources).toEqual([
      { path: '.exarchos/invariants.md', tier: 'dev' },
    ]);
  });

  it.each([
    { label: 'bare-string', catalogs: ['.exarchos/invariants.md'] as const },
    {
      label: 'explicit user-tier',
      catalogs: [{ path: '.exarchos/invariants.md', tier: 'user' as const }],
    },
  ])(
    'resolveCatalogSources_DevCatalogEnabled_SamePathLegacyRegistration_PreservesDevTier ($label)',
    ({ catalogs }) => {
      // #1487 review: a USER-tier (or bare-string legacy) registration sharing
      // the dev catalog path MUST NOT suppress the `devCatalog: 'enabled'`
      // sugar. Without a dev-tier source the dev catalog would load as user
      // tier and its reserved `INV-*` ids would be rejected by the
      // reserved-namespace check. Dedupe is keyed on (path, tier:'dev').
      const config: ExarchosConfig = {
        invariants: {
          devCatalog: 'enabled',
          catalogs: [...catalogs],
        },
      };
      const sources = resolveCatalogSources(config);
      expect(sources).toContainEqual({
        path: '.exarchos/invariants.md',
        tier: 'dev',
      });
    },
  );

  it('resolveCatalogSources_ObjectFormTierlessDefaultsUser', () => {
    const config: ExarchosConfig = {
      invariants: { catalogs: [{ path: 'team.yml' }] },
    };
    expect(resolveCatalogSources(config)).toEqual([
      { path: 'team.yml', tier: 'user' },
    ]);
  });

  it('resolveCatalogSources_MixedFormsAndDevSugar_AllNormalized', () => {
    const config: ExarchosConfig = {
      invariants: {
        devCatalog: 'enabled',
        catalogs: ['team.yml', { path: 'design.yml', tier: 'dev' }],
      },
    };
    const sources = resolveCatalogSources(config);
    // Explicit registrations preserved + the desugared dev source appended.
    expect(sources).toContainEqual({ path: 'team.yml', tier: 'user' });
    expect(sources).toContainEqual({ path: 'design.yml', tier: 'dev' });
    expect(sources).toContainEqual({
      path: '.exarchos/invariants.md',
      tier: 'dev',
    });
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
 * ## Note for T-42
 *
 * `CatalogSources_RealRepoConfigRegistrationRemoved_SugarSynthesizesDevSource`
 * is the guard that pins the desugaring branch itself. T-42 deletes that
 * branch, so that ONE test is expected to be re-baselined (to "no sources")
 * as part of the deliberate behavior change. The other three tests in this
 * block must stay green through T-42 and T-43 — they pin the property the
 * removal is claimed to preserve.
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

  it('CatalogSources_RealRepoConfigRegistrationRemoved_SugarSynthesizesDevSource', () => {
    // THE DESUGARING BRANCH ITSELF (catalog-sources.ts, DR-31 site 2). Strip
    // the explicit `catalogs:` registration from the real config and keep only
    // the boolean: the branch must synthesize the dev source that the removed
    // registration named. This is the test T-42 re-baselines when it deletes
    // the branch.
    const devPath = registeredDevPath();
    const sugarOnly = configWith((b) => {
      b.devCatalog = 'enabled';
      delete b.catalogs;
    });
    expect(resolveCatalogSources(sugarOnly)).toEqual([
      { path: devPath, tier: 'dev' },
    ]);
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
