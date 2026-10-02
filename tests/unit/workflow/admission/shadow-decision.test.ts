// Tests for shadow decisions.
//
// Each legacy and admission pair maps to one typed disagreement class, which includes `admission-indeterminate` and `shadow-error`.
// The corpus runs the legacy engine (`executeTransition`) and the admission engine (`evaluatePolicy`) side by side.
// Each disagreement gets a class and a disposition, and no disagreement stays unexplained.
// Shadow mode does not change the legacy decision, even when the shadow adjudication throws.
// Recorded disagreements and attempts map onto the registered admission event schemas.

import { describe, expect, it } from 'vitest';

import {
  executeTransition,
  findTransition,
  getHSMDefinition,
} from '../../../../src/workflow/state-machine.js';
import {
  legacyTransitionCorpus,
  type LegacyTransitionFixture,
} from '../__fixtures__/transition-admission-corpus.js';
import { GUARD_CLASSIFICATIONS } from '../__fixtures__/guard-classification.js';
import type { PhaseKind } from '../../../../src/workflow/phase-kind.js';
import {
  evaluatePolicy,
  type PolicyEvaluationInput,
} from '../../../../src/workflow/admission/policy-evaluation.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
} from '../../../../src/workflow/admission/policy-authority.js';
import type { ResolvedRequirements } from '../../../../src/workflow/admission/requirement-strength.js';
import {
  AdmissionEvidenceV1Schema,
  AdmissionRequirementV1Schema,
  type AdmissionDecisionRecordV1,
  type AttributedPrincipalV1,
  type AuthorizationSnapshotV1,
  type ContentDigestV1,
  type EvidenceSubjectV1,
} from '../../../../src/workflow/admission/types.js';
import {
  classifyShadowOutcome,
  isDisagreement,
  runShadowDecision,
  summarizeShadowDecisions,
  toDisagreementDispositionData,
  toShadowAttemptData,
  DISAGREEMENT_CLASSES,
  type DisagreementExplanation,
  type ExplainContext,
  type LegacyDecision,
  type LegacyOutcome,
  type ShadowAttempt,
  type ShadowDecisionRecord,
  type ShadowProvenance,
} from '../../../../src/workflow/admission/shadow-decision.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const EVAL_AT = '2026-07-21T20:00:00.000Z';
const FRESH_AT = '2026-07-21T19:45:00.000Z';
const HORIZON_MS = 60 * 60 * 1000;

const digest = (value = SHA_A): ContentDigestV1 => ({
  algorithm: 'sha256',
  value,
});
const taskSubject = (): EvidenceSubjectV1 => ({
  kind: 'task',
  taskId: 'task-1',
  digest: digest(),
});

