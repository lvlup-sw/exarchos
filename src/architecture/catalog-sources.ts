/**
 * Discovers the catalog sources for the effective-catalog resolver.
 * Each `invariants.catalogs` entry becomes a {@link CatalogSource} with a `tier`, so the resolver iterates one list.
 * Registration in `invariants.catalogs` is the only way that a catalog enters discovery.
 * The config schema converts the `devCatalog` alias into a `catalogs:` entry at parse time, so this module never sees it.
 * This module does not resolve paths against a repo root. The resolver does that.
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
 * Converts the `invariants.catalogs` registrations into tier-tagged sources.
 * A bare string becomes a `user` source. An object keeps its `tier`, and an absent `tier` becomes `user`.
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
