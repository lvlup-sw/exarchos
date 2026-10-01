/**
 * Binds the resolved invariants catalog of a repository on top of the built-in capsule authority.
 * A capsule carries only the id and the summary of each invariant, so it does not depend on the enforcement shape of the catalog.
 * This binder binds invariants and nothing else.
 */

import type { ExarchosCapsuleAuthorityV1 } from '../../contract/capsule/exarchos-capsule.js';

/** One resolved catalog invariant, as much of it as a capsule carries. */
export interface CatalogInvariant {
  readonly id: string;
  readonly summary: string;
}

/**
 * The base authority with every catalog invariant appended, in catalog order.
 *
 * An id that is already present, in the base or earlier in the catalog, binds once.
 * The function skips an entry with a blank summary.
 */
export function bindCatalogInvariants(
  base: ExarchosCapsuleAuthorityV1,
  catalog: readonly CatalogInvariant[],
): ExarchosCapsuleAuthorityV1 {
  const seen = new Set<string>();
  for (const invariant of base.invariants) {
    if (invariant.id !== undefined) seen.add(invariant.id);
  }
  const bound = [];
  for (const entry of catalog) {
    if (seen.has(entry.id) || entry.summary.trim().length === 0) continue;
    seen.add(entry.id);
    bound.push({ id: entry.id, statement: entry.summary });
  }
  return { ...base, invariants: [...base.invariants, ...bound] };
}
