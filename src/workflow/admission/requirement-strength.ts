/**
 * The strength partial order over resolved requirements, and its join.
 *
 * The order is the product of four field orders:
 *   - `gates`: set inclusion. More required gates is stronger.
 *   - `minimumApprovals` and `minimumCorroboratingSources`: a larger number is stronger.
 *   - `waivable`: `false` is stronger than `true`.
 * Two gate sets that each hold a gate the other lacks are incomparable.
 * Thus `join` must unite the gate sets and cannot pick one.
 * The unit tests prove the order and lattice laws. The module does no I/O.
 */

import type { ResolvedGate } from '../phase-kind.js';

/**
 * All the obligations of a phase attempt, as one lattice point.
 * This is not the persisted `AdmissionRequirementV1[]` shape.
 * A later freeze step projects those records, with branded ids, subjects and digests.
 */
export interface ResolvedRequirements {
  /**
   * The gates that must each produce passing evidence.
   * The list has no duplicates and is in {@link canonicalGateKey} order. A superset is stronger.
   */
  readonly gates: readonly ResolvedGate[];
  /** The minimum number of independent approvals, `>= 0`. A larger number is stronger. */
  readonly minimumApprovals: number;
  /**
   * The minimum number of independent corroborating sources. `0` means no obligation.
   * The persisted `corroboration` requirement raises a positive value to at least 2.
   * A larger number is stronger.
   */
  readonly minimumCorroboratingSources: number;
  /** True when an authorized waiver can discharge the obligations. `false` is stronger than `true`. */
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

/**
 * A stable sort key for a resolved gate: family, then gate name.
 * Thus a gate set has one canonical order. Both parts are closed vocabularies, so keys never collide.
 */
export function canonicalGateKey(gate: ResolvedGate): string {
  return `${gate.family}\u0000${gate.gate}`;
}

/** Removes duplicates and sorts a gate list into canonical order. It returns a new array. */
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

/** True when every gate in `subset` is also in `superset`. */
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

/** True when the two gate lists hold the same set of gates, in any order. */
function gatesEqual(
  a: readonly ResolvedGate[],
  b: readonly ResolvedGate[],
): boolean {
  return gatesContain(a, b) && gatesContain(b, a);
}

/**
 * True when `a` is at least as strong as `b` in every field.
 * For `waivable`, `a` must be not waivable whenever `b` is not waivable.
 * Because gates use set inclusion, the result can be false in both directions.
 */
export function atLeastAsStrong(
  a: ResolvedRequirements,
  b: ResolvedRequirements,
): boolean {
  return (
    gatesContain(a.gates, b.gates) &&
    a.minimumApprovals >= b.minimumApprovals &&
    a.minimumCorroboratingSources >= b.minimumCorroboratingSources &&
    (b.waivable || !a.waivable)
  );
}

/** True when two requirement sets are equal. It compares the gates as a set. */
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

/** Compares `a` to `b`. Only the gate-set order can make the result `'incomparable'`. */
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

/**
 * The least upper bound of `a` and `b`: the weakest set that is at least as strong as both.
 * It takes the gate union, the larger of each number, and the AND of `waivable`.
 * The result is deeply frozen.
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
 * Folds {@link joinRequirements} over many contributions.
 * An empty list gives {@link BOTTOM_REQUIREMENTS}, the identity of `join`.
 */
export function joinAll(
  items: readonly ResolvedRequirements[],
): FrozenResolvedRequirements {
  return items.reduce<FrozenResolvedRequirements>(
    (acc, item) => joinRequirements(acc, item),
    BOTTOM_REQUIREMENTS,
  );
}

/**
 * Puts the gates in canonical order, then freezes the gate array, each gate and the top-level object.
 * Thus the resolver can return the value without a defensive copy.
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
