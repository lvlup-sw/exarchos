/**
 * P06-04 — Scoped expiring waiver unit tests.
 *
 * Each applicability gate is exercised in isolation: issuance-only, waivable
 * floor, declared requirement, subject scope, expiry, and authorization. Also
 * covers `selectApplicableWaiver`'s deterministic, order-independent choice.
 */
import { describe, expect, it } from 'vitest';
import {
  WaiverProvenanceV1Schema,
  type EvidenceSubjectV1,
  type PhaseAttemptId,
  type RequirementId,
  type WaiverProvenanceV1,
} from '../../../../src/workflow/admission/types.js';
import {
  createCapabilityAuthority,
  DENY_ALL_AUTHORITY,
  POLICY_CAPABILITY,
} from '../../../../src/workflow/admission/policy-authority.js';
import {
  evaluateWaiver,
  isIssuedWaiver,
  selectApplicableWaiver,
  subjectIdentityKey,
  waiverScopeCovers,
  type WaiverEvaluationOptions,
  type WaiverTarget,
} from '../../../../src/workflow/admission/waiver.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const EVAL_AT = '2026-07-21T20:00:00.000Z';
const EXPIRES_FUTURE = '2026-07-22T20:00:00.000Z';
const EXPIRES_PAST = '2026-07-21T19:00:00.000Z';

const GRANTOR = 'principal.release-authority';

const digest = (value = SHA_A) => ({ algorithm: 'sha256' as const, value });
const taskSubject = (taskId = 'task-1', value = SHA_A): EvidenceSubjectV1 =>
  ({ kind: 'task', taskId, digest: digest(value) }) as EvidenceSubjectV1;

