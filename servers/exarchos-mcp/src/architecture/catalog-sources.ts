/**
 * Catalog-source discovery for the effective-catalog resolver (P1, T2).
 *
 * `resolveEffectiveCatalog` (DR-7) historically hand-coded three layers, with
 * the **dev catalog special-cased**: it loaded from a hardcoded path
 * (`.exarchos/invariants.md`, relocated from `docs/architecture/invariants.md`
 * in T19) behind a bespoke `devCatalog: 'enabled'`
 * boolean, while user catalogs flowed through the generic `invariants.catalogs`
 * registration list — even though BOTH call the identical `loadInvariants`
 * loader. This module is the single discovery surface that collapses that
 * asymmetry: it normalizes every registered file-source into a `CatalogSource`
 * tagged by `tier`, so the resolver can iterate one uniform list (design §4.2).
 *
 * ## Normalization contract (DR-31)
 *
 *   - A bare-string `catalogs` entry → `{ path, tier: 'user' }` (legacy form).
 *   - A `{ path, tier }` object → as-is; an absent `tier` defaults to `'user'`.
 *   - NOTHING else. Registration in `invariants.catalogs` is the ONLY way a
 *     catalog enters discovery.
 *
 * ## What used to be here, and why it is gone (DR-31, site 2)
 *
 * This function previously ALSO desugared a repo-only boolean —
 * `invariants.devCatalog: 'enabled'` → synthesize `{ path:
 * '.exarchos/invariants.md', tier: 'dev' }`, with a `(path, tier: 'dev')`
 * dedupe so the sugar and an explicit registration for the same path did not
 * double-load. That branch made `resolveCatalogSources` a direct reader of the
 * boolean, which is what DR-31 retires: it gave this repository a loading mode
 * no consumer could reproduce from their own `.exarchos.yml`, and it meant one
 * concern (which catalogs load) had two configuration authorities.
 *
 * The audience scoping the boolean carried is now carried by `tier: 'dev'` on
 * an ordinary registration, so a repo opts its own catalog in exactly the way a
 * consumer does. `devCatalog` may still legally APPEAR in a config (the schema
 * still accepts it until DR-31's schema task); it simply has no effect here.
 *
 * The returned paths are NOT resolved against a repo root here — that is the
 * resolver's job (it may be absolute or relative).
 */
import type { ExarchosConfigInput } from '../config/exarchos-config-schema.js';

/** A normalized, tier-tagged catalog file source. */
export interface CatalogSource {
  /** Path to the catalog file (absolute or repo-root-relative). */
  path: string;
  /** Privilege tier: `dev` (built-in/maintainer) or `user` (consumer). */
  tier: 'dev' | 'user';
}

/**
 * Normalize `invariants.catalogs` registrations into a tier-tagged
 * `CatalogSource[]`. See the module header for the full contract — in
 * particular that registration is the ONLY opt-in (DR-31).
 */
export function resolveCatalogSources(
  config: ExarchosConfigInput | undefined,
): CatalogSource[] {
  const registrations = config?.invariants?.catalogs ?? [];

  return registrations.map((registration) =>
    typeof registration === 'string'
      ? { path: registration, tier: 'user' }
      : { path: registration.path, tier: registration.tier ?? 'user' },
  );
}
