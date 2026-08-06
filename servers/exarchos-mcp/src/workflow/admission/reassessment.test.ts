// Exit-proof tests for P06-07 — reassessment under an explicit policy version
// (Transition task 050). Proves "weaker reassessment requires an authorized
// waiver", the cross-version monotonicity guarantee:
//
//   (d) a STRONGER-OR-EQUAL reassessment proceeds WITHOUT a waiver;
//   (e) a WEAKER reassessment WITHOUT an authorized waiver FAILS CLOSED;
//   (f) a WEAKER reassessment WITH a valid authorized waiver proceeds and
//       records the weakening (via the applied waiver + explicit digest drift);
//   (g) an expired / unauthorized / out-of-scope waiver does NOT permit weakening;
//   plus: a not-waivable prior obligation set can never be weakened; the prior
//   frozen set is referenced, never mutated; authenticity of the supplied prior
//   is enforced; and same-operationId retries are idempotent.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from '../../event-store/atomic-appender.js';
import type { DecideOnceStoredEvent } from '../../event-store/atomic-appender.js';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

import { runReassessment } from './reassessment.js';
import type { ReassessmentInput } from './reassessment.js';
import { runBootstrapAttempt } from './bootstrap-attempts.js';
import { foldAdmissionStream, digestKey } from './bootstrap-generation.js';
import { selectPhaseAttempt } from './phase-attempt-state.js';
import { resolveRequirements } from './requirement-resolution.js';
import { freezeRequirements } from './freeze-requirements.js';
import type { ResolvedRequirements } from './requirement-strength.js';
import { buildRequirementContext } from './requirement-context.js';
import { createEvidenceSubject } from './evidence-subject.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
  type PolicyAuthority,
} from './policy-authority.js';
import {
  DecisionIdSchema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  WaiverProvenanceV1Schema,
  type ContentDigestV1,
  type RequirementId,
  type WaiverProvenanceV1,
  type WaiverScopeV1,
} from './types.js';
import type { ResolvedGate } from '../phase-kind.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const AT = '2026-08-03T12:00:00.000Z';
const FUTURE = '2026-08-04T12:00:00.000Z';
const PAST = '2026-08-02T12:00:00.000Z';
const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };
const digestB: ContentDigestV1 = { algorithm: 'sha256', value: 'b'.repeat(64) };

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-reassess-001');
const otherPhaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-other-999');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

const gateA: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const gateB: ResolvedGate = { family: 'ladder', gate: 'check_test_adequacy' };
const gateC: ResolvedGate = { family: 'ladder', gate: 'check_integration_suite' };

const context = (
  declaredGates: readonly ResolvedGate[],
  waivable = true,
) =>
  buildRequirementContext({
    phaseKind: 'GATHER',
    risk: 'low',
    boundary: false,
    reliability: 'reliable',
    declaredGates,
    policy: { minimumApprovals: 0, waivable },
  });

const priorObligations: ResolvedRequirements = resolveRequirements(
  context([gateA, gateB]),
);
const weakerObligations: ResolvedRequirements = resolveRequirements(
  context([gateA]),
);
const strongerObligations: ResolvedRequirements = resolveRequirements(
  context([gateA, gateB, gateC]),
);
const notWaivablePrior: ResolvedRequirements = resolveRequirements(
  context([gateA, gateB], false),
);

