import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { resolveCatalogSources, type CatalogSource } from '../../../src/architecture/catalog-sources.js';
import type {
  ExarchosConfig,
  ExarchosConfigInput,
} from '../../../src/config/exarchos-config-schema.js';
import { FullExarchosConfigSchema } from '../../../src/config/yaml-schema.js';

/**
 * `resolveCatalogSources` converts each `invariants.catalogs` registration, a bare string or a
 * `{ path, tier }` object, into a tier-tagged source for `resolveEffectiveCatalog`.
 * Registration is the only opt-in. The function does not read the `devCatalog` key.
 */
describe('resolveCatalogSources (T2)', () => {
  it('resolveCatalogSources_BareString_DefaultsUserTier', () => {
    const config: ExarchosConfig = {
      invariants: { catalogs: ['team-invariants.md'] },
    };
    const sources = resolveCatalogSources(config);
    expect(sources).toEqual([{ path: 'team-invariants.md', tier: 'user' }]);
  });

  /** Each config shape with no `catalogs` list resolves nothing. */
  it('resolveCatalogSources_NoRegistrations_ResolvesNothing', () => {
    expect(resolveCatalogSources({ invariants: {} })).toEqual([]);
    expect(resolveCatalogSources({})).toEqual([]);
    expect(resolveCatalogSources(undefined)).toEqual([]);
  });

  /**
   * `devCatalog: 'enabled'` with no registration resolves nothing. With registrations, the key adds
   * nothing. The result is the normalized registrations, with no `.exarchos/invariants.md` source.
   */
  it('CatalogSources_NoDesugarBranch_ResolvesRegisteredCatalogsOnly', () => {
    const sugarOnly = {
      invariants: { devCatalog: 'enabled' as const },
    } satisfies ExarchosConfigInput;
    expect(resolveCatalogSources(sugarOnly)).toEqual([]);

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
 * The same contract against the real `.exarchos.yml` of this repository.
 * `realInvariantsBlock` reads that file, validates it with the production config schema, and
 * returns a copy of its invariants block.
 *
 * The expectation comes from a second source. `normalizeRegistrations` implements the documented
 * normalization again and shares no code with `resolveCatalogSources`.
 * `registeredDevPath` returns the dev-tier path that the real file registers.
 */
describe('resolveCatalogSources — real repo config (DR-31 / T-41)', () => {
  const REPO_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..');
  const REPO_CONFIG_PATH = path.join(REPO_ROOT, '.exarchos.yml');

  type InvariantsBlock = Record<string, unknown>;

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

  /**
   * The result holds the registered dev path exactly one time, because a second copy loads the
   * catalog two times. The whole list equals the output of `normalizeRegistrations`.
   */
  it('CatalogSources_RealRepoConfig_DedupesSugarAgainstExplicitDevRegistration', () => {
    const block = realInvariantsBlock();
    const sources = resolveCatalogSources({
      invariants: block,
    } as ExarchosConfigInput);
    const devPath = registeredDevPath();

    expect(sources.filter((s) => s.path === devPath)).toEqual([
      { path: devPath, tier: 'dev' },
    ]);
    expect(sources).toEqual(normalizeRegistrations(block));
  });

  /**
   * The real config resolves the same sources with the `devCatalog` key and without it.
   * The test builds both variants, so the result does not depend on a key in the file.
   */
  it('CatalogSources_RealRepoConfigFlagPresentOrAbsent_ResolvesIdenticalSources', () => {
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

  /**
   * A config with the `devCatalog` key and no registration resolves nothing, so the key is inert.
   * The first assertion shows that the config holds the key. Without it, the test shows only that
   * an empty config resolves nothing. The last assertions show that the removed registration is
   * the cause, because the config with the registration resolves a source.
   */
  it('CatalogSources_RealRepoConfigRegistrationRemoved_ResolvesNoSources', () => {
    const sugarOnly = configWith((b) => {
      b.devCatalog = 'enabled';
      delete b.catalogs;
    });
    expect(sugarOnly.invariants).toHaveProperty('devCatalog', 'enabled');
    expect(resolveCatalogSources(sugarOnly)).toEqual([]);

    expect(registeredDevPath()).toBeTruthy();
    expect(
      resolveCatalogSources(configWith((b) => { delete b.devCatalog; })),
    ).not.toEqual([]);
  });

  /**
   * With no registration and no key, the result is empty. Without this test, a function that
   * ignores its config can pass the equalities in the other tests.
   */
  it('CatalogSources_RealRepoConfigNoRegistrationNoFlag_ResolvesNoSources', () => {
    const stripped = configWith((b) => {
      delete b.devCatalog;
      delete b.catalogs;
    });
    expect(resolveCatalogSources(stripped)).toEqual([]);
  });
});
