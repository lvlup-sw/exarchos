// Tests for the requirement-resolution context.
// An absent or malformed danger signal normalizes to its most uncertain member, not its safest one.
// A missing risk stays `unknown` and does not serialize as `low`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProjectionFreshness } from '../../../../src/projections/freshness.js';
import {
  BOUNDARY_STATUSES,
  buildRequirementContext,
  dangerBoundaryTouching,
  joinDangerCoordinates,
  joinRequirementContexts,
  joinRiskTier,
  normalizeBoundaryStatus,
  normalizeRiskTier,
  OPEN_POLICY_FLOOR,
  RELIABILITY_STATES,
  reliabilityFromFreshness,
  resolveDangerCoordinate,
  RESOLVED_RISK_TIERS,
  RISK_TIER_DANGER_RANK,
  type DangerCoordinate,
  type ResolvedRiskTier,
} from '../../../../src/workflow/admission/requirement-context.js';
import {
  boundaryStatusTouches,
  normalizeBoundaryStatus as canonicalNormalizeBoundaryStatus,
  resolveBoundaryTouching,
  resolveRiskTier,
} from '../../../../src/workflow/verification-policy-resolver.js';
import { resolveRequirements } from '../../../../src/workflow/admission/requirement-resolution.js';
import { resolveGateSet } from '../../../../src/workflow/phase-kind.js';
import {
  atLeastAsStrong,
  BOTTOM_REQUIREMENTS,
  compareStrength,
  deepFreezeRequirements,
} from '../../../../src/workflow/admission/requirement-strength.js';
import {
  freezeRequirements,
  readFrozenRequirements,
  reconcileFrozenRequirements,
} from '../../../../src/workflow/admission/freeze-requirements.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import { PhaseAttemptIdSchema } from '../../../../src/workflow/admission/types.js';
import { DefaultHSMTransitionGuard } from '../../../../src/workflow/hsm-transition-guard.js';
import { EventStore } from '../../../../src/events/store.js';
import { workflowStateProjection } from '../../../../src/projections/views/workflow-state-projection.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { handleInit, handleSet } from '../../../../src/workflow/tools.js';

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
  it('maps a decided boolean (or the lattice vocabulary) to touching / not-touching', () => {
    expect(normalizeBoundaryStatus(true)).toBe('touching');
    expect(normalizeBoundaryStatus('touching')).toBe('touching');
    expect(normalizeBoundaryStatus(false)).toBe('not-touching');
    expect(normalizeBoundaryStatus('not-touching')).toBe('not-touching');
  });

  /**
   * A stringified boolean such as `'false'` is malformed, not decided.
   * If the normalizer accepts it, an untrusted stamp selects the weaker ladder cell without evidence.
   */
  it('maps absent / malformed values to indeterminate, NEVER to not-touching', () => {
    for (const bad of [undefined, null, '', 'true', 'false', 'maybe', 1, 0, {}, []]) {
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

/**
 * `verification-policy-resolver` holds the one implementation of the tier and boundary normalizers.
 * `requirement-context` re-exports it, so a second copy fails these tests.
 * The resolver owns it because `phase-kind` value-imports the resolver. An import in the reverse direction closes a cycle.
 */
describe('normalizer consolidation (DR-10 / T-15)', () => {
  it('re-exports the canonical implementations by IDENTITY, not by copy', () => {
    expect(normalizeRiskTier).toBe(resolveRiskTier);
    expect(normalizeBoundaryStatus).toBe(canonicalNormalizeBoundaryStatus);
  });

  /**
   * The lattice separates a known `not-touching` from no claim, so the boolean form is its projection.
   * The test covers each lattice member and inputs that produce each member.
   */
  it('derives the boolean boundary form FROM the three-valued lattice', () => {
    for (const status of BOUNDARY_STATUSES) {
      expect(boundaryStatusTouches(status)).toBe(status !== 'not-touching');
    }
    for (const raw of [true, false, 'touching', 'not-touching', undefined, null, 42, 'yes']) {
      expect(resolveBoundaryTouching(raw)).toBe(
        boundaryStatusTouches(normalizeBoundaryStatus(raw)),
      );
      expect(dangerBoundaryTouching(resolveDangerCoordinate({ boundary: raw }))).toBe(
        resolveBoundaryTouching(raw),
      );
    }
  });
});

describe('danger-coordinate join is a monotone floor (DR-10 / T-15)', () => {
  const coordinates: readonly DangerCoordinate[] = RESOLVED_RISK_TIERS.flatMap((risk) =>
    BOUNDARY_STATUSES.map((boundary) => ({ risk, boundary })),
  );

  it('never lowers either axis below what EITHER side asserted', () => {
    for (const a of coordinates) {
      for (const b of coordinates) {
        const joined = joinDangerCoordinates(a, b);
        for (const side of [a, b]) {
          expect(RISK_TIER_DANGER_RANK[joined.risk]).toBeGreaterThanOrEqual(
            RISK_TIER_DANGER_RANK[side.risk],
          );
          if (dangerBoundaryTouching(side)) {
            expect(dangerBoundaryTouching(joined)).toBe(true);
          }
        }
      }
    }
  });

  it('is commutative and idempotent, so applying a floor twice adds nothing', () => {
    for (const a of coordinates) {
      expect(joinDangerCoordinates(a, a)).toEqual(a);
      for (const b of coordinates) {
        expect(joinDangerCoordinates(a, b)).toEqual(joinDangerCoordinates(b, a));
      }
    }
  });

  /** `resolveRequirements` is monotone, so a same-call update through the join can only raise the requirement set. */
  it('resolves a joined context to a requirement set at least as strong as both', () => {
    const ctx = (risk: ResolvedRiskTier, boundary: DangerCoordinate['boundary']) =>
      buildRequirementContext({ phaseKind: 'REVIEW', risk, boundary, workflowType: 'feature' });
    for (const a of coordinates) {
      for (const b of coordinates) {
        const joined = joinRequirementContexts(ctx(a.risk, a.boundary), ctx(b.risk, b.boundary));
        const resolvedJoin = deepFreezeRequirements(resolveRequirements(joined));
        expect(atLeastAsStrong(resolvedJoin, deepFreezeRequirements(resolveRequirements(ctx(a.risk, a.boundary))))).toBe(true);
        expect(atLeastAsStrong(resolvedJoin, deepFreezeRequirements(resolveRequirements(ctx(b.risk, b.boundary))))).toBe(true);
      }
    }
  });

  /**
   * This test pins why `executeTransition` unions gate sets and does not only join coordinates.
   * The ladder escalates `'unknown'`, but the review roster reads it as no tier claim and emits fewer dimensions than `'high'`.
   * `RISK_TIER_DANGER_RANK` puts `'unknown'` on top, so the join of `high` and `unknown` is `unknown`.
   * The review roster then drops `mutation-adequacy`, which `high` requires. The union of the two gate sets keeps it.
   */
  it('a coordinate join alone CANNOT floor the live resolvers — the gate union must', () => {
    const hasMutationAdequacy = (risk: ResolvedRiskTier) =>
      resolveGateSet('REVIEW', {
        riskTier: risk,
        boundaryTouching: true,
        workflowType: 'feature',
      }).some((g) => g.gate === 'mutation-adequacy');

    expect(hasMutationAdequacy('high')).toBe(true);
    expect(hasMutationAdequacy('unknown')).toBe(false);
    expect(joinDangerCoordinates(
      { risk: 'high', boundary: 'touching' },
      { risk: 'unknown', boundary: 'touching' },
    ).risk).toBe('unknown');
    expect(hasMutationAdequacy(joinRiskTier('high', 'unknown'))).toBe(false);
    const union = new Set([
      ...resolveGateSet('REVIEW', { riskTier: 'high', boundaryTouching: true, workflowType: 'feature' }).map((g) => g.gate),
      ...resolveGateSet('REVIEW', { riskTier: 'unknown', boundaryTouching: true, workflowType: 'feature' }).map((g) => g.gate),
    ]);
    expect(union.has('mutation-adequacy')).toBe(true);
  });
});

const REVIEW_FEATURE_ID = 'dr10-t15';

async function initFeatureAtDelegate(dir: string, store: EventStore): Promise<string> {
  await handleInit({ featureId: REVIEW_FEATURE_ID, workflowType: 'feature' }, dir, store);
  const stateFile = path.join(dir, `${REVIEW_FEATURE_ID}.state.json`);
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  raw.phase = 'delegate';
  raw.tasks = [];
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
  return stateFile;
}

/** Stamp fields onto the state file WITHOUT going through a transition. */
async function stampState(stateFile: string, fields: Record<string, unknown>): Promise<void> {
  const raw = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
  Object.assign(raw, fields);
  await fs.writeFile(stateFile, JSON.stringify(raw, null, 2), 'utf-8');
}

/** The frozen `phase.entered` record for `phase`, read back off the durable log. */
async function frozenRecordsFor(
  store: EventStore,
  phase: string,
): Promise<Record<string, unknown>[]> {
  const entered = await store.query(REVIEW_FEATURE_ID, { type: 'phase.entered' as never });
  return entered
    .map((e) => e.data as Record<string, unknown>)
    .filter((d) => d.phase === phase);
}

const gateNames = (record: Record<string, unknown>): string[] =>
  (record.resolvedGates as { gate: string }[]).map((g) => g.gate).sort();

/**
 * These tests run the production path from `handleSet` to the durable `phase.entered` freeze, against a real `EventStore`.
 * The fixture is the `delegate → review` edge of the `feature` workflow.
 * At the `high` tier, REVIEW adds `mutation-adequacy`, so a weakened transition shows in the frozen record.
 */
describe('DR-10 frozen requirement set is the authority (T-15)', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dr10-t15-'));
    store = new EventStore(dir);
    await store.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(dir);
  });

  /**
   * The state claims high risk and a boundary touch, and the call stamps a weaker tier.
   * `handleSet` applies field updates before the phase guard runs, so without the floor the transition freezes at `low`.
   * The frozen set keeps the high-tier obligation and records the floored coordinate.
   * The weaker stamp still lands on the state and governs later calls.
   */
  it('FrozenRequirements_TierSetInSameCall_DoesNotWeakenTransition', async () => {
    const stateFile = await initFeatureAtDelegate(dir, store);
    await stampState(stateFile, { riskTier: 'high', boundaryTouching: true });

    const result = await handleSet(
      { featureId: REVIEW_FEATURE_ID, phase: 'review', updates: { riskTier: 'low', boundaryTouching: false } },
      dir,
      store,
    );
    expect(result.success).toBe(true);

    const frozen = await frozenRecordsFor(store, 'review');
    expect(frozen).toHaveLength(1);

    expect(gateNames(frozen[0])).toContain('mutation-adequacy');
    expect(frozen[0].riskTier).toBe('high');
    expect(frozen[0].boundaryTouching).toBe(true);
    const after = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    expect(after.riskTier).toBe('low');
    expect(after.boundaryTouching).toBe(false);
  });

  /**
   * The call shape matches the same-call floor test, and only the claim before the call differs.
   * This shows that the floor test depends on the floor, not on REVIEW always emitting `mutation-adequacy`.
   */
  it('CONTROL: with no stronger prior claim the same call freezes the weak set', async () => {
    const stateFile = await initFeatureAtDelegate(dir, store);
    await stampState(stateFile, { riskTier: 'low', boundaryTouching: false });

    const result = await handleSet(
      { featureId: REVIEW_FEATURE_ID, phase: 'review', updates: { riskTier: 'low', boundaryTouching: false } },
      dir,
      store,
    );
    expect(result.success).toBe(true);

    const frozen = await frozenRecordsFor(store, 'review');
    expect(frozen).toHaveLength(1);
    expect(gateNames(frozen[0])).not.toContain('mutation-adequacy');
    expect(frozen[0].riskTier).toBe('low');
  });

  /**
   * A left-fold of the durable log through the production projection gives the same `requirementSetDigest` as the live run.
   * A later attempt at `low` reads the frozen record back as authority, though a re-resolution at `low` lacks `mutation-adequacy`.
   * That re-resolution uses `resolveGateSet`, as the live path does, so the two sets compare like with like.
   * The later attempts pass no `priorState`, so the same-call floor is off.
   *
   * An attempt with no tier claim records `unknown` and a boundary touch, not `low`, and keeps the frozen set.
   * An injected resolver without the high-tier dimension stands in for a policy edit, and the frozen gate sequence still holds.
   */
  it('FrozenRequirements_Replay_ReconstructsSameRequirementSet', async () => {
    const stateFile = await initFeatureAtDelegate(dir, store);
    await stampState(stateFile, { riskTier: 'high', boundaryTouching: true });

    expect((await handleSet({ featureId: REVIEW_FEATURE_ID, phase: 'review' }, dir, store)).success).toBe(true);

    const liveRecord = (await frozenRecordsFor(store, 'review'))[0];
    const liveSet = readFrozenRequirements(liveRecord.resolvedGates as unknown[]);
    expect(liveSet).not.toBeNull();

    const allEvents = await store.query(REVIEW_FEATURE_ID);
    const projected = allEvents.reduce(
      (view, event) => workflowStateProjection.apply(view, event),
      workflowStateProjection.init(),
    ) as unknown as { phaseObligation?: { resolvedGates?: unknown[]; riskTier?: string } };
    const replayedSet = readFrozenRequirements(projected.phaseObligation?.resolvedGates);
    expect(replayedSet).not.toBeNull();

    const attemptId = PhaseAttemptIdSchema.parse('phase-attempt-dr10-t15-001');
    const subject = createEvidenceSubject(
      { kind: 'phase-attempt', phaseAttemptId: attemptId },
      { phase: 'review', attempt: 1 },
    );
    const digestOf = (set: NonNullable<typeof liveSet>) =>
      JSON.stringify(
        freezeRequirements({ resolved: set, phaseAttemptId: attemptId, subject })
          .requirementSetDigest,
      );
    expect(digestOf(replayedSet!)).toBe(digestOf(liveSet!));
    expect(projected.phaseObligation?.riskTier).toBe('high');

    await stampState(stateFile, { phase: 'delegate', riskTier: 'low', boundaryTouching: false });
    const laterState = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    const guard = new DefaultHSMTransitionGuard();
    const later = await guard.attempt(REVIEW_FEATURE_ID, 'delegate', 'review', {
      state: laterState,
      workflowType: 'feature',
      eventStore: store,
    });
    expect(later.ok).toBe(true);

    const records = await frozenRecordsFor(store, 'review');
    expect(records).toHaveLength(2);
    const laterSet = readFrozenRequirements(records[1].resolvedGates as unknown[]);
    expect(laterSet).not.toBeNull();
    const reresolved = deepFreezeRequirements({
      ...BOTTOM_REQUIREMENTS,
      gates: resolveGateSet('REVIEW', {
        riskTier: 'low',
        boundaryTouching: false,
        workflowType: 'feature',
      }),
    });
    expect(reresolved.gates.some((g) => g.gate === 'mutation-adequacy')).toBe(false);
    expect(atLeastAsStrong(reresolved, liveSet!)).toBe(false);
    expect(digestOf(laterSet!)).toBe(digestOf(liveSet!));
    expect(
      reconcileFrozenRequirements({
        frozen: liveSet!,
        reresolved,
        phaseAttemptId: attemptId,
        subject,
      }).authority,
    ).toBe('frozen');
    expect(compareStrength(laterSet!, liveSet!)).toBe('eq');

    const unclassified = { ...laterState };
    delete unclassified.riskTier;
    delete unclassified.boundaryTouching;
    unclassified.phase = 'delegate';
    const third = await guard.attempt(REVIEW_FEATURE_ID, 'delegate', 'review', {
      state: unclassified,
      workflowType: 'feature',
      eventStore: store,
    });
    expect(third.ok).toBe(true);

    const thirdRecord = (await frozenRecordsFor(store, 'review'))[2];
    expect(thirdRecord.riskTier).toBe('unknown');
    expect(thirdRecord.boundaryTouching).toBe(true);
    expect(gateNames(thirdRecord)).toContain('mutation-adequacy');
    expect(digestOf(readFrozenRequirements(thirdRecord.resolvedGates as unknown[])!)).toBe(
      digestOf(liveSet!),
    );

    const drifted = await guard.attempt(REVIEW_FEATURE_ID, 'delegate', 'review', {
      state: { ...unclassified },
      workflowType: 'feature',
      eventStore: store,
      resolveGatesFn: () => [{ family: 'review', gate: 'review' } as const],
    });
    expect(drifted.ok).toBe(true);
    const driftedRecord = (await frozenRecordsFor(store, 'review'))[3];
    expect(gateNames(driftedRecord)).toContain('mutation-adequacy');
    expect(digestOf(readFrozenRequirements(driftedRecord.resolvedGates as unknown[])!)).toBe(
      digestOf(liveSet!),
    );
  });
});
