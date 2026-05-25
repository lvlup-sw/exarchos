import { describe, it, expect } from 'vitest';
import { resolveCatalogSources } from './catalog-sources.js';
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

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
