// Exit-proof + algebraic-law tests for the requirement-strength partial order
// (P06-03 / Task 042). Proves the order is reflexive, antisymmetric, transitive;
// that `join` is a true least upper bound (commutative, associative, idempotent,
// absorptive); that the order is genuinely PARTIAL (incomparable elements exist);
// and that resolved sets are deeply frozen.

import { describe, expect, it } from 'vitest';
import type { ResolvedGate } from '../phase-kind.js';
import {
  atLeastAsStrong,
  BOTTOM_REQUIREMENTS,
  canonicalGateKey,
  canonicalizeGates,
  compareStrength,
  deepFreezeRequirements,
  equalRequirements,
  joinAll,
  joinRequirements,
  type ResolvedRequirements,
} from './requirement-strength.js';

// ─── Gate atoms ──────────────────────────────────────────────────────────────

const STATIC: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const ADEQUACY: ResolvedGate = { family: 'ladder', gate: 'check_test_adequacy' };
const INTEG: ResolvedGate = { family: 'ladder', gate: 'check_integration_suite' };
const REVIEW: ResolvedGate = { family: 'review', gate: 'mutation-adequacy' };

const req = (over: Partial<ResolvedRequirements> = {}): ResolvedRequirements => ({
  gates: [],
  minimumApprovals: 0,
  minimumCorroboratingSources: 0,
  waivable: true,
  ...over,
});

// A representative spread of lattice points, chosen to exercise every field and
// to include incomparable pairs (distinct gate families / disjoint gate atoms).
const SAMPLE: readonly ResolvedRequirements[] = [
  BOTTOM_REQUIREMENTS,
  req({ gates: [STATIC] }),
  req({ gates: [STATIC, ADEQUACY] }),
  req({ gates: [STATIC, ADEQUACY, INTEG] }),
  req({ gates: [REVIEW] }),
  req({ minimumApprovals: 2 }),
  req({ minimumCorroboratingSources: 3 }),
  req({ waivable: false }),
  req({ gates: [STATIC, REVIEW], minimumApprovals: 1, minimumCorroboratingSources: 2, waivable: false }),
];

describe('requirement-strength — canonical gate sets', () => {
  it('deduplicates and sorts gates into an order-independent canonical form', () => {
    const a = canonicalizeGates([INTEG, STATIC, ADEQUACY, STATIC]);
    const b = canonicalizeGates([ADEQUACY, INTEG, STATIC]);
    expect(a.map(canonicalGateKey)).toEqual(b.map(canonicalGateKey));
    // dedup: STATIC appeared twice, must appear once.
    expect(a.filter((g) => canonicalGateKey(g) === canonicalGateKey(STATIC))).toHaveLength(1);
  });

  it('treats the gate field as a SET — same members, different order, is equal', () => {
    expect(equalRequirements(req({ gates: [STATIC, ADEQUACY] }), req({ gates: [ADEQUACY, STATIC] }))).toBe(true);
  });
});

describe('requirement-strength — partial-order laws', () => {
  it('is reflexive: a ≥ a for every element', () => {
    for (const a of SAMPLE) expect(atLeastAsStrong(a, a)).toBe(true);
  });

  it('is antisymmetric: a ≥ b and b ≥ a implies a = b', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        if (atLeastAsStrong(a, b) && atLeastAsStrong(b, a)) {
          expect(equalRequirements(a, b)).toBe(true);
        }
      }
    }
  });

  it('is transitive: a ≥ b and b ≥ c implies a ≥ c', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        for (const c of SAMPLE) {
          if (atLeastAsStrong(a, b) && atLeastAsStrong(b, c)) {
            expect(atLeastAsStrong(a, c)).toBe(true);
          }
        }
      }
    }
  });

  it('is genuinely PARTIAL: two disjoint-gate elements are incomparable', () => {
    const onlyStatic = req({ gates: [STATIC] });
    const onlyReview = req({ gates: [REVIEW] });
    expect(atLeastAsStrong(onlyStatic, onlyReview)).toBe(false);
    expect(atLeastAsStrong(onlyReview, onlyStatic)).toBe(false);
    expect(compareStrength(onlyStatic, onlyReview)).toBe('incomparable');
  });

  it('compareStrength agrees with atLeastAsStrong', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        const cmp = compareStrength(a, b);
        const aGeB = atLeastAsStrong(a, b);
        const bGeA = atLeastAsStrong(b, a);
        if (cmp === 'eq') expect(aGeB && bGeA).toBe(true);
        if (cmp === 'stronger') expect(aGeB && !bGeA).toBe(true);
        if (cmp === 'weaker') expect(!aGeB && bGeA).toBe(true);
        if (cmp === 'incomparable') expect(!aGeB && !bGeA).toBe(true);
      }
    }
  });

  it('BOTTOM is the weakest element: every element is ≥ BOTTOM', () => {
    for (const a of SAMPLE) expect(atLeastAsStrong(a, BOTTOM_REQUIREMENTS)).toBe(true);
  });
});