const caller = {
  principalKind: 'agent',
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;
const authorization = {
  authorizationId: 'authorization-001',
  posture: 'task-isolated',
  capabilityIds: ['capability.reassess'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;
const waiverActor = {
  principalKind: 'operator',
  principalId: 'principal.release-authority',
  role: 'release-manager',
} as const;

const grantingAuthority: PolicyAuthority = createCapabilityAuthority([
  { principalId: waiverActor.principalId, capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
]);
const noTrustAuthority: PolicyAuthority = createCapabilityAuthority([]);

const priorDecisionId = DecisionIdSchema.parse('decision.prior-001');

/** Requirement ids dropped when moving from `prior` obligations to `next`. */
function droppedRequirementIds(
  prior: ResolvedRequirements,
  next: ResolvedRequirements,
): readonly RequirementId[] {
  const priorFrozen = freezeRequirements({ resolved: prior, phaseAttemptId, subject });
  const nextFrozen = freezeRequirements({ resolved: next, phaseAttemptId, subject });
  const nextIds = new Set(nextFrozen.requirements.map((r) => r.requirementId));
  return priorFrozen.requirements
    .filter((r) => !nextIds.has(r.requirementId))
    .map((r) => r.requirementId);
}

function issuedWaiver(opts: {
  waiverId: string;
  waivedRequirementIds: readonly RequirementId[];
  scope: WaiverScopeV1;
  expiresAt: string;
}): WaiverProvenanceV1 {
  return WaiverProvenanceV1Schema.parse({
    contractVersion: '1.0',
    waiverId: opts.waiverId,
    actor: waiverActor,
    authorization,
    recordedAt: AT,
    event: 'issued',
    rationale: 'authorized weakening under a newer policy version',
    scope: opts.scope,
    subjectDigest: digestA,
    expiresAt: opts.expiresAt,
    waivedRequirementIds: [...opts.waivedRequirementIds],
    policyId: 'policy-002',
    policyDigest: digestB,
  });
}

const phaseAttemptScope: WaiverScopeV1 = { kind: 'phase-attempt', phaseAttemptId };

describe('runReassessment — cross-version monotonicity gate', () => {
  let stateDir: string;
  let appender: AtomicAppender;

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'reassessment-'));
    appender = new AtomicAppender({ stateDir });
  });

  afterEach(async () => {
    appender.getSqliteBackend()?.close();
    await rmrfAsync(stateDir);
  });

  const rawEvents = (streamId: string): DecideOnceStoredEvent[] =>
    (appender.getSqliteBackend()?.queryEvents(streamId) ??
      []) as unknown as DecideOnceStoredEvent[];
  const foldOf = (events: readonly unknown[]) =>
    foldAdmissionStream(events as readonly DecideOnceStoredEvent[]);

  /** Bootstrap the [gateA, gateB] prior generation; return the new stream tail. */
  async function bootstrapPrior(
    streamId: string,
    waivable = true,
  ): Promise<number> {
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);
    await runBootstrapAttempt({
      appender,
      streamId,
      operationId: OperationIdSchema.parse('operation-prior-boot'),
      expectedVersion: rawEvents(streamId).length,
      phaseAttemptId,
      subject,
      requirementContext: context([gateA, gateB], waivable),
      policyId: PolicyIdSchema.parse('policy-001'),
      policyVersion: '1.0',
      policyDigest: digestA,
      resolvedAt: AT,
      caller,
      authorization,
    });
    return rawEvents(streamId).length;
  }

  function makeReassess(
    streamId: string,
    expectedVersion: number,
    overrides: {
      operationId?: string;
      priorObligations?: ResolvedRequirements;
      newObligations: ResolvedRequirements;
      waivers?: readonly WaiverProvenanceV1[];
      authority?: PolicyAuthority;
      evaluatedAt?: string;
    },
  ): ReassessmentInput {
    return {
      appender,
      streamId,
      operationId: OperationIdSchema.parse(overrides.operationId ?? 'operation-reassess-1'),
      expectedVersion,
      phaseAttemptId,
      subject,
      priorDecisionId,
      priorObligations: overrides.priorObligations ?? priorObligations,
      newObligations: overrides.newObligations,
      policyId: PolicyIdSchema.parse('policy-002'),
      policyVersion: '2.0',
      policyDigest: digestB,
      ...(overrides.waivers !== undefined ? { waivers: overrides.waivers } : {}),
      authority: overrides.authority ?? grantingAuthority,
      evaluatedAt: overrides.evaluatedAt ?? AT,
      caller,
      authorization,
    };
  }

  it('Reassess_StrongerObligations_ProceedsWithoutWaiver', async () => {
    const streamId = 'workflow.stronger';
    const tail = await bootstrapPrior(streamId);
    const priorAttempt = selectPhaseAttempt(foldOf(rawEvents(streamId)), phaseAttemptId);
    const priorDigest = priorAttempt!.frozenRequirementSet!.requirementSetDigest;

    const result = await runReassessment(
      makeReassess(streamId, tail, { newObligations: strongerObligations }),
    );

    // (d) stronger obligations are always admissible — no waiver consulted.
    expect(result.outcome).toBe('reassessed');
    if (result.outcome !== 'reassessed') throw new Error('unreachable');
    expect(result.weakened).toBe(false);
    expect(result.drift).toBe(true);
    expect(result.appliedWaiverIds).toEqual([]);

    // The NEW generation is active; the PRIOR generation is preserved in history.
    const attempt = selectPhaseAttempt(foldOf(rawEvents(streamId)), phaseAttemptId);
    expect(digestKey(attempt!.frozenRequirementSet!.requirementSetDigest)).toBe(
      digestKey(result.newRequirementSetDigest),
    );
    expect(
      attempt!.requirementSetHistory.some(
        (g) => digestKey(g.requirementSetDigest) === digestKey(priorDigest),
      ),
    ).toBe(true);
  });

  it('Reassess_EqualObligations_NoDriftRecordsReassessmentOnly', async () => {
    const streamId = 'workflow.equal';
    const tail = await bootstrapPrior(streamId);
    const before = rawEvents(streamId).length;

    const result = await runReassessment(
      makeReassess(streamId, tail, { newObligations: priorObligations }),
    );

    expect(result.outcome).toBe('reassessed');
    if (result.outcome !== 'reassessed') throw new Error('unreachable');
    expect(result.drift).toBe(false);
    expect(result.weakened).toBe(false);
    // No new requirement generation is frozen; only the reassessment fact lands.
    const appended = rawEvents(streamId).slice(before);
    expect(appended.map((e) => e.type)).toEqual(['admission.reassessment-requested']);
  });

  it('Reassess_WeakerWithoutWaiver_FailsClosedAppendsNothing', async () => {
    const streamId = 'workflow.weaker-no-waiver';
    const tail = await bootstrapPrior(streamId);
    const before = rawEvents(streamId).length;

    const result = await runReassessment(
      makeReassess(streamId, tail, { newObligations: weakerObligations }),
    );

    // (e) a weakening with no waiver fails closed — NOTHING is appended.
    expect(result.outcome).toBe('weakening-blocked');
    if (result.outcome !== 'weakening-blocked') throw new Error('unreachable');
    expect(result.reason).toBe('waiver-required');
    expect(result.weakenedRequirementIds.length).toBeGreaterThan(0);
    expect(rawEvents(streamId).length).toBe(before);

    // The attempt's active frozen set is unchanged (still the prior generation).
    const attempt = selectPhaseAttempt(foldOf(rawEvents(streamId)), phaseAttemptId);
    expect(digestKey(attempt!.frozenRequirementSet!.requirementSetDigest)).toBe(
      digestKey(result.priorRequirementSetDigest!),
    );
  });

  it('Reassess_WeakerWithAuthorizedWaiver_ProceedsAndRecordsWeakening', async () => {
    const streamId = 'workflow.weaker-waived';
    const tail = await bootstrapPrior(streamId);
    const dropped = droppedRequirementIds(priorObligations, weakerObligations);
    const waiver = issuedWaiver({
      waiverId: 'waiver-weakening-001',
      waivedRequirementIds: dropped,
      scope: phaseAttemptScope,
      expiresAt: FUTURE,
    });

    const result = await runReassessment(
      makeReassess(streamId, tail, {
        newObligations: weakerObligations,
        waivers: [waiver],
      }),
    );

    // (f) a weakening WITH a valid authorized waiver proceeds AND records the
    // applied waiver — the weakening is explicit, not silent.
    expect(result.outcome).toBe('reassessed');
    if (result.outcome !== 'reassessed') throw new Error('unreachable');
    expect(result.weakened).toBe(true);
    expect(result.drift).toBe(true);
    expect(result.appliedWaiverIds).toEqual(['waiver-weakening-001']);
    expect(result.weakenedRequirementIds).toEqual(dropped);

    // The new (weaker) generation is now active; the reassessment fact carries
    // the authorizing waiver id.
    const events = rawEvents(streamId);
    const attempt = selectPhaseAttempt(foldOf(events), phaseAttemptId);
    expect(digestKey(attempt!.frozenRequirementSet!.requirementSetDigest)).toBe(
      digestKey(result.newRequirementSetDigest),
    );
    const requested = events.find((e) => e.type === 'admission.reassessment-requested');
    expect((requested?.data as { waiverIds?: unknown } | undefined)?.waiverIds).toEqual([
      'waiver-weakening-001',
    ]);
  });

  it('Reassess_ExpiredWaiver_DoesNotPermitWeakening', async () => {
    const streamId = 'workflow.expired-waiver';
    const tail = await bootstrapPrior(streamId);
    const dropped = droppedRequirementIds(priorObligations, weakerObligations);
    const expired = issuedWaiver({
      waiverId: 'waiver-expired-001',
      waivedRequirementIds: dropped,
      scope: phaseAttemptScope,
      expiresAt: PAST, // before the evaluation instant
    });
    const before = rawEvents(streamId).length;

    const result = await runReassessment(
      makeReassess(streamId, tail, {
        newObligations: weakerObligations,
        waivers: [expired],
      }),
    );

    // (g.1) an expired waiver cannot authorize a weakening.
    expect(result.outcome).toBe('weakening-blocked');
    if (result.outcome !== 'weakening-blocked') throw new Error('unreachable');
    expect(result.reason).toBe('waiver-required');
    expect(rawEvents(streamId).length).toBe(before);
  });

  it('Reassess_UnauthorizedWaiver_DoesNotPermitWeakening', async () => {
    const streamId = 'workflow.unauthorized-waiver';
    const tail = await bootstrapPrior(streamId);
    const dropped = droppedRequirementIds(priorObligations, weakerObligations);
    const waiver = issuedWaiver({
      waiverId: 'waiver-unauth-001',
      waivedRequirementIds: dropped,
      scope: phaseAttemptScope,
      expiresAt: FUTURE,
    });
    const before = rawEvents(streamId).length;

    // The actor is not granted GRANT_WAIVER by this authority.
    const result = await runReassessment(
      makeReassess(streamId, tail, {
        newObligations: weakerObligations,
        waivers: [waiver],
        authority: noTrustAuthority,
      }),
    );

    // (g.2) a waiver whose actor the trusted authority does not authorize cannot
    // permit a weakening.
    expect(result.outcome).toBe('weakening-blocked');
    if (result.outcome !== 'weakening-blocked') throw new Error('unreachable');
    expect(result.reason).toBe('waiver-required');
    expect(rawEvents(streamId).length).toBe(before);
  });

  it('Reassess_OutOfScopeWaiver_DoesNotPermitWeakening', async () => {
    const streamId = 'workflow.out-of-scope-waiver';
    const tail = await bootstrapPrior(streamId);
    const dropped = droppedRequirementIds(priorObligations, weakerObligations);
    const waiver = issuedWaiver({
      waiverId: 'waiver-scope-001',
      waivedRequirementIds: dropped,
      // Scope covers a DIFFERENT phase attempt — not this target.
      scope: { kind: 'phase-attempt', phaseAttemptId: otherPhaseAttemptId },
      expiresAt: FUTURE,
    });
    const before = rawEvents(streamId).length;

    const result = await runReassessment(
      makeReassess(streamId, tail, {
        newObligations: weakerObligations,
        waivers: [waiver],
      }),
    );

    // (g.3) a waiver scoped to another subject cannot permit this weakening.
    expect(result.outcome).toBe('weakening-blocked');
    if (result.outcome !== 'weakening-blocked') throw new Error('unreachable');
    expect(result.reason).toBe('waiver-required');
    expect(rawEvents(streamId).length).toBe(before);
  });

  it('Reassess_NotWaivablePrior_CannotBeWeakenedEvenWithWaiver', async () => {
    const streamId = 'workflow.not-waivable';
    const tail = await bootstrapPrior(streamId, false);
    const dropped = droppedRequirementIds(notWaivablePrior, weakerObligations);
    const waiver = issuedWaiver({
      waiverId: 'waiver-nw-001',
      waivedRequirementIds: dropped,
      scope: phaseAttemptScope,
      expiresAt: FUTURE,
    });
    const before = rawEvents(streamId).length;

    const result = await runReassessment(
      makeReassess(streamId, tail, {
        priorObligations: notWaivablePrior,
        newObligations: weakerObligations,
        waivers: [waiver],
      }),
    );

    // The strongest obligation lattice element (not-waivable) can never be
    // weakened, even by an otherwise-valid waiver.
    expect(result.outcome).toBe('weakening-blocked');
    if (result.outcome !== 'weakening-blocked') throw new Error('unreachable');
    expect(result.reason).toBe('not-waivable');
    expect(rawEvents(streamId).length).toBe(before);
  });

  it('Reassess_ForgedPriorObligations_FailsClosedOnAuthenticity', async () => {
    const streamId = 'workflow.forged-prior';
    const tail = await bootstrapPrior(streamId);
    const before = rawEvents(streamId).length;

    // Claim a WEAKER "prior" than what history actually froze, to try to make a
    // genuine weakening look like a no-op / strengthening.
    const result = await runReassessment(
      makeReassess(streamId, tail, {
        priorObligations: weakerObligations,
        newObligations: weakerObligations,
      }),
    );

    expect(result.outcome).toBe('not-reassessable');
    if (result.outcome !== 'not-reassessable') throw new Error('unreachable');
    expect(result.reason).toBe('prior-obligations-mismatch');
    expect(rawEvents(streamId).length).toBe(before);
  });

  it('Reassess_NoBootstrappedAttempt_FailsClosed', async () => {
    const streamId = 'workflow.no-attempt';
    await appender.appendUnkeyed(streamId, [{ type: 'workflow.started', data: {} }]);

    const result = await runReassessment(
      makeReassess(streamId, rawEvents(streamId).length, {
        newObligations: strongerObligations,
      }),
    );

    expect(result.outcome).toBe('not-reassessable');
    if (result.outcome !== 'not-reassessable') throw new Error('unreachable');
    expect(result.reason).toBe('attempt-not-found');
  });

  it('Reassess_SameOperationId_IsIdempotent', async () => {
    const streamId = 'workflow.reassess-idem';
    const tail = await bootstrapPrior(streamId);

    const first = await runReassessment(
      makeReassess(streamId, tail, {
        operationId: 'operation-reassess-idem',
        newObligations: strongerObligations,
      }),
    );
    const afterFirst = rawEvents(streamId).length;

    const second = await runReassessment(
      makeReassess(streamId, tail, {
        operationId: 'operation-reassess-idem',
        newObligations: strongerObligations,
      }),
    );
    // Same operationId retry → identical recorded result, no duplicate events.
    expect(second).toEqual(first);
    expect(rawEvents(streamId).length).toBe(afterFirst);
  });
});
