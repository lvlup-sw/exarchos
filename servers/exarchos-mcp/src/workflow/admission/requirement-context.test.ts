// Exit-proof tests for the requirement-resolution context (P06-03 / Task 017).
// The load-bearing property: absent / malformed danger signals normalize to
// their MOST-UNCERTAIN member, never their safest one — missing risk stays
// `unknown` and can never serialize as `low`.

import { describe, expect, it } from 'vitest';
import type { ProjectionFreshness } from '../../projections/freshness.js';
import {
  BOUNDARY_STATUSES,
  buildRequirementContext,
  normalizeBoundaryStatus,
  normalizeRiskTier,
  OPEN_POLICY_FLOOR,
  RELIABILITY_STATES,
  reliabilityFromFreshness,
  RESOLVED_RISK_TIERS,
} from './requirement-context.js';

const freshness = (over: Partial<ProjectionFreshness>): ProjectionFreshness => ({
  degraded: false,
  eventTail: 0,
  projectionCursor: 0,
  lag: 0,
  staleViews: [],
  ...over,
});

describe('normalizeRiskTier', () => {
  it('passes the three known tiers through unchanged', () => {
    expect(normalizeRiskTier('low')).toBe('low');
    expect(normalizeRiskTier('medium')).toBe('medium');
    expect(normalizeRiskTier('high')).toBe('high');
  });

  it('maps absent / malformed values to unknown, NEVER to low', () => {
    for (const bad of [undefined, null, '', 'LOW', 'low-priority', 'critical', 0, 3, {}, [], NaN]) {
      const out = normalizeRiskTier(bad);
      expect(out).toBe('unknown');
      expect(out).not.toBe('low');
    }
  });
});

describe('normalizeBoundaryStatus', () => {
  it('maps a decided boolean (or its string form) to touching / not-touching', () => {
    expect(normalizeBoundaryStatus(true)).toBe('touching');
    expect(normalizeBoundaryStatus('true')).toBe('touching');
    expect(normalizeBoundaryStatus('touching')).toBe('touching');
    expect(normalizeBoundaryStatus(false)).toBe('not-touching');
    expect(normalizeBoundaryStatus('false')).toBe('not-touching');
    expect(normalizeBoundaryStatus('not-touching')).toBe('not-touching');
  });

  it('maps absent / malformed values to indeterminate, NEVER to not-touching', () => {
    for (const bad of [undefined, null, '', 'maybe', 1, 0, {}, []]) {
      const out = normalizeBoundaryStatus(bad);
      expect(out).toBe('indeterminate');
      expect(out).not.toBe('not-touching');
    }
  });
});

describe('reliabilityFromFreshness', () => {
  it('maps a degraded verdict to degraded and a healthy verdict to reliable', () => {
    expect(reliabilityFromFreshness(freshness({ degraded: true, reason: 'projection-behind', lag: 5 }))).toBe('degraded');
    expect(reliabilityFromFreshness(freshness({ degraded: false }))).toBe('reliable');
  });

  it('maps the ABSENCE of a verdict to unknown, NEVER to reliable', () => {
    const out = reliabilityFromFreshness(undefined);
    expect(out).toBe('unknown');
    expect(out).not.toBe('reliable');
  });
});

describe('buildRequirementContext — no default-low / default-non-boundary coercion', () => {
  it('RequirementContext_MissingRisk_RemainsUnknown', () => {
    const ctx = buildRequirementContext({ phaseKind: 'IMPLEMENT' });
    expect(ctx.risk).toBe('unknown');
  });

  it('missing risk cannot serialize as low', () => {
    const ctx = buildRequirementContext({ phaseKind: 'IMPLEMENT' });
    const json = JSON.stringify(ctx);
    expect(json).toContain('"risk":"unknown"');
    expect(json).not.toContain('"risk":"low"');
  });

  it('missing boundary remains indeterminate, missing reliability remains unknown', () => {
    const ctx = buildRequirementContext({ phaseKind: 'PLAN' });
    expect(ctx.boundary).toBe('indeterminate');
    expect(ctx.reliability).toBe('unknown');
  });

  it('applies the open policy floor and empty declarations when absent', () => {
    const ctx = buildRequirementContext({ phaseKind: 'REVIEW' });
    expect(ctx.policy).toEqual(OPEN_POLICY_FLOOR);
    expect(ctx.declaredGates).toEqual([]);
  });

  it('accepts a ProjectionFreshness verdict directly as the reliability input', () => {
    const degraded = buildRequirementContext({
      phaseKind: 'IMPLEMENT',
      reliability: freshness({ degraded: true, reason: 'projection-ahead', lag: -2 }),
    });
    expect(degraded.reliability).toBe('degraded');
    const healthy = buildRequirementContext({
      phaseKind: 'IMPLEMENT',
      reliability: freshness({ degraded: false }),
    });
    expect(healthy.reliability).toBe('reliable');
  });

  it('honours explicitly-provided known values', () => {
    const ctx = buildRequirementContext({
      phaseKind: 'IMPLEMENT',
      risk: 'medium',
      boundary: true,
      reliability: 'reliable',
    });
    expect(ctx.risk).toBe('medium');
    expect(ctx.boundary).toBe('touching');
    expect(ctx.reliability).toBe('reliable');
  });

  it('is deterministic — same input, same context', () => {
    const input = { phaseKind: 'IMPLEMENT', risk: 'high', boundary: false } as const;
    expect(buildRequirementContext(input)).toEqual(buildRequirementContext(input));
  });
});

describe('context danger orderings are total chains topped by the uncertain member', () => {
  it('risk chain ends in unknown', () => {
    expect(RESOLVED_RISK_TIERS[RESOLVED_RISK_TIERS.length - 1]).toBe('unknown');
    expect(RESOLVED_RISK_TIERS[0]).toBe('low');
  });
  it('boundary chain ends in indeterminate', () => {
    expect(BOUNDARY_STATUSES[BOUNDARY_STATUSES.length - 1]).toBe('indeterminate');
  });
  it('reliability chain ends in unknown', () => {
    expect(RELIABILITY_STATES[RELIABILITY_STATES.length - 1]).toBe('unknown');
  });
});