describe('requirement-strength — join is the least upper bound', () => {
  it('is an UPPER bound: join(a,b) ≥ a and join(a,b) ≥ b', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        const j = joinRequirements(a, b);
        expect(atLeastAsStrong(j, a)).toBe(true);
        expect(atLeastAsStrong(j, b)).toBe(true);
      }
    }
  });

  it('is the LEAST upper bound: any common upper bound c dominates join(a,b)', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        const j = joinRequirements(a, b);
        for (const c of SAMPLE) {
          if (atLeastAsStrong(c, a) && atLeastAsStrong(c, b)) {
            expect(atLeastAsStrong(c, j)).toBe(true);
          }
        }
      }
    }
  });

  it('LEAST bound is non-vacuous: a hand-built upper bound dominates the join', () => {
    const a = req({ gates: [STATIC], minimumApprovals: 1 });
    const b = req({ gates: [REVIEW], minimumCorroboratingSources: 2 });
    const j = joinRequirements(a, b); // {static,review} appr1 corrob2 waivable
    const upper = req({
      gates: [STATIC, ADEQUACY, REVIEW],
      minimumApprovals: 5,
      minimumCorroboratingSources: 4,
      waivable: false,
    });
    expect(atLeastAsStrong(upper, a)).toBe(true);
    expect(atLeastAsStrong(upper, b)).toBe(true);
    expect(atLeastAsStrong(upper, j)).toBe(true);
    // and the join is strictly weaker than that loose upper bound
    expect(compareStrength(j, upper)).toBe('weaker');
  });

  it('is commutative', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        expect(equalRequirements(joinRequirements(a, b), joinRequirements(b, a))).toBe(true);
      }
    }
  });

  it('is associative', () => {
    for (const a of SAMPLE.slice(0, 5)) {
      for (const b of SAMPLE.slice(0, 5)) {
        for (const c of SAMPLE.slice(0, 5)) {
          const left = joinRequirements(joinRequirements(a, b), c);
          const right = joinRequirements(a, joinRequirements(b, c));
          expect(equalRequirements(left, right)).toBe(true);
        }
      }
    }
  });

  it('is idempotent: join(a,a) = a', () => {
    for (const a of SAMPLE) expect(equalRequirements(joinRequirements(a, a), a)).toBe(true);
  });

  it('absorbs the order: a ≥ b iff join(a,b) = a', () => {
    for (const a of SAMPLE) {
      for (const b of SAMPLE) {
        expect(equalRequirements(joinRequirements(a, b), a)).toBe(atLeastAsStrong(a, b));
      }
    }
  });

  it('joinAll of an empty list is BOTTOM (the join identity)', () => {
    expect(equalRequirements(joinAll([]), BOTTOM_REQUIREMENTS)).toBe(true);
  });

  it('joinAll dominates every input', () => {
    const all = joinAll(SAMPLE);
    for (const a of SAMPLE) expect(atLeastAsStrong(all, a)).toBe(true);
  });
});

describe('requirement-strength — deep freeze', () => {
  it('freezes the object, the gate array, and every gate', () => {
    const frozen = deepFreezeRequirements(req({ gates: [STATIC, ADEQUACY], minimumApprovals: 1 }));
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.gates)).toBe(true);
    expect(Object.isFrozen(frozen.gates[0])).toBe(true);
  });

  it('mutation attempts throw in strict mode', () => {
    const frozen = deepFreezeRequirements(req({ gates: [STATIC] }));
    expect(() => {
      (frozen as unknown as { minimumApprovals: number }).minimumApprovals = 99;
    }).toThrow();
    expect(() => {
      (frozen.gates as unknown as ResolvedGate[]).push(ADEQUACY);
    }).toThrow();
  });

  it('BOTTOM_REQUIREMENTS is itself frozen', () => {
    expect(Object.isFrozen(BOTTOM_REQUIREMENTS)).toBe(true);
    expect(Object.isFrozen(BOTTOM_REQUIREMENTS.gates)).toBe(true);
  });
});
