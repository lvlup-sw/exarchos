// Exit-proof tests for P06-06 explainable decisions (Transition tasks 025, 026).
//
// `explainDecision` is exercised over REAL persisted decisions produced by the
// P06-05 chokepoint (a recording appender, no backend), so the explanation is
// proven against the same records callers see. Proves:
//   • per-requirement results + evidence references + policy identity;
//   • a stable reason code per unsatisfied requirement (aligned to P03-02);
//   • every denial carries a remediation (safe verb OR terminal reason) — no
//     unexplained denial;
//   • (d) a waiver-driven `allow` surfaces the waived failures AND waiver ids;
//   • (b) explaining a deny never yields an allow and never mutates the decided
//     input (behavioural no-pass-state proof);
//   • every emitted next_action validates against the LIVE schema.
import { describe, it, expect } from 'vitest';

import type {
  DecideOnceContext,
  DecideOnceDecision,
} from '../../../../src/events/atomic-appender.js';
import { NextAction } from '../../../../src/next-action.js';
import { STABLE_ERROR_REGISTRY } from '../../../../src/contract/error-families.js';
import {
  runTransitionCommand,
  type AdmissionDecider,
  type TransitionCommandInput,
  type TransitionDecided,
} from '../../../../src/workflow/admission/transition-command.js';
import { resolveRequirements } from '../../../../src/workflow/admission/requirement-resolution.js';
import { freezeRequirements } from '../../../../src/workflow/admission/freeze-requirements.js';
import { buildRequirementContext } from '../../../../src/workflow/admission/requirement-context.js';
import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from '../../../../src/workflow/admission/edge-condition.js';
import type { EdgeConditionFacts } from '../../../../src/workflow/admission/edge-condition-evaluate.js';
import type { EdgeCandidate } from '../../../../src/workflow/admission/edge-condition-select.js';
import { createEvidenceSubject } from '../../../../src/workflow/admission/evidence-subject.js';
import {
  createCapabilityAuthority,
  POLICY_CAPABILITY,
} from '../../../../src/workflow/admission/policy-authority.js';
import {
  AdmissionEvidenceV1Schema,
  OperationIdSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  WaiverProvenanceV1Schema,
  type AdmissionEvidenceV1,
  type ContentDigestV1,
  type WaiverProvenanceV1,
} from '../../../../src/workflow/admission/types.js';
import type { ResolvedGate } from '../../../../src/workflow/phase-kind.js';
import { explainDecision, deriveWaivable } from '../../../../src/workflow/admission/decision-explanation.js';

// ─── Fixtures (mirrors transition-command.test.ts) ───────────────────────────

const AT = '2026-08-03T12:00:00.000Z';
const EXPIRES = '2027-08-03T12:00:00.000Z';
const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };
const digestB: ContentDigestV1 = { algorithm: 'sha256', value: 'b'.repeat(64) };

const phaseAttemptId = PhaseAttemptIdSchema.parse('phase-attempt-explain-001');
const subject = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);

const declaredGate: ResolvedGate = { family: 'ladder', gate: 'check_static_analysis' };
const requirementContext = buildRequirementContext({
  phaseKind: 'GATHER',
  risk: 'low',
  boundary: false,
  reliability: 'reliable',
  declaredGates: [declaredGate],
  policy: { minimumApprovals: 0, waivable: true },
});

const gateRequirementId = (() => {
  const resolved = resolveRequirements(requirementContext);
  const frozen = freezeRequirements({ resolved, phaseAttemptId, subject });
  const first = frozen.requirements[0];
  if (first === undefined) throw new Error('fixture: expected one frozen requirement');
  return first.requirementId;
})();

