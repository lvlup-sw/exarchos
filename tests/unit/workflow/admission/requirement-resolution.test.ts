// Exit-proof + monotonicity property tests for monotonic requirement resolution
// (P06-03 / Task 018). Proves, across the full input lattice:
//   (a) raising risk never weakens the requirement set,
//   (b) raising boundary-touching never weakens it,
//   (c) reliability uncertainty / degradation never weakens it,
//   (d) `unknown` risk resolves at least as strong as `high` and never as `low`,
//   (e) the resolved set is complete and deeply frozen,
// plus totality, determinism, and the "reliability only adds corroboration" rule.

import { describe, expect, it } from 'vitest';
import type { PhaseKind, ResolvedGate } from '../../../../src/workflow/phase-kind.js';
import {
  BOUNDARY_STATUSES,
  OPEN_POLICY_FLOOR,
  RELIABILITY_STATES,
  RESOLVED_RISK_TIERS,
  type RequirementContext,
} from '../../../../src/workflow/admission/requirement-context.js';
import {
  atLeastAsStrong,
  canonicalGateKey,
  compareStrength,
  type ResolvedRequirements,
} from '../../../../src/workflow/admission/requirement-strength.js';
import {
  effectiveBoundaryTouching,
  effectiveRiskTier,
  resolveRequirements,
} from '../../../../src/workflow/admission/requirement-resolution.js';

const KINDS: readonly PhaseKind[] = [
  'IMPLEMENT',
  'PLAN',
  'REVIEW',
  'SYNTHESIZE',
  'MERGE',
  'GATHER',
];

function makeCtx(over: Partial<RequirementContext> = {}): RequirementContext {
  return {
    phaseKind: 'IMPLEMENT',
    risk: 'low',
    boundary: 'not-touching',
    reliability: 'reliable',
    declaredGates: [],
    policy: OPEN_POLICY_FLOOR,
    workflowType: 'feature',
    ...over,
  };
}

const gateKeys = (r: ResolvedRequirements): readonly string[] =>
  r.gates.map(canonicalGateKey);

describe('effective danger projections', () => {
  it('projects unknown risk to the strongest KNOWN tier (high), never low', () => {
    expect(effectiveRiskTier('unknown')).toBe('high');
    expect(effectiveRiskTier('unknown')).not.toBe('low');
    expect(effectiveRiskTier('low')).toBe('low');
    expect(effectiveRiskTier('medium')).toBe('medium');
    expect(effectiveRiskTier('high')).toBe('high');
  });

  it('projects indeterminate boundary to touching, never not-touching', () => {
    expect(effectiveBoundaryTouching('indeterminate')).toBe(true);
    expect(effectiveBoundaryTouching('touching')).toBe(true);
    expect(effectiveBoundaryTouching('not-touching')).toBe(false);
  });
});

describe('(a) raising risk never weakens the requirement set', () => {
  it('is monotone in risk across every (kind, boundary, reliability) cell', () => {
    for (const phaseKind of KINDS) {
      for (const boundary of BOUNDARY_STATUSES) {
        for (const reliability of RELIABILITY_STATES) {
          for (let i = 1; i < RESOLVED_RISK_TIERS.length; i++) {
            const lo = RESOLVED_RISK_TIERS[i - 1];
            const hi = RESOLVED_RISK_TIERS[i];
            if (lo === undefined || hi === undefined) continue;
            const lower = resolveRequirements(makeCtx({ phaseKind, boundary, reliability, risk: lo }));
            const higher = resolveRequirements(makeCtx({ phaseKind, boundary, reliability, risk: hi }));
            expect(atLeastAsStrong(higher, lower)).toBe(true);
          }
        }
      }
    }
  });
});

