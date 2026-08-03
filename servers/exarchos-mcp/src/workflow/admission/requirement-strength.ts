// ─── P06-03 / Task 042 — The requirement-strength partial order ──────────────
//
// A `ResolvedRequirements` value is one point in the OUTPUT lattice of
// requirement resolution. This module defines the partial order over that
// lattice by *strength* — "at least as strong as" — and the least-upper-bound
// (`join`) that lets resolution compose contributions monotonically.
//
// The order is a PRODUCT of four independent per-field orders:
//
//   gates                       — set inclusion   (a ⊇ b : more required gates is stronger)
//   minimumApprovals            — numeric ≥        (more approvals is stronger)
//   minimumCorroboratingSources — numeric ≥        (more corroboration is stronger)
//   waivable                    — false ≥ true     (cannot-be-waived is stronger)
//
// A product of orders is itself a partial order — and a genuinely PARTIAL one:
// two sets that each contain a gate the other lacks are INCOMPARABLE. That is
// what makes `join` load-bearing rather than a `max`: the least upper bound must
// unite the gate sets, not pick one.
//
// The algebraic laws (reflexivity, antisymmetry, transitivity, and that `join`
// is a true LUB — commutative, associative, idempotent, absorptive) are proven
// in the co-located test.
//
// Pure: no I/O.

import type { ResolvedGate } from '../phase-kind.js';

// ─── The lattice element ─────────────────────────────────────────────────────

/**
 * A resolved requirement set: the complete obligations a phase attempt must
 * discharge, as a single lattice point. Deliberately NOT the persisted
 * `AdmissionRequirementV1[]` record shape (branded ids, subjects, and digests
 * are minted by the downstream freeze step, Task 019) — this is the pure
 * obligation algebra those records are projected from.
 */
export interface ResolvedRequirements {
  /**
   * The gate obligations that must each produce passing evidence, in canonical
   * order (see {@link canonicalGateKey}) with no duplicates. Stronger = superset.
   */
  readonly gates: readonly ResolvedGate[];
  /** Minimum independent approvals required. `>= 0`. Stronger = larger. */
  readonly minimumApprovals: number;
  /**
   * Minimum independent corroborating sources required. `0` means no
   * corroboration obligation; a positive value is a real obligation (which the
   * persisted `corroboration` requirement floors at 2). Stronger = larger.
   */
  readonly minimumCorroboratingSources: number;
  /**
   * Whether an authorized waiver may discharge the obligations. `false`
   * (not waivable) is STRONGER than `true`.
   */
  readonly waivable: boolean;
}

/** A deeply-frozen {@link ResolvedRequirements} — immutable at every level. */
export type FrozenResolvedRequirements = ResolvedRequirements;

/** The weakest requirement set: no gates, no approvals, no corroboration, waivable. */
export const BOTTOM_REQUIREMENTS: FrozenResolvedRequirements = deepFreezeRequirements({
  gates: [],
  minimumApprovals: 0,
  minimumCorroboratingSources: 0,
  waivable: true,
});

// ─── Gate-set helpers (canonical order, set semantics) ───────────────────────

/**
 * A stable total-order key for a resolved gate, so gate SETS have a canonical
 * serialization and comparison independent of insertion order. Family first,
 * then gate name — both are closed vocabularies, so the key never collides.
 */
export function canonicalGateKey(gate: ResolvedGate): string {
  return `${gate.family}\u0000${gate.gate}`;
}

/** Deduplicate and sort a gate list into canonical order. Pure; returns a fresh array. */
export function canonicalizeGates(
  gates: readonly ResolvedGate[],
): readonly ResolvedGate[] {
  const byKey = new Map<string, ResolvedGate>();
  for (const gate of gates) {
    const key = canonicalGateKey(gate);
    if (!byKey.has(key)) byKey.set(key, gate);
  }
  return [...byKey.values()].sort((a, b) =>
    canonicalGateKey(a) < canonicalGateKey(b) ? -1 : canonicalGateKey(a) > canonicalGateKey(b) ? 1 : 0,
  );
}

/** True iff every gate in `subset` also appears in `superset` (set inclusion). */
function gatesContain(
  superset: readonly ResolvedGate[],
  subset: readonly ResolvedGate[],
): boolean {
  const keys = new Set(superset.map(canonicalGateKey));
  return subset.every((g) => keys.has(canonicalGateKey(g)));
}

/** Set union of two gate lists, canonicalized. */
function unionGates(
  a: readonly ResolvedGate[],
  b: readonly ResolvedGate[],
): readonly ResolvedGate[] {
  return canonicalizeGates([...a, ...b]);
}