const PRODUCER_ID = 'producer.gate-runner';
const WAIVER_ACTOR_ID = 'principal.release-authority';
const authority = createCapabilityAuthority([
  { principalId: PRODUCER_ID, capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
  { principalId: WAIVER_ACTOR_ID, capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
]);

const gateEvidence = (verdict: 'pass' | 'fail' | 'indeterminate'): AdmissionEvidenceV1 =>
  AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: `evidence.${verdict}`,
    requirementId: gateRequirementId,
    phaseAttemptId,
    subject,
    producer: {
      producerId: PRODUCER_ID,
      providerRef: 'provider.static-analysis',
      providerVersion: '1.0.0',
      invocationId: 'invocation-001',
    },
    policyId: 'policy-001',
    policyDigest: digestA,
    contentDigest: digestB,
    createdAt: AT,
    kind: 'gate',
    verdict,
  });

const issuedWaiver: WaiverProvenanceV1 = WaiverProvenanceV1Schema.parse({
  contractVersion: '1.0',
  waiverId: 'waiver.gate-001',
  actor: {
    principalKind: 'operator',
    principalId: WAIVER_ACTOR_ID,
    role: 'release-authority',
  },
  authorization: {
    authorizationId: 'authorization-waiver-1',
    posture: 'task-isolated',
    capabilityIds: ['capability.grant-waiver'],
    resolverVersion: '1.0',
    resolvedAt: AT,
  },
  recordedAt: AT,
  event: 'issued',
  rationale: 'accepted risk for this phase attempt pending gate repair',
  scope: { kind: 'phase-attempt', phaseAttemptId },
  subjectDigest: subject.digest,
  expiresAt: EXPIRES,
  waivedRequirementIds: [gateRequirementId],
  policyId: 'policy-001',
  policyDigest: digestA,
});

const caller = {
  principalKind: 'agent',
  principalId: 'principal.orchestrator',
  role: 'orchestrator',
} as const;
const authorization = {
  authorizationId: 'authorization-001',
  posture: 'task-isolated',
  capabilityIds: ['capability.transition'],
  resolverVersion: '1.0',
  resolvedAt: AT,
} as const;

const declaration = { fields: { ready: 'boolean' } } as const satisfies EdgeConditionDeclaration;
const legalCondition = compileEdgeCondition(
  { kind: 'factEquals', field: 'ready', value: true },
  declaration,
);
const legalFacts: EdgeConditionFacts = { fields: { ready: true }, events: [] };
const legalEdge: EdgeCandidate = { edgeId: 'gather->plan', condition: legalCondition };

/** A recording appender that runs the closure over an empty stream and commits. */
class RecordingDecider implements AdmissionDecider {
  async decideOnce<TResult>(
    _operationId: string,
    _requestDigest: string,
    closure: (ctx: DecideOnceContext) => DecideOnceDecision<TResult>,
  ): Promise<TResult> {
    const ctx: DecideOnceContext = { readStream: () => ({ events: [], version: 0 }) };
    return closure(ctx).result;
  }
}

function makeInput(overrides: {
  operationId?: string;
  activeEvidence?: readonly AdmissionEvidenceV1[];
  waivers?: readonly WaiverProvenanceV1[];
  authority?: ReturnType<typeof createCapabilityAuthority>;
}): TransitionCommandInput {
  return {
    appender: new RecordingDecider(),
    streamId: 'workflow.explain',
    operationId: OperationIdSchema.parse(overrides.operationId ?? 'operation-explain-1'),
    expectedVersion: 0,
    route: { candidates: [legalEdge], facts: legalFacts },
    lifecycle: {
      phaseAttemptId,
      subject,
      fromPhase: 'gather',
      toPhase: 'plan',
      trigger: 'execute-transition',
      featureId: 'feature-alpha',
    },
    admission: {
      requirementContext,
      activeEvidence: overrides.activeEvidence ?? [gateEvidence('pass')],
      waivers: overrides.waivers,
      authority: overrides.authority ?? authority,
      evaluatedAt: AT,
      freshnessHorizonMs: 3_600_000,
      policyId: PolicyIdSchema.parse('policy-001'),
      policyVersion: '1.0',
      policyDigest: digestA,
    },
    provenance: { caller, authorization },
  };
}

