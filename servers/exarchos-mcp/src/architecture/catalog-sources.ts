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
export const DEV_CATALOG_PATH = '.exarchos/invariants.md';

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
  // unless an explicit DEV-tier registration already claims the same path
  // (dedupe). The dedupe must be keyed on `(path, tier: 'dev')`, NOT path
  // alone: a USER-tier registration sharing the dev path (legacy bare-string
  // or `{ path, tier: 'user' }`) must NOT suppress the dev sugar — otherwise
  // the dev catalog would load as USER tier and its reserved `INV-*` ids would
  // be rejected by the reserved-namespace check (#1487 review).
  if (invariants?.devCatalog === 'enabled') {
    const existingIndex = sources.findIndex((s) => s.path === DEV_CATALOG_PATH);
    if (existingIndex === -1) {
      sources.push({ path: DEV_CATALOG_PATH, tier: 'dev' });
    } else if (sources[existingIndex]?.tier !== 'dev') {
      // A USER-tier registration sharing the dev path is upgraded IN PLACE to
      // dev tier — not duplicated — so the catalog loads exactly once, as dev.
      // (Pushing a second dev source would double-load the file; leaving it
      // user-tier would get its INV-* ids rejected as a reserved namespace.)
      sources[existingIndex] = { path: DEV_CATALOG_PATH, tier: 'dev' };
    }
  }

  return sources;
}