/** True iff the two gate lists are the same SET (order-independent). */
function gatesEqual(
  a: readonly ResolvedGate[],
  b: readonly ResolvedGate[],
): boolean {
  return gatesContain(a, b) && gatesContain(b, a);
}

// ─── The partial order ───────────────────────────────────────────────────────

/**
 * `true` iff `a` is AT LEAST AS STRONG as `b` (`a ≥ b`): a's obligations
 * dominate b's in every field. This is the reflexive, antisymmetric, transitive
 * order the whole module is built around.
 *
 * Because the gate field is ordered by set inclusion, `atLeastAsStrong` can be
 * false in BOTH directions — `a` and `b` are then incomparable.
 */
export function atLeastAsStrong(
  a: ResolvedRequirements,
  b: ResolvedRequirements,
): boolean {
  return (
    gatesContain(a.gates, b.gates) &&
    a.minimumApprovals >= b.minimumApprovals &&
    a.minimumCorroboratingSources >= b.minimumCorroboratingSources &&
    // waivable strength: false (not-waivable) ≥ true (waivable). `a` is at least
    // as strong iff it is not-waivable whenever `b` is not-waivable.
    (b.waivable || !a.waivable)
  );
}

/** Structural equality of two requirement sets (gate field compared as a SET). */
export function equalRequirements(
  a: ResolvedRequirements,
  b: ResolvedRequirements,
): boolean {
  return (
    a.minimumApprovals === b.minimumApprovals &&
    a.minimumCorroboratingSources === b.minimumCorroboratingSources &&
    a.waivable === b.waivable &&
    gatesEqual(a.gates, b.gates)
  );
}

/** The result of comparing `a` to `b` in the strength order. */
export type StrengthComparison = 'eq' | 'stronger' | 'weaker' | 'incomparable';

/**
 * Compare `a` to `b`:
 *   - `'eq'`          — equal strength,
 *   - `'stronger'`    — `a` strictly dominates `b`,
 *   - `'weaker'`      — `b` strictly dominates `a`,
 *   - `'incomparable'`— neither dominates (only possible via the gate-set order).
 */
export function compareStrength(
  a: ResolvedRequirements,
  b: ResolvedRequirements,
): StrengthComparison {
  const aGeB = atLeastAsStrong(a, b);
  const bGeA = atLeastAsStrong(b, a);
  if (aGeB && bGeA) return 'eq';
  if (aGeB) return 'stronger';
  if (bGeA) return 'weaker';
  return 'incomparable';
}

// ─── The join (least upper bound) ────────────────────────────────────────────

/**
 * The least upper bound of `a` and `b`: the WEAKEST requirement set that is at
 * least as strong as both. Field-wise it is gate-set union, `max` of the two
 * numeric floors, and logical AND of `waivable` (not-waivable dominates). The
 * result is deeply frozen.
 *
 * `join` is commutative, associative, idempotent, and — being a true LUB —
 * satisfies the absorption laws with `atLeastAsStrong`. Those are proven in the
 * co-located test.
 */
export function joinRequirements(
  a: ResolvedRequirements,
  b: ResolvedRequirements,
): FrozenResolvedRequirements {
  return deepFreezeRequirements({
    gates: unionGates(a.gates, b.gates),
    minimumApprovals: Math.max(a.minimumApprovals, b.minimumApprovals),
    minimumCorroboratingSources: Math.max(
      a.minimumCorroboratingSources,
      b.minimumCorroboratingSources,
    ),
    waivable: a.waivable && b.waivable,
  });
}

/**
 * Fold {@link joinRequirements} over many contributions. The empty fold is
 * {@link BOTTOM_REQUIREMENTS} — the identity of `join` — so resolution of a
 * profile that adds nothing is well-defined and total.
 */
export function joinAll(
  items: readonly ResolvedRequirements[],
): FrozenResolvedRequirements {
  return items.reduce<FrozenResolvedRequirements>(
    (acc, item) => joinRequirements(acc, item),
    BOTTOM_REQUIREMENTS,
  );
}

// ─── Deep freeze ─────────────────────────────────────────────────────────────

/**
 * Deep-freeze a requirement set: the gate array, every gate object in it, and
 * the top-level object. After this, a mutation attempt in strict mode throws —
 * the resolver can hand the value to callers without a defensive copy.
 */
export function deepFreezeRequirements(
  value: ResolvedRequirements,
): FrozenResolvedRequirements {
  const gates = canonicalizeGates(value.gates);
  for (const gate of gates) Object.freeze(gate);
  Object.freeze(gates);
  return Object.freeze({
    gates,
    minimumApprovals: value.minimumApprovals,
    minimumCorroboratingSources: value.minimumCorroboratingSources,
    waivable: value.waivable,
  });
}