async function decide(overrides: Parameters<typeof makeInput>[0]): Promise<TransitionDecided> {
  const result = await runTransitionCommand(makeInput(overrides));
  if (result.outcome === 'route-blocked' || result.outcome === 'no-route') {
    throw new Error(`expected an admission decision, got ${result.outcome}`);
  }
  return result;
}

// ─── Explanation of a denial ─────────────────────────────────────────────────

describe('explainDecision — a denial is fully explained (no unexplained denial)', () => {
  it('Deny_Missing_CarriesResults_Identity_StableReason_AndASafeVerb', async () => {
    const decided = await decide({ activeEvidence: [] });
    const explanation = explainDecision(decided);

    expect(explanation.verdict).toBe('deny');
    expect(explanation.outcome).toBe('denied');
    expect(explanation.phaseChanged).toBe(false);

    // Policy identity — references, not copies of policy material.
    expect(explanation.policyIdentity.policyId).toBe(decided.decision.policyId);
    expect(explanation.policyIdentity.policyVersion).toBe('1.0');
    expect(explanation.policyIdentity.policyDigest).toEqual(digestA);
    expect(explanation.policyIdentity.requirementSetDigest).toEqual(
      decided.decision.requirementSetDigest,
    );
    expect(explanation.decisionId).toBe(decided.decision.decisionId);

    // Per-requirement result + stable reason code.
    expect(explanation.requirementResults).toHaveLength(1);
    const [result] = explanation.requirementResults;
    expect(result?.status).toBe('denied');
    expect(explanation.unsatisfied).toHaveLength(1);
    const unsatisfied = explanation.unsatisfied[0]!;
    expect(unsatisfied.requirementId).toBe(gateRequirementId);
    expect(unsatisfied.reason).toBe('missing');
    expect(unsatisfied.stableReason).toBe('AUTHORIZATION_DENIED');
    expect(unsatisfied.stableReason in STABLE_ERROR_REGISTRY).toBe(true);

    // Remediation is a SAFE VERB (waivable set → but 'missing' is producible).
    expect(unsatisfied.remediation.kind).toBe('action');
    expect(explanation.nextActions).toHaveLength(1);
    expect(explanation.nextActions[0]!.verb).toBe('run_gate');
    expect(() => NextAction.parse(explanation.nextActions[0])).not.toThrow();
    expect(explanation.terminalReasons).toEqual([]);
  });

  it('Deny_EveryUnsatisfiedRequirement_HasARemediation_NeverAGap', async () => {
    const decided = await decide({ activeEvidence: [] });
    const explanation = explainDecision(decided);
    // The exit proof: no unsatisfied requirement is left unexplained.
    for (const unsatisfied of explanation.unsatisfied) {
      const isSafeVerb = unsatisfied.remediation.kind === 'action';
      const isTerminal = unsatisfied.remediation.kind === 'terminal';
      expect(isSafeVerb || isTerminal).toBe(true);
    }
    expect(explanation.unsatisfied.length).toBeGreaterThan(0);
  });

  it('Deny_ExplainingNeverFlipsToAllow_AndNeverMutatesTheDecidedInput', async () => {
    const decided = await decide({ activeEvidence: [] });
    const before = JSON.stringify(decided);

    const explanation = explainDecision(decided);

    // The verdict stays a deny — explanation is not a pass-state shortcut.
    expect(explanation.verdict).toBe('deny');
    expect(explanation.requirementResults.some((r) => r.status === 'satisfied')).toBe(false);
    // The decided record is byte-for-byte untouched by explaining it.
    expect(JSON.stringify(decided)).toBe(before);
    // Every emitted action is inert data (no callable effect handle).
    for (const action of explanation.nextActions) {
      for (const value of Object.values(action)) {
        expect(typeof value).not.toBe('function');
      }
    }
  });
});

// ─── Explanation of an allow, and waiver-driven allow fidelity (d) ───────────