const GATE_PRODUCER = 'producer.gate-runner';
const authority = createCapabilityAuthority([
  { principalId: GATE_PRODUCER, capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
]);
const WAIVABLE: ResolvedRequirements = {
  gates: [],
  minimumApprovals: 0,
  minimumCorroboratingSources: 0,
  waivable: true,
};

const caller: AttributedPrincipalV1 = {
  principalKind: 'operator',
  principalId: 'principal.cutover-operator',
  role: 'release-authority',
};
const authorization: AuthorizationSnapshotV1 = {
  authorizationId: 'authz-1',
  posture: 'read-only',
  capabilityIds: ['capability.observe-shadow'],
  resolverVersion: '1.0',
  resolvedAt: EVAL_AT,
};
const provenance: ShadowProvenance = { caller, authorization };

/**
 * Runs `evaluatePolicy` on one gate-evidence requirement.
 * The verdict is `allow` when the evidence is present, `deny` when it is absent, and `indeterminate` for an indeterminate gate verdict.
 */
function admissionVerdictFor(
  evidencePresent: boolean,
  gateVerdict: 'pass' | 'indeterminate' = 'pass',
): 'allow' | 'deny' | 'indeterminate' {
  const requirement = AdmissionRequirementV1Schema.parse({
    contractVersion: '1.0',
    requirementId: 'req-gate',
    phaseAttemptId: 'pa-1',
    subject: taskSubject(),
    kind: 'gate-evidence',
    gateId: 'gate.static-analysis',
  });
  const evidence = evidencePresent
    ? [
        AdmissionEvidenceV1Schema.parse({
          contractVersion: '1.0',
          evidenceId: 'ev-1',
          requirementId: 'req-gate',
          phaseAttemptId: 'pa-1',
          subject: taskSubject(),
          producer: {
            producerId: GATE_PRODUCER,
            providerRef: 'provider.static-analysis',
            providerVersion: '1.0',
            invocationId: 'inv-1',
          },
          policyId: 'policy-1',
          policyDigest: digest(),
          contentDigest: digest(SHA_B),
          createdAt: FRESH_AT,
          kind: 'gate',
          verdict: gateVerdict,
        }),
      ]
    : [];
  const input: PolicyEvaluationInput = {
    requirements: [requirement],
    obligations: WAIVABLE,
    activeEvidence: evidence,
    authority,
    evaluatedAt: EVAL_AT,
    freshnessHorizonMs: HORIZON_MS,
  };
  return evaluatePolicy(input).verdict;
}

describe('ShadowDecision_Classifier (P07-01)', () => {
  const evaluated = (verdict: 'allow' | 'deny' | 'indeterminate') =>
    ({ status: 'evaluated', verdict }) as const;

  it('agree — both allow', () => {
    expect(classifyShadowOutcome('allow', evaluated('allow'))).toBe('agree');
  });

  it('agree — both deny', () => {
    expect(classifyShadowOutcome('deny', evaluated('deny'))).toBe('agree');
  });

  it('legacy-allow-admission-deny', () => {
    expect(classifyShadowOutcome('allow', evaluated('deny'))).toBe(
      'legacy-allow-admission-deny',
    );
  });

  it('legacy-deny-admission-allow', () => {
    expect(classifyShadowOutcome('deny', evaluated('allow'))).toBe(
      'legacy-deny-admission-allow',
    );
  });

  it('admission-indeterminate is distinct from deny — from a legacy deny', () => {
    expect(classifyShadowOutcome('deny', evaluated('indeterminate'))).toBe(
      'admission-indeterminate',
    );
  });

  it('admission-indeterminate is distinct from agree — from a legacy allow', () => {
    expect(classifyShadowOutcome('allow', evaluated('indeterminate'))).toBe(
      'admission-indeterminate',
    );
  });

  it('shadow-error dominates when the adjudication failed', () => {
    expect(
      classifyShadowOutcome('allow', { status: 'error', error: 'boom' }),
    ).toBe('shadow-error');
  });

  it('admission-indeterminate is genuinely produced by evaluatePolicy', () => {
    expect(admissionVerdictFor(true, 'indeterminate')).toBe('indeterminate');
    expect(classifyShadowOutcome('deny', evaluated('indeterminate'))).toBe(
      'admission-indeterminate',
    );
  });
});

/**
 * Tells if the evidence that admission requires is present for each `bypass` fixture.
 * A `representative-pass` fixture carries the evidence, and a `representative-fail` fixture lacks it.
 * The `bypass` fixtures differ from each other, so this table sets each one with its reason.
 */
const BYPASS_EVIDENCE_PRESENT: Readonly<Record<string, boolean>> = {
  /** An empty task array holds no completed-task evidence. The legacy pass is vacuous. */
  'bypass-empty-task-collection-is-complete': false,
  /** `implementation.complete` is false, so no implementation evidence exists. The legacy guard is a no-op. */
  'bypass-always-pass-implementation-ignores-fail-shaped-state': false,
  /** A patched approval boolean is not a typed approval. */
  'bypass-patched-plan-approval-is-authoritative': false,
  /** A patched review-status object is not typed review evidence. */
  'bypass-patched-review-status-is-authoritative': false,
  /**
   * The plan artifact is present, and legacy only ignores the orthogonal risk tier.
   * An evidence-backed check on the plan requirement also admits, so the two engines agree.
   */
  'bypass-unknown-risk-does-not-block-plan-edge': true,
  /** The only gate evidence is a stale failing event. No fresh passing evidence exists. */
  'bypass-stale-gate-event-is-not-consulted': false,
};

function evidencePresentFor(fixture: LegacyTransitionFixture): boolean {
  if (fixture.scenario === 'representative-pass') return true;
  if (fixture.scenario === 'representative-fail') return false;
  const mapped = BYPASS_EVIDENCE_PRESENT[fixture.id];
  return mapped ?? false;
}

/** The flagged guard component behind a guard id. The id can be a composite joined with `+`. */
function flaggedComponent(guardId: string | undefined) {
  if (!guardId) return undefined;
  for (const component of guardId.split('+')) {
    const entry = GUARD_CLASSIFICATIONS[component];
    if (entry?.flaggedForRemediation) return entry;
  }
  return undefined;
}

/**
 * A `legacy-allow-admission-deny` disagreement is explained when the fixture documents a permissive legacy guard.
 * That is a `bypass` fixture, or a `representative-fail` fixture whose recorded legacy verdict is `allow`.
 * Every other disagreement is unexplained.
 */
function explainCorpusDisagreement(
  fixture: LegacyTransitionFixture,
  guardId: string | undefined,
): (ctx: ExplainContext) => DisagreementExplanation {
  return (ctx: ExplainContext): DisagreementExplanation => {
    const documentedPermissive =
      fixture.scenario === 'bypass' ||
      (fixture.scenario === 'representative-fail' &&
        fixture.expected.verdict === 'allow');

    if (
      ctx.disagreementClass === 'legacy-allow-admission-deny' &&
      documentedPermissive
    ) {
      const flagged = flaggedComponent(guardId);
      const reason = flagged
        ? `legacy defect: ${flagged.id} — ${flagged.defectNote} (P06-01 DR-1)`
        : `documented legacy bypass '${fixture.id}': legacy admits without the ` +
          `typed evidence the admission engine requires`;
      return { disposition: 'explained-legacy', reason };
    }

    return {
      disposition: 'unexplained',
      reason: `unexplained ${ctx.disagreementClass} on ${fixture.id}`,
    };
  };
}

function phaseKindOf(
  workflowType: string,
  phase: string,
): PhaseKind | undefined {
  const state = getHSMDefinition(workflowType).states[phase];
  return state && state.type === 'atomic' ? state.kind : undefined;
}

/** Runs the real legacy engine and the real `evaluatePolicy` over each corpus fixture. The legacy decision is authoritative. */
function runCorpusShadow(): readonly ShadowDecisionRecord[] {
  return legacyTransitionCorpus.map((fixture) => {
    const hsm = getHSMDefinition(fixture.workflowType);
    const legacyResult = executeTransition(
      hsm,
      { ...fixture.state, phase: fixture.from },
      fixture.to,
    );
    const legacy: LegacyDecision = {
      outcome: legacyResult.success ? 'allow' : 'deny',
      idempotent: legacyResult.idempotent,
      ...(legacyResult.errorMessage
        ? { detail: legacyResult.errorMessage }
        : {}),
    };

    const guardId = findTransition(hsm, fixture.from, fixture.to)?.guard?.id;
    const attempt: ShadowAttempt = {
      workflowType: fixture.workflowType,
      fromPhase: fixture.from,
      toPhase: fixture.to,
      phaseKind:
        phaseKindOf(fixture.workflowType, fixture.to) ??
        phaseKindOf(fixture.workflowType, fixture.from) ??
        'IMPLEMENT',
      attemptId: fixture.id,
      ...(guardId ? { guardId } : {}),
    };

    const { record } = runShadowDecision({
      attempt,
      legacy,
      adjudicateAdmission: () => admissionVerdictFor(evidencePresentFor(fixture)),
      explain: explainCorpusDisagreement(fixture, guardId),
    });
    return record;
  });
}

describe('ShadowDecision_Corpus (P07-01 exit-proof a)', () => {
  const records = runCorpusShadow();
  const summary = summarizeShadowDecisions(records);

  it('every corpus fixture produced a classified record', () => {
    expect(records).toHaveLength(legacyTransitionCorpus.length);
    for (const record of records) {
      expect(DISAGREEMENT_CLASSES).toContain(record.disagreementClass);
    }
  });

  /** The legacy side must match the recorded corpus baseline. Otherwise a legacy regression shows as a disagreement. */
  it('the legacy engine reproduces the frozen corpus baseline exactly', () => {
    for (const [i, fixture] of legacyTransitionCorpus.entries()) {
      expect(records[i]?.legacyOutcome).toBe(fixture.expected.verdict);
    }
  });

  it('every disagreement is legacy-allow-admission-deny (the permissive direction)', () => {
    expect(summary.byClass['legacy-deny-admission-allow']).toBe(0);
    expect(summary.byClass['admission-indeterminate']).toBe(0);
    expect(summary.byClass['shadow-error']).toBe(0);
    expect(summary.disagreements).toBe(
      summary.byClass['legacy-allow-admission-deny'],
    );
  });

  it('ZERO unexplained disagreements across the corpus (dogfood exit criterion 16)', () => {
    expect(summary.unexplained).toBe(0);
    expect(summary.disagreements).toBeGreaterThan(0);
    for (const record of records) {
      if (isDisagreement(record.disagreementClass)) {
        expect(record.disposition).toBe('explained-legacy');
        expect(record.explained).toBe(true);
      }
    }
  });

  /**
   * Four permissive `representative-fail` guards and five bypass fixtures without the required evidence disagree.
   * `bypass-unknown-risk-does-not-block-plan-edge` agrees, because the plan artifact is present.
   */
  it('the disagreement finding matches the P06-01 permissive-legacy inventory', () => {
    const disagreeing = records
      .filter((r) => isDisagreement(r.disagreementClass))
      .map((r) => r.attempt.attemptId)
      .sort();
    expect(disagreeing).toEqual(
      [
        'debug-debug-implement-to-debug-validate-fail',
        'debug-hotfix-implement-to-hotfix-validate-fail',
        'debug-investigate-to-cancelled-fail',
        'refactor-polish-implement-to-polish-validate-fail',
        'bypass-empty-task-collection-is-complete',
        'bypass-always-pass-implementation-ignores-fail-shaped-state',
        'bypass-patched-plan-approval-is-authoritative',
        'bypass-patched-review-status-is-authoritative',
        'bypass-stale-gate-event-is-not-consulted',
      ].sort(),
    );
    expect(
      records.find(
        (r) =>
          r.attempt.attemptId === 'bypass-unknown-risk-does-not-block-plan-edge',
      )?.disagreementClass,
    ).toBe('agree');
  });

  it('a legacy-defect disagreement cites the P06-01 defect note', () => {
    const implComplete = records.find(
      (r) =>
        r.attempt.attemptId ===
        'bypass-always-pass-implementation-ignores-fail-shaped-state',
    );
    expect(implComplete?.reason).toContain('implementation-complete');
    expect(implComplete?.reason).toContain('P06-01');
  });
});

describe('ShadowDecision_BehaviourPreservation (P07-01 exit-proof g)', () => {
  const attempt: ShadowAttempt = {
    workflowType: 'feature',
    fromPhase: 'plan',
    toPhase: 'plan-review',
    phaseKind: 'PLAN',
  };
  const alwaysExplained = (): DisagreementExplanation => ({
    disposition: 'explained-legacy',
    reason: 'test',
  });

  /** The returned decision is the same reference as the input. */
  it('returns the authoritative legacy decision byte-identical (allow)', () => {
    const legacy: LegacyDecision = { outcome: 'allow', idempotent: false };
    const { legacy: out } = runShadowDecision({
      attempt,
      legacy,
      adjudicateAdmission: () => 'deny',
      explain: alwaysExplained,
    });
    expect(out).toBe(legacy);
    expect(out.outcome).toBe('allow');
  });

  /** The legacy decision stays the same reference. The shadow records the failure and does not throw it. */
  it('a THROWING shadow adjudication never alters the legacy decision', () => {
    const legacy: LegacyDecision = { outcome: 'allow', detail: 'guard passed' };
    const result = runShadowDecision({
      attempt,
      legacy,
      adjudicateAdmission: () => {
        throw new Error('admission engine exploded');
      },
      explain: alwaysExplained,
    });
    expect(result.legacy).toBe(legacy);
    expect(result.legacy.outcome).toBe('allow');
    expect(result.record.admission).toEqual({
      status: 'error',
      error: 'admission engine exploded',
    });
    expect(result.record.disagreementClass).toBe('shadow-error');
  });

  it('a legacy deny is likewise returned untouched under a disagreeing shadow', () => {
    const legacy: LegacyDecision = { outcome: 'deny', detail: 'guard failed' };
    const { legacy: out, record } = runShadowDecision({
      attempt,
      legacy,
      adjudicateAdmission: () => 'allow',
      explain: () => ({ disposition: 'unexplained', reason: 'r' }),
    });
    expect(out).toBe(legacy);
    expect(out.outcome).toBe('deny');
    expect(record.disagreementClass).toBe('legacy-deny-admission-allow');
    expect(record.explained).toBe(false);
  });
});

describe('ShadowDecision_EventProducers (P07-01)', () => {
  const disagreement: ShadowDecisionRecord = {
    attempt: {
      workflowType: 'debug',
      fromPhase: 'debug-implement',
      toPhase: 'debug-validate',
      phaseKind: 'IMPLEMENT',
      guardId: 'implementation-complete',
      attemptId: 'x',
    },
    legacyOutcome: 'allow',
    admission: { status: 'evaluated', verdict: 'deny' },
    disagreementClass: 'legacy-allow-admission-deny',
    disposition: 'explained-legacy',
    explained: true,
    reason: 'legacy defect: implementation-complete always true',
  };

  it('maps a disagreement onto a schema-valid admission.disagreement-disposition', () => {
    const data = toDisagreementDispositionData({
      record: disagreement,
      dispositionId: 'disp-1',
      shadowAttemptId: 'sa-1',
      recordedAt: EVAL_AT,
      provenance,
    });
    expect(data.disposition).toBe('explained-legacy');
    expect(data.rationale).toContain('implementation-complete');
  });

  it('refuses to record a disposition event for an agreement', () => {
    const agree: ShadowDecisionRecord = {
      ...disagreement,
      disagreementClass: 'agree',
      disposition: 'agree',
      reason: 'agree',
    };
    expect(() =>
      toDisagreementDispositionData({
        record: agree,
        dispositionId: 'd',
        shadowAttemptId: 's',
        recordedAt: EVAL_AT,
        provenance,
      }),
    ).toThrow(/disagreement/);
  });

  it('pairs the legacy outcome with an admission decision in a shadow-attempt event', () => {
    const decision: AdmissionDecisionRecordV1 = {
      contractVersion: '1.0',
      decisionId: 'dec-1',
      operationId: 'op-1',
      phaseAttemptId: 'pa-1',
      policyId: 'policy-1',
      policyVersion: '1.0',
      policyDigest: digest(),
      requirementSetDigest: digest(SHA_B),
      inputDigest: digest(),
      evidenceIds: [],
      waiverIds: [],
      decidedAt: EVAL_AT,
      outcome: 'allow',
      satisfiedRequirementIds: [],
      waivedRequirementIds: [],
    };
    const data = toShadowAttemptData({
      record: disagreement,
      shadowAttemptId: 'sa-1',
      operationId: 'op-1',
      phaseAttemptId: 'pa-1',
      subject: taskSubject(),
      evidenceSetDigest: digest(SHA_B),
      decision,
      attemptedAt: EVAL_AT,
      provenance,
    });
    expect(data.legacyOutcome).toBe('allow');
    expect(data.decision.outcome).toBe('allow');
  });
});