const authority = createCapabilityAuthority([
  { principalId: GRANTOR, capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
]);

const target: WaiverTarget = {
  requirementId: 'req-gate' as RequirementId,
  subject: taskSubject(),
  phaseAttemptId: 'pa-1' as PhaseAttemptId,
};

const options: WaiverEvaluationOptions = {
  evaluatedAt: EVAL_AT,
  waivable: true,
  authority,
};

interface WaiverOpts {
  readonly waiverId?: string;
  readonly event?: 'issued' | 'revoked' | 'superseded';
  readonly actorId?: string;
  readonly scope?: unknown;
  readonly expiresAt?: string;
  readonly waivedRequirementIds?: readonly string[];
}

function waiver(opts: WaiverOpts = {}): WaiverProvenanceV1 {
  const common = {
    contractVersion: '1.0',
    waiverId: opts.waiverId ?? 'waiver-1',
    actor: {
      principalKind: 'operator',
      principalId: opts.actorId ?? GRANTOR,
      role: 'release-authority',
    },
    authorization: {
      authorizationId: 'authz-1',
      posture: 'shared-mutating',
      capabilityIds: ['capability.issue-waiver'],
      resolverVersion: '1.0',
      resolvedAt: EVAL_AT,
    },
    recordedAt: EVAL_AT,
  };
  const event = opts.event ?? 'issued';
  if (event === 'revoked') {
    return WaiverProvenanceV1Schema.parse({ ...common, event, reason: 'no longer required' });
  }
  if (event === 'superseded') {
    return WaiverProvenanceV1Schema.parse({
      ...common,
      event,
      supersededByWaiverId: 'waiver-2',
      reason: 'scope narrowed',
    });
  }
  return WaiverProvenanceV1Schema.parse({
    ...common,
    event: 'issued',
    rationale: 'time-bounded exception',
    scope: opts.scope ?? { kind: 'subject', subject: taskSubject() },
    subjectDigest: digest(),
    expiresAt: opts.expiresAt ?? EXPIRES_FUTURE,
    waivedRequirementIds: opts.waivedRequirementIds ?? ['req-gate'],
    policyId: 'policy-1',
    policyDigest: digest(SHA_B),
  });
}

describe('waiver applicability', () => {
  it('Waiver_ValidIssuance_Applies', () => {
    const result = evaluateWaiver(waiver(), target, options);
    expect(result.applies).toBe(true);
  });

  it('Waiver_RevokedEvent_NeverApplies', () => {
    const result = evaluateWaiver(waiver({ event: 'revoked' }), target, options);
    expect(result.applies).toBe(false);
    expect(result.applies === false && result.reason).toBe('not-an-issuance');
  });

  it('Waiver_SupersededEvent_NeverApplies', () => {
    const result = evaluateWaiver(waiver({ event: 'superseded' }), target, options);
    expect(result.applies === false && result.reason).toBe('not-an-issuance');
  });

  it('Waiver_NotWaivableFloor_NeverApplies', () => {
    const result = evaluateWaiver(waiver(), target, { ...options, waivable: false });
    expect(result.applies === false && result.reason).toBe('not-waivable');
  });

  it('Waiver_RequirementNotDeclared_DoesNotApply', () => {
    const result = evaluateWaiver(
      waiver({ waivedRequirementIds: ['req-other'] }),
      target,
      options,
    );
    expect(result.applies === false && result.reason).toBe('requirement-not-declared');
  });

  it('Waiver_SubjectScopeMismatch_DoesNotApply', () => {
    const result = evaluateWaiver(
      waiver({ scope: { kind: 'subject', subject: taskSubject('task-OTHER') } }),
      target,
      options,
    );
    expect(result.applies === false && result.reason).toBe('subject-out-of-scope');
  });

  it('Waiver_Expired_DoesNotApply', () => {
    const result = evaluateWaiver(waiver({ expiresAt: EXPIRES_PAST }), target, options);
    expect(result.applies === false && result.reason).toBe('expired');
  });

  it('Waiver_ExpiryIsStrict_AtInstantIsExpired', () => {
    // evaluatedAt exactly equals expiresAt: not strictly before ⇒ expired.
    const result = evaluateWaiver(
      waiver({ expiresAt: EVAL_AT }),
      target,
      options,
    );
    expect(result.applies === false && result.reason).toBe('expired');
  });

  it('Waiver_UnauthorizedActor_DoesNotApply', () => {
    const result = evaluateWaiver(waiver({ actorId: 'principal.impostor' }), target, options);
    expect(result.applies === false && result.reason).toBe('unauthorized');
  });

  it('Waiver_AuthorityRejectsAll_DoesNotApply', () => {
    const result = evaluateWaiver(waiver(), target, {
      ...options,
      authority: DENY_ALL_AUTHORITY,
    });
    expect(result.applies === false && result.reason).toBe('unauthorized');
  });
});

describe('waiver scope coverage', () => {
  it('Waiver_PhaseAttemptScope_CoversMatchingAttempt', () => {
    expect(
      waiverScopeCovers({ kind: 'phase-attempt', phaseAttemptId: 'pa-1' as PhaseAttemptId }, target),
    ).toBe(true);
    expect(
      waiverScopeCovers({ kind: 'phase-attempt', phaseAttemptId: 'pa-2' as PhaseAttemptId }, target),
    ).toBe(false);
  });

  it('Waiver_WorkflowScope_OnlyCoversWorkflowSubject', () => {
    const workflowTarget: WaiverTarget = {
      requirementId: 'req-wf' as RequirementId,
      phaseAttemptId: 'pa-1' as PhaseAttemptId,
      subject: { kind: 'workflow', workflowId: 'wf-1', digest: digest() } as EvidenceSubjectV1,
    };
    expect(
      waiverScopeCovers({ kind: 'workflow', workflowId: 'wf-1' as never }, workflowTarget),
    ).toBe(true);
    // A task target is never covered by a workflow scope (no graph inference).
    expect(waiverScopeCovers({ kind: 'workflow', workflowId: 'wf-1' as never }, target)).toBe(false);
  });

  it('Waiver_SubjectIdentityKey_DiscriminatesDigest', () => {
    expect(subjectIdentityKey(taskSubject('task-1', SHA_A))).not.toBe(
      subjectIdentityKey(taskSubject('task-1', SHA_B)),
    );
  });
});

describe('selectApplicableWaiver', () => {
  it('Waiver_Select_ReturnsUndefined_WhenNoneApply', () => {
    expect(
      selectApplicableWaiver([waiver({ expiresAt: EXPIRES_PAST })], target, options),
    ).toBeUndefined();
  });

  it('Waiver_Select_IsOrderIndependent', () => {
    const applicable = waiver({ waiverId: 'waiver-b' });
    const inapplicable = waiver({ waiverId: 'waiver-a', waivedRequirementIds: ['req-other'] });
    const forwards = selectApplicableWaiver([inapplicable, applicable], target, options);
    const backwards = selectApplicableWaiver([applicable, inapplicable], target, options);
    expect(forwards?.waiverId).toBe('waiver-b');
    expect(backwards?.waiverId).toBe('waiver-b');
  });

  it('Waiver_isIssuedWaiver_NarrowsLifecycle', () => {
    expect(isIssuedWaiver(waiver())).toBe(true);
    expect(isIssuedWaiver(waiver({ event: 'revoked' }))).toBe(false);
  });
});