describe('explainDecision — allow and waiver-driven allow', () => {
  it('Allow_Satisfied_ReportsNoUnsatisfiedNoWaivedAndNoNextActions', async () => {
    const decided = await decide({ activeEvidence: [gateEvidence('pass')] });
    const explanation = explainDecision(decided);

    expect(explanation.verdict).toBe('allow');
    expect(explanation.phaseChanged).toBe(true);
    expect(explanation.requirementResults[0]?.status).toBe('satisfied');
    expect(explanation.unsatisfied).toEqual([]);
    expect(explanation.waivedFailures).toEqual([]);
    expect(explanation.nextActions).toEqual([]);
    expect(explanation.terminalReasons).toEqual([]);
  });

  it('WaiverDrivenAllow_SurfacesTheWaivedFailureAndTheWaiverId', async () => {
    // A failing gate that a scoped, authorized, unexpired waiver rescues:
    // admission SUCCEEDS, but the failure stays recorded and must be surfaced.
    const decided = await decide({
      activeEvidence: [gateEvidence('fail')],
      waivers: [issuedWaiver],
    });
    const explanation = explainDecision(decided);

    expect(explanation.verdict).toBe('allow');
    expect(explanation.phaseChanged).toBe(true);

    // The requirement result records the waiver, its reason, and the waiver id.
    const waivedResult = explanation.requirementResults.find((r) => r.status === 'waived');
    expect(waivedResult).toBeDefined();
    if (waivedResult?.status === 'waived') {
      expect(waivedResult.reason).toBe('failed');
      expect(waivedResult.stableReason).toBe('AUTHORIZATION_DENIED');
      expect(waivedResult.waiverId).toBe('waiver.gate-001');
    }

    // (d) the durable waived-failure surface: which failure, by which waiver.
    expect(explanation.waivedFailures).toHaveLength(1);
    const waived = explanation.waivedFailures[0]!;
    expect(waived.requirementId).toBe(gateRequirementId);
    expect(waived.reason).toBe('failed');
    expect(waived.waiverId).toBe('waiver.gate-001');
    expect(explanation.waiverIds).toContain('waiver.gate-001');

    // A waiver-driven allow is NOT a denial — no unsatisfied, no terminal.
    expect(explanation.unsatisfied).toEqual([]);
    expect(explanation.terminalReasons).toEqual([]);
  });
});

// ─── Explanation of an indeterminate verdict ─────────────────────────────────

describe('explainDecision — indeterminate fails closed with a retry verb', () => {
  it('Indeterminate_UndecidedGate_ExplainedWithACodeAndARetryAction', async () => {
    const decided = await decide({ activeEvidence: [gateEvidence('indeterminate')] });
    const explanation = explainDecision(decided);

    expect(explanation.verdict).toBe('indeterminate');
    expect(explanation.phaseChanged).toBe(false);

    const result = explanation.requirementResults[0];
    expect(result?.status).toBe('indeterminate');
    if (result?.status === 'indeterminate') {
      expect(result.code).toBe('EVALUATOR_FAILED');
      expect(result.remediation.verb).toBe('retry_transition');
      expect(() => NextAction.parse(result.remediation)).not.toThrow();
    }
    // The retry verb is surfaced as a safe next action.
    expect(explanation.nextActions.map((a) => a.verb)).toContain('retry_transition');
  });
});

// ─── deriveWaivable is faithful to the persisted decision ────────────────────

describe('deriveWaivable — read faithfully from the persisted decision', () => {
  it('Deny_WithWaivablePolicy_DerivesWaivableTrueFromTheRecord', async () => {
    const decided = await decide({ activeEvidence: [] });
    expect(deriveWaivable(decided.decision)).toBe(true);
  });

  it('Allow_WithAWaivedRequirement_DerivesWaivableTrue', async () => {
    const decided = await decide({
      activeEvidence: [gateEvidence('fail')],
      waivers: [issuedWaiver],
    });
    expect(deriveWaivable(decided.decision)).toBe(true);
  });
});
