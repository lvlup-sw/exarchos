/**
 * Catalog-source discovery for the effective-catalog resolver (P1, T2).
 *
 * `resolveEffectiveCatalog` (DR-7) historically hand-coded three layers, with
 * the **dev catalog special-cased**: it loaded from a hardcoded path
 * (`docs/architecture/invariants.md`) behind a bespoke `devCatalog: 'enabled'`
 * boolean, while user catalogs flowed through the generic `invariants.catalogs`
 * registration list — even though BOTH call the identical `loadInvariants`
 * loader. This module is the single discovery surface that collapses that
 * asymmetry: it normalizes every registered file-source into a `CatalogSource`
 * tagged by `tier`, so the resolver can iterate one uniform list (design §4.2).
 *
 * ## Desugaring contract
 *
 *   - A bare-string `catalogs` entry → `{ path, tier: 'user' }` (legacy form).
 *   - A `{ path, tier }` object → as-is; an absent `tier` defaults to `'user'`.
 *   - `devCatalog: 'enabled'` → ALSO emit `{ path: DEV_CATALOG_PATH, tier:
 *     'dev' }` (back-compat sugar, design §4.3). Disabled/absent → no dev source.
 *   - Dedupe by resolved path: if `devCatalog: 'enabled'` AND an explicit
 *     `tier: dev` registration for the same path are both present, the result
 *     carries exactly ONE dev source (the explicit registration; the sugar does
 *     not double-register it).
 *
 * The returned paths are NOT resolved against a repo root here — that is the
 * resolver's job (it may be absolute or relative). Dedupe compares the raw
 * `path` string, which is sufficient because the desugared dev path is a fixed
 * repo-relative constant that an explicit registration mirrors verbatim.
 */
import type { ExarchosConfig } from '../config/exarchos-config-schema.js';

/** A normalized, tier-tagged catalog file source. */
export interface CatalogSource {
  /** Path to the catalog file (absolute or repo-root-relative). */
  path: string;
  /** Privilege tier: `dev` (built-in/maintainer) or `user` (consumer). */
  tier: 'dev' | 'user';
}

/**
 * Repo-relative path the `devCatalog: 'enabled'` sugar desugars to. Mirrors the
 * path the resolver previously hardcoded in its Layer-1 block.
 */
export const DEV_CATALOG_PATH = 'docs/architecture/invariants.md';

/**
 * Normalize `invariants.catalogs` registrations + desugar `devCatalog` into a
 * single tier-tagged `CatalogSource[]`. See the module header for the full
 * desugaring + dedupe contract.
 */
export function resolveCatalogSources(
  config: ExarchosConfig | undefined,
): CatalogSource[] {
  const invariants = config?.invariants;
  const registrations = invariants?.catalogs ?? [];

  const sources: CatalogSource[] = registrations.map((registration) =>
    typeof registration === 'string'
      ? { path: registration, tier: 'user' }
      : { path: registration.path, tier: registration.tier ?? 'user' },
  );

  // Desugar the legacy `devCatalog: 'enabled'` flag into a dev-tier source,
  // unless an explicit registration already claims the same path (dedupe).
  if (invariants?.devCatalog === 'enabled') {
    const alreadyRegistered = sources.some((s) => s.path === DEV_CATALOG_PATH);
    if (!alreadyRegistered) {
      sources.push({ path: DEV_CATALOG_PATH, tier: 'dev' });
    }
  }

  return sources;
}
