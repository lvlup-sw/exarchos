// Exit-proof tests for the requirement-resolution context (P06-03 / Task 017).
// The load-bearing property: absent / malformed danger signals normalize to
// their MOST-UNCERTAIN member, never their safest one — missing risk stays
// `unknown` and can never serialize as `low`.

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

  it('maps absent / malformed values to indeterminate, NEVER to not-touching', () => {
    // T-15 consolidation: the STRINGIFIED booleans join this list. A string
    // `'false'` is a malformed boolean, not a decided one — believing it would
    // let an untrusted stamp select the weaker (non-boundary) ladder cell on no
    // evidence, which is the DR-10 defect in miniature. The ladder-facing
    // `resolveBoundaryTouching` has always been this strict; consolidating on
    // one authority applies that strictness to the lattice form too.
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

// ─────────────────────────────────────────────────────────────────────────────
// DR-10 (T-15) — normalizer consolidation
//
// `requirement-context` and `verification-policy-resolver` used to each own a
// full copy of the tier/boundary normalization. Two authorities for one
// normalization is exactly how the two halves drift apart, which is the class
// of defect DR-10 is about. There is now ONE implementation, in
// `verification-policy-resolver` (forced direction: `phase-kind` value-imports
// the resolver, so the reverse edge would close a cycle). These tests pin the
// consolidation itself, so a future re-fork is a test failure and not a silent
// divergence.
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizer consolidation (DR-10 / T-15)', () => {
  it('re-exports the canonical implementations by IDENTITY, not by copy', () => {
    expect(normalizeRiskTier).toBe(resolveRiskTier);
    expect(normalizeBoundaryStatus).toBe(canonicalNormalizeBoundaryStatus);
  });

  it('derives the boolean boundary form FROM the three-valued lattice', () => {
    // The lattice is strictly richer (it distinguishes "known not-touching"
    // from "nobody said"), so the boolean is its projection — never the
    // reverse. Exhaustive over the lattice, plus the inputs that produce each
    // member, so the two forms cannot disagree for any input.
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

  it('resolves a joined context to a requirement set at least as strong as both', () => {
    // The set-level statement of the same property, through the REAL resolver:
    // `resolveRequirements` is monotone, so a same-call update routed through
    // the join can only ever RAISE the requirement set.
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

  it('a coordinate join alone CANNOT floor the live resolvers — the gate union must', () => {
    // The reason `executeTransition` unions gate SETS instead of just joining
    // coordinates, pinned as an executable fact rather than left in prose.
    //
    // The two live resolvers disagree about where `'unknown'` sits: the ladder
    // escalates it, the review roster reads it as "no tier claim" and so emits
    // FEWER dimensions than `'high'`. `RISK_TIER_DANGER_RANK` puts `'unknown'`
    // on top, so the coordinate join of `high` and `unknown` is `unknown` —
    // and resolving THAT coordinate through the review roster drops
    // `mutation-adequacy`, which `high` had required. A coordinate-level floor
    // would therefore weaken the transition it was supposed to protect.
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
    // …so the coordinate join is NOT a floor here…
    expect(hasMutationAdequacy(joinRiskTier('high', 'unknown'))).toBe(false);
    // …while the union of the two resolutions is.
    const union = new Set([
      ...resolveGateSet('REVIEW', { riskTier: 'high', boundaryTouching: true, workflowType: 'feature' }).map((g) => g.gate),
      ...resolveGateSet('REVIEW', { riskTier: 'unknown', boundaryTouching: true, workflowType: 'feature' }).map((g) => g.gate),
    ]);
    expect(union.has('mutation-adequacy')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DR-10 acceptance criteria 2 and 3 (T-15), end to end.
//
// These run the REAL production path — `handleInit` / `handleSet` →
// `DefaultHSMTransitionGuard.attempt` → `executeTransition` → the durable
// `phase.entered` freeze — against a real `EventStore` on disk. Nothing about
// the resolution is stubbed; the only thing the tests control is the workflow
// state and the shape of the call.
//
// Fixture: the `feature` workflow's `delegate → review` edge. Chosen because
// REVIEW is the one built-in kind whose resolved gate set is TIER-SENSITIVE in
// an observable way (`REQUIRED_REVIEWS_BY_TIER.high === ['mutation-adequacy']`),
// so "the transition was weakened" is a visible difference in the frozen
// record rather than an inference.
// ─────────────────────────────────────────────────────────────────────────────

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

  it('FrozenRequirements_TierSetInSameCall_DoesNotWeakenTransition', async () => {
    const stateFile = await initFeatureAtDelegate(dir, store);
    // The claim in force when the call begins: this workflow is high risk and
    // touches a boundary.
    await stampState(stateFile, { riskTier: 'high', boundaryTouching: true });

    // The attack: stamp a WEAKER tier in the very call that performs the
    // transition. `handleSet` applies field updates before evaluating the
    // phase guard (deliberately — guards must see the new state), so without
    // the floor this transition would be resolved, and FROZEN, at `low`.
    const result = await handleSet(
      { featureId: REVIEW_FEATURE_ID, phase: 'review', updates: { riskTier: 'low', boundaryTouching: false } },
      dir,
      store,
    );
    expect(result.success).toBe(true);

    const frozen = await frozenRecordsFor(store, 'review');
    expect(frozen).toHaveLength(1);

    // (1) The requirement set frozen for THIS transition still carries the
    //     high-tier obligation. This is the criterion verbatim.
    expect(gateNames(frozen[0])).toContain('mutation-adequacy');
    // (2) The coordinate recorded next to it is the FLOORED one, so the record
    //     is self-describing and a replay cannot mistake it for a low-tier run.
    expect(frozen[0].riskTier).toBe('high');
    expect(frozen[0].boundaryTouching).toBe(true);
    // (3) The stamp is not swallowed: it lands on the state and governs every
    //     LATER call. The floor bounds one transition, it does not veto writes.
    const after = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    expect(after.riskTier).toBe('low');
    expect(after.boundaryTouching).toBe(false);
  });

  it('CONTROL: with no stronger prior claim the same call freezes the weak set', async () => {
    // The non-vacuity partner of the test above. Identical call shape, only the
    // PRE-call claim differs — so the assertion above is sensitive to the floor
    // and not merely to REVIEW always emitting `mutation-adequacy`.
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

  it('FrozenRequirements_Replay_ReconstructsSameRequirementSet', async () => {
    const stateFile = await initFeatureAtDelegate(dir, store);
    await stampState(stateFile, { riskTier: 'high', boundaryTouching: true });

    // ── The live run: enter REVIEW at high risk and freeze. ──────────────
    expect((await handleSet({ featureId: REVIEW_FEATURE_ID, phase: 'review' }, dir, store)).success).toBe(true);

    const liveRecord = (await frozenRecordsFor(store, 'review'))[0];
    const liveSet = readFrozenRequirements(liveRecord.resolvedGates as unknown[]);
    expect(liveSet).not.toBeNull();

    // ── Replay: a left-fold of the durable log reconstructs the record. ──
    const allEvents = await store.query(REVIEW_FEATURE_ID);
    // A literal left-fold of the log through the production projection — the
    // replay a cold rebuild performs, with no access to the live run's state.
    const projected = allEvents.reduce(
      (view, event) => workflowStateProjection.apply(view, event),
      workflowStateProjection.init(),
    ) as unknown as { phaseObligation?: { resolvedGates?: unknown[]; riskTier?: string } };
    const replayedSet = readFrozenRequirements(projected.phaseObligation?.resolvedGates);
    expect(replayedSet).not.toBeNull();

    // Content-addressed identity, not a shallow deep-equal: the two freeze to
    // the same `requirementSetDigest`, so the replay reconstructs the same
    // REQUIREMENT SET (not merely a similar-looking gate list).
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

    // ── The real content: a LATER, WEAKER attempt at the same phase reads
    //    the frozen record back as authority instead of re-resolving. ─────
    await stampState(stateFile, { phase: 'delegate', riskTier: 'low', boundaryTouching: false });
    const laterState = JSON.parse(await fs.readFile(stateFile, 'utf-8')) as Record<string, unknown>;
    const guard = new DefaultHSMTransitionGuard();
    // No `priorState`: criterion 2's same-call floor is deliberately OFF here,
    // isolating criterion 3. Everything the later attempt knows says `low`.
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
    // The re-resolution alone would have produced a STRICTLY WEAKER set — this
    // is what makes the assertion below non-vacuous. Compared like-with-like:
    // the frozen record holds the LIVE path's gate sequence, so the rival is
    // the live path's resolution at the new, weaker coordinate.
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
    // …yet the frozen set stands: same digest, and the reconciliation reports
    // that the weaker re-resolution added nothing.
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

    // ── And the same read-back holds when the later attempt makes NO claim
    //    at all. This is the third DR-10 collapse site: the freeze boundary
    //    used to read `(state.riskTier ?? 'low')` / `Boolean(boundary)`, so an
    //    UNCLASSIFIED workflow minted a frozen record that reads as a
    //    deliberate low-risk, non-boundary classification — on no evidence,
    //    and at the one point in the system whose whole job is to be believed
    //    later. ──────────────────────────────────────────────────────────────
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
    // The absence of a claim is recorded AS an absence, never as `'low'`.
    expect(thirdRecord.riskTier).toBe('unknown');
    expect(thirdRecord.boundaryTouching).toBe(true);
    // …and the frozen obligation still stands, read back off the log rather
    // than re-resolved from a state that now says nothing.
    expect(gateNames(thirdRecord)).toContain('mutation-adequacy');
    expect(digestOf(readFrozenRequirements(thirdRecord.resolvedGates as unknown[])!)).toBe(
      digestOf(liveSet!),
    );

    // ── Finally: the frozen GATE SEQUENCE is the authority, not a
    //    re-resolution of the frozen coordinate. Re-resolving would silently
    //    return whatever the policy table says TODAY and present it as the
    //    frozen obligation — so an in-flight phase could be weakened by a
    //    policy edit between two attempts. Injecting a resolver that has
    //    "lost" the high-tier dimension stands in for that edit. ────────────
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
