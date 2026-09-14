// ─── Binding the repository's invariants into a capsule's authority ─────────
//
// The built-in authority is the floor every compiled capsule carries. A
// repository's resolved invariants catalog is bound ON TOP of it, by id and
// summary only: a worker needs the statement it is held to, not the catalog's
// enforcement machinery, and binding only those two fields keeps a capsule
// independent of how that machinery is shaped.
//
// This is the whole knowledge binder for now. It binds invariants and nothing
// else — no design records, no patterns, no glossary — and says so rather than
// presenting a partial binding as a complete one.

import type { ExarchosCapsuleAuthorityV1 } from '../../contract/capsule/exarchos-capsule.js';

/** One resolved catalog invariant, as much of it as a capsule carries. */
export interface CatalogInvariant {
  readonly id: string;
  readonly summary: string;
}

/**
 * The base authority with every catalog invariant appended, in catalog order.
 *
 * An id already present — in the base or earlier in the catalog — is bound
 * once. A blank summary is skipped: a statement nothing can be held to is not a
 * statement.
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