describe('(b) raising boundary-touching never weakens the requirement set', () => {
  it('is monotone in boundary across every (kind, risk, reliability) cell', () => {
    for (const phaseKind of KINDS) {
      for (const risk of RESOLVED_RISK_TIERS) {
        for (const reliability of RELIABILITY_STATES) {
          for (let i = 1; i < BOUNDARY_STATUSES.length; i++) {
            const lo = BOUNDARY_STATUSES[i - 1];
            const hi = BOUNDARY_STATUSES[i];
            if (lo === undefined || hi === undefined) continue;
            const lower = resolveRequirements(makeCtx({ phaseKind, risk, reliability, boundary: lo }));
            const higher = resolveRequirements(makeCtx({ phaseKind, risk, reliability, boundary: hi }));
            expect(atLeastAsStrong(higher, lower)).toBe(true);
          }
        }
      }
    }
  });
});

describe('(c) reliability uncertainty / degradation never weakens the requirement set', () => {
  it('is monotone in reliability across every (kind, risk, boundary) cell', () => {
    for (const phaseKind of KINDS) {
      for (const risk of RESOLVED_RISK_TIERS) {
        for (const boundary of BOUNDARY_STATUSES) {
          for (let i = 1; i < RELIABILITY_STATES.length; i++) {
            const lo = RELIABILITY_STATES[i - 1];
            const hi = RELIABILITY_STATES[i];
            if (lo === undefined || hi === undefined) continue;
            const lower = resolveRequirements(makeCtx({ phaseKind, risk, boundary, reliability: lo }));
            const higher = resolveRequirements(makeCtx({ phaseKind, risk, boundary, reliability: hi }));
            expect(atLeastAsStrong(higher, lower)).toBe(true);
          }
        }
      }
    }
  });

  it('consumes reliability ONLY as corroboration — never removes gates or lowers approvals', () => {
    for (const phaseKind of KINDS) {
      const reliable = resolveRequirements(makeCtx({ phaseKind, risk: 'high', reliability: 'reliable' }));
      const degraded = resolveRequirements(makeCtx({ phaseKind, risk: 'high', reliability: 'degraded' }));
      const unknown = resolveRequirements(makeCtx({ phaseKind, risk: 'high', reliability: 'unknown' }));
      // identical gates and approvals; only corroboration may rise.
      expect(gateKeys(degraded)).toEqual(gateKeys(reliable));
      expect(gateKeys(unknown)).toEqual(gateKeys(reliable));
      expect(degraded.minimumApprovals).toBe(reliable.minimumApprovals);
      expect(unknown.minimumApprovals).toBe(reliable.minimumApprovals);
      expect(degraded.minimumCorroboratingSources).toBeGreaterThan(reliable.minimumCorroboratingSources);
      expect(unknown.minimumCorroboratingSources).toBeGreaterThanOrEqual(degraded.minimumCorroboratingSources);
    }
  });
});

describe('(d) unknown risk resolves at least as strong as high, never as low', () => {
  it('unknown ≥ high and unknown is STRICTLY stronger than low, for every kind', () => {
    for (const phaseKind of KINDS) {
      const low = resolveRequirements(makeCtx({ phaseKind, risk: 'low' }));
      const high = resolveRequirements(makeCtx({ phaseKind, risk: 'high' }));
      const unknown = resolveRequirements(makeCtx({ phaseKind, risk: 'unknown' }));
      expect(atLeastAsStrong(unknown, high)).toBe(true);
      expect(compareStrength(unknown, low)).toBe('stronger');
      // the gate obligations of unknown are a SUPERSET of the strongest known tier's
      expect(new Set(gateKeys(high)).size).toBeLessThanOrEqual(new Set(gateKeys(unknown)).size);
      for (const key of gateKeys(high)) expect(gateKeys(unknown)).toContain(key);
    }
  });

  it('never coerces unknown down to the low-tier resolution', () => {
    const low = resolveRequirements(makeCtx({ phaseKind: 'IMPLEMENT', risk: 'low' }));
    const unknown = resolveRequirements(makeCtx({ phaseKind: 'IMPLEMENT', risk: 'unknown' }));
    expect(atLeastAsStrong(unknown, low)).toBe(true);
    expect(atLeastAsStrong(low, unknown)).toBe(false);
  });
});

describe('(e) the resolved set is complete and deeply frozen', () => {
  it('carries every field and freezes at every level', () => {
    const r = resolveRequirements(makeCtx({ risk: 'high', boundary: 'touching' }));
    expect(r).toHaveProperty('gates');
    expect(r).toHaveProperty('minimumApprovals');
    expect(r).toHaveProperty('minimumCorroboratingSources');
    expect(r).toHaveProperty('waivable');
    expect(Array.isArray(r.gates)).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.gates)).toBe(true);
    if (r.gates.length > 0) expect(Object.isFrozen(r.gates[0])).toBe(true);
  });

  it('rejects mutation in strict mode', () => {
    const r = resolveRequirements(makeCtx({ risk: 'high' }));
    expect(() => {
      (r as unknown as { minimumApprovals: number }).minimumApprovals = 42;
    }).toThrow();
    expect(() => {
      (r.gates as unknown as ResolvedGate[]).push({ family: 'ladder', gate: 'check_static_analysis' });
    }).toThrow();
  });
});

describe('resolver totality and determinism', () => {
  it('resolves every lattice cell without throwing', () => {
    for (const phaseKind of KINDS) {
      for (const risk of RESOLVED_RISK_TIERS) {
        for (const boundary of BOUNDARY_STATUSES) {
          for (const reliability of RELIABILITY_STATES) {
            expect(() =>
              resolveRequirements(makeCtx({ phaseKind, risk, boundary, reliability })),
            ).not.toThrow();
          }
        }
      }
    }
  });

  it('is deterministic — same context, structurally equal result', () => {
    const ctx = makeCtx({ risk: 'medium', boundary: 'indeterminate', reliability: 'degraded' });
    expect(resolveRequirements(ctx)).toEqual(resolveRequirements(ctx));
  });
});

describe('resolver — pinned gate wiring (IMPLEMENT verification ladder)', () => {
  it('high + touching yields the full boundary ladder', () => {
    const r = resolveRequirements(makeCtx({ phaseKind: 'IMPLEMENT', risk: 'high', boundary: 'touching' }));
    const ladder = r.gates.filter((g) => g.family === 'ladder').map((g) => g.gate);
    expect(ladder).toEqual(
      expect.arrayContaining([
        'check_static_analysis',
        'check_test_adequacy',
        'check_integration_suite',
        'check_contract_drift',
        'check_mock_boundary',
      ]),
    );
  });

  it('unknown + not-touching resolves to the high-tier base ladder plus corroboration', () => {
    const r = resolveRequirements(makeCtx({ phaseKind: 'IMPLEMENT', risk: 'unknown', boundary: 'not-touching' }));
    const ladder = r.gates.filter((g) => g.family === 'ladder').map((g) => g.gate);
    expect(ladder).toEqual(
      expect.arrayContaining([
        'check_static_analysis',
        'check_test_adequacy',
        'check_integration_suite',
      ]),
    );
    expect(ladder).not.toContain('check_mock_boundary'); // not-touching ⇒ no boundary gates
    expect(r.minimumApprovals).toBeGreaterThanOrEqual(1);
    expect(r.minimumCorroboratingSources).toBeGreaterThanOrEqual(2); // unknown ⇒ corroboration
  });
});

describe('secondary monotone dimensions — declarations and policy', () => {
  it('adding a declared gate never weakens', () => {
    const base = resolveRequirements(makeCtx({ risk: 'low' }));
    const declared = resolveRequirements(
      makeCtx({ risk: 'low', declaredGates: [{ family: 'ladder', gate: 'check_contract_drift' }] }),
    );
    expect(atLeastAsStrong(declared, base)).toBe(true);
  });

  it('raising the policy floor never weakens', () => {
    const base = resolveRequirements(makeCtx({ risk: 'low' }));
    const stricter = resolveRequirements(
      makeCtx({ risk: 'low', policy: { minimumApprovals: 3, waivable: false } }),
    );
    expect(atLeastAsStrong(stricter, base)).toBe(true);
    expect(stricter.minimumApprovals).toBe(3);
    expect(stricter.waivable).toBe(false);
  });
});
