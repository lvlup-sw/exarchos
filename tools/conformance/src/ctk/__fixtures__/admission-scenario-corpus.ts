/**
 * A deterministic corpus of admission scenarios. The CTK and the admission
 * performance benchmark share it.
 *
 * The corpus covers the three route outcomes, the requirement-resolution lattice
 * (risk, boundary, reliability), the three requirement kinds and the three policy
 * verdicts. Each scenario carries its expected route and verdict. The inputs come from
 * the real admission constructors, so a scenario cannot drift out of contract
 * silently. The module is data only: it does no I/O and reads no clock or
 * configuration.
 */

import {
  AdmissionEvidenceV1Schema,
  ApprovalClassSchema,
  PhaseAttemptIdSchema,
  PolicyIdSchema,
  type AdmissionEvidenceV1,
  type AdmissionRequirementV1,
  type ContentDigestV1,
  type EvidenceSubjectV1,
  type PhaseAttemptId,
} from '../../../../../src/workflow/admission/types.js';
import { createEvidenceSubject } from '../../../../../src/workflow/admission/evidence-subject.js';
import {
  createCapabilityAuthority,
  DENY_ALL_AUTHORITY,
  POLICY_CAPABILITY,
  type PolicyAuthority,
} from '../../../../../src/workflow/admission/policy-authority.js';
import {
  buildRequirementContext,
  type RequirementContextInput,
} from '../../../../../src/workflow/admission/requirement-context.js';
import { resolveRequirements } from '../../../../../src/workflow/admission/requirement-resolution.js';
import { freezeRequirements } from '../../../../../src/workflow/admission/freeze-requirements.js';
import {
  compileEdgeCondition,
  type EdgeConditionDeclaration,
} from '../../../../../src/workflow/admission/edge-condition.js';
import type { EdgeConditionFacts } from '../../../../../src/workflow/admission/edge-condition-evaluate.js';
import type { EdgeCandidate } from '../../../../../src/workflow/admission/edge-condition-select.js';
import type { ResolvedGate } from '../../../../../src/workflow/phase-kind.js';

import type { AdmissionScenario } from './admission-decision-path.js';

const AT = '2026-08-03T12:00:00.000Z';
/** Thirty minutes before AT, inside the freshness horizon. */
const RECENT = '2026-08-03T11:30:00.000Z';
/** Long before AT, outside the freshness horizon. */
const ANCIENT = '2000-01-01T00:00:00.000Z';
const FRESHNESS_HORIZON_MS = 3_600_000;

const digestA: ContentDigestV1 = { algorithm: 'sha256', value: 'a'.repeat(64) };
const digestB: ContentDigestV1 = { algorithm: 'sha256', value: 'b'.repeat(64) };

const phaseAttemptId: PhaseAttemptId = PhaseAttemptIdSchema.parse(
  'phase-attempt-ctk-001',
);
const subject: EvidenceSubjectV1 = createEvidenceSubject(
  { kind: 'phase-attempt', phaseAttemptId },
  { phase: 'gather', attempt: 1 },
);
const policyId = PolicyIdSchema.parse('policy-ctk-001');
const approvalClass = ApprovalClassSchema.parse('admission.approval');

/**
 * A trusted gate producer. The authority is the out-of-band trust oracle, so a
 * record cannot widen its own authorization.
 */
const GATE_PRODUCER_A = 'producer.gate-runner-a';
const GATE_PRODUCER_B = 'producer.gate-runner-b';
const GATE_PRODUCER_C = 'producer.gate-runner-c';
const GATE_PRODUCER_D = 'producer.gate-runner-d';
const APPROVER_A = 'principal.approver-a';
const APPROVER_B = 'principal.approver-b';

const trustAll: PolicyAuthority = createCapabilityAuthority([
  {
    principalId: GATE_PRODUCER_A,
    capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE],
  },
  {
    principalId: GATE_PRODUCER_B,
    capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE],
  },
  {
    principalId: GATE_PRODUCER_C,
    capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE],
  },
  {
    principalId: GATE_PRODUCER_D,
    capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE],
  },
  { principalId: APPROVER_A, capabilities: [POLICY_CAPABILITY.ISSUE_APPROVAL] },
  { principalId: APPROVER_B, capabilities: [POLICY_CAPABILITY.ISSUE_APPROVAL] },
]);

let evidenceCounter = 0;
function nextEvidenceId(prefix: string): string {
  evidenceCounter += 1;
  return `${prefix}-${evidenceCounter.toString().padStart(4, '0')}`;
}

function gateEvidence(
  requirementId: string,
  producerId: string,
  verdict: 'pass' | 'fail' | 'indeterminate',
  createdAt: string = RECENT,
): AdmissionEvidenceV1 {
  return AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: nextEvidenceId('evidence.gate'),
    requirementId,
    phaseAttemptId,
    subject,
    producer: {
      producerId,
      providerRef: 'provider.static-analysis',
      providerVersion: '1.0.0',
      invocationId: nextEvidenceId('invocation'),
    },
    policyId: 'policy-ctk-001',
    policyDigest: digestA,
    contentDigest: digestB,
    createdAt,
    kind: 'gate',
    verdict,
  });
}

function approvalEvidence(
  requirementId: string,
  principalId: string,
  verdict: 'approved' | 'rejected',
  createdAt: string = RECENT,
): AdmissionEvidenceV1 {
  const attributedTo = {
    principalKind: 'agent' as const,
    principalId,
    role: 'reviewer',
  };
  return AdmissionEvidenceV1Schema.parse({
    contractVersion: '1.0',
    evidenceId: nextEvidenceId('evidence.approval'),
    requirementId,
    phaseAttemptId,
    subject,
    producer: {
      producerId: principalId,
      providerRef: 'provider.human-approval',
      providerVersion: '1.0.0',
      invocationId: nextEvidenceId('invocation'),
    },
    policyId: 'policy-ctk-001',
    policyDigest: digestA,
    contentDigest: digestB,
    createdAt,
    kind: 'approval',
    verdict,
    attributedTo,
  });
}

/** Freeze the requirement set for a context so evidence can bind to real ids. */
function frozenRequirements(
  contextInput: RequirementContextInput,
): readonly AdmissionRequirementV1[] {
  const context = buildRequirementContext(contextInput);
  const resolved = resolveRequirements(context);
  const frozen = freezeRequirements({
    resolved,
    phaseAttemptId,
    subject,
    approvalClass,
  });
  return frozen.requirements;
}

/**
 * Builds satisfying evidence for a frozen requirement set. A gate requirement gets
 * one passing gate evidence. An approval requirement gets `minimumApprovals`
 * approvals that rotate over two approvers. A corroboration requirement gets
 * `minimumIndependentSources` passing gate evidence that rotates over four producers.
 */
function satisfyingEvidence(
  requirements: readonly AdmissionRequirementV1[],
): readonly AdmissionEvidenceV1[] {
  const approvers = [APPROVER_A, APPROVER_B];
  const producers = [
    GATE_PRODUCER_A,
    GATE_PRODUCER_B,
    GATE_PRODUCER_C,
    GATE_PRODUCER_D,
  ];
  const evidence: AdmissionEvidenceV1[] = [];
  for (const requirement of requirements) {
    switch (requirement.kind) {
      case 'gate-evidence':
        evidence.push(
          gateEvidence(requirement.requirementId, GATE_PRODUCER_A, 'pass'),
        );
        break;
      case 'approval':
        for (let i = 0; i < requirement.minimumApprovals; i += 1) {
          evidence.push(
            approvalEvidence(
              requirement.requirementId,
              approvers[i % approvers.length] ?? APPROVER_A,
              'approved',
            ),
          );
        }
        break;
      case 'corroboration':
        for (let i = 0; i < requirement.minimumIndependentSources; i += 1) {
          evidence.push(
            gateEvidence(
              requirement.requirementId,
              producers[i % producers.length] ?? GATE_PRODUCER_A,
              'pass',
            ),
          );
        }
        break;
    }
  }
  return evidence;
}

const routeDeclaration = {
  fields: { ready: 'boolean' },
} as const satisfies EdgeConditionDeclaration;

const legalCondition = compileEdgeCondition(
  { kind: 'factEquals', field: 'ready', value: true },
  routeDeclaration,
);
const legalEdge: EdgeCandidate = {
  edgeId: 'ctk->next',
  condition: legalCondition,
};
const legalFacts: EdgeConditionFacts = { fields: { ready: true }, events: [] };
const illegalFacts: EdgeConditionFacts = { fields: { ready: false }, events: [] };

/**
 * A candidate whose field is not in the facts evaluates to `indeterminate`. Route
 * selection then fails closed as `blocked`.
 */
const indeterminateDeclaration = {
  fields: { missing: 'boolean' },
} as const satisfies EdgeConditionDeclaration;
const indeterminateCondition = compileEdgeCondition(
  { kind: 'factEquals', field: 'missing', value: true },
  indeterminateDeclaration,
);
const indeterminateEdge: EdgeCandidate = {
  edgeId: 'ctk->maybe',
  condition: indeterminateCondition,
};
const emptyFacts: EdgeConditionFacts = { fields: {}, events: [] };

interface ScenarioSpec {
  readonly name: string;
  readonly context: RequirementContextInput;
  readonly authority?: PolicyAuthority;
  readonly evidence: readonly AdmissionEvidenceV1[];
  readonly route?: { candidates: readonly EdgeCandidate[]; facts: EdgeConditionFacts };
  readonly expect: AdmissionScenario['expect'];
}

function scenario(spec: ScenarioSpec): AdmissionScenario {
  return {
    name: spec.name,
    route: spec.route ?? { candidates: [legalEdge], facts: legalFacts },
    requirementContext: buildRequirementContext(spec.context),
    phaseAttemptId,
    subject,
    approvalClass,
    activeEvidence: spec.evidence,
    authority: spec.authority ?? trustAll,
    evaluatedAt: AT,
    freshnessHorizonMs: FRESHNESS_HORIZON_MS,
    expect: spec.expect,
  };
}

/**
 * The one declared gate of `gatherContext`, a low-risk, reliable GATHER context that
 * touches no boundary. That context has one obligation, a gate-evidence requirement.
 * This is the simplest unit for each verdict.
 */
const gatherGate: ResolvedGate = {
  family: 'ladder',
  gate: 'check_static_analysis',
};
const gatherContext: RequirementContextInput = {
  phaseKind: 'GATHER',
  risk: 'low',
  boundary: false,
  reliability: 'reliable',
  declaredGates: [gatherGate],
  policy: { minimumApprovals: 0, waivable: true },
};
const gatherRequirements = frozenRequirements(gatherContext);
const gatherRequirementId = gatherRequirements[0]?.requirementId ?? '';

/**
 * A high-risk context. The risk adds one approval obligation to the gate. Full
 * evidence gives `allow`, and a missing approval gives `deny`.
 */
const highRiskContext: RequirementContextInput = {
  phaseKind: 'GATHER',
  risk: 'high',
  boundary: false,
  reliability: 'reliable',
  declaredGates: [gatherGate],
  policy: { minimumApprovals: 0, waivable: true },
};
const highRiskRequirements = frozenRequirements(highRiskContext);

/**
 * An unknown-risk context, the strongest lattice point. It adds approval and
 * corroboration obligations. Full evidence gives `allow`.
 */
const unknownRiskContext: RequirementContextInput = {
  phaseKind: 'GATHER',
  risk: 'unknown',
  boundary: 'indeterminate',
  reliability: 'unknown',
  declaredGates: [gatherGate],
  policy: { minimumApprovals: 1, waivable: false },
};
const unknownRiskRequirements = frozenRequirements(unknownRiskContext);

export const admissionScenarioCorpus: readonly AdmissionScenario[] = Object.freeze([
  /** Gate-only scenarios: passing, missing, failing, indeterminate, stale and unauthorized evidence. */
  scenario({
    name: 'gate/allow/passing-evidence',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'pass')],
    expect: { route: 'selected', verdict: 'allow' },
  }),
  scenario({
    name: 'gate/deny/missing-evidence',
    context: gatherContext,
    evidence: [],
    expect: { route: 'selected', verdict: 'deny' },
  }),
  scenario({
    name: 'gate/deny/failing-evidence',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'fail')],
    expect: { route: 'selected', verdict: 'deny' },
  }),
  scenario({
    name: 'gate/indeterminate/evaluator-failed',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'indeterminate')],
    expect: { route: 'selected', verdict: 'indeterminate' },
  }),
  scenario({
    name: 'gate/deny/stale-evidence',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'pass', ANCIENT)],
    expect: { route: 'selected', verdict: 'deny' },
  }),
  scenario({
    name: 'gate/deny/unauthorized-producer',
    context: gatherContext,
    authority: DENY_ALL_AUTHORITY,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'pass')],
    expect: { route: 'selected', verdict: 'deny' },
  }),

  /** High risk adds an approval obligation. */
  scenario({
    name: 'high-risk/allow/gate+approval',
    context: highRiskContext,
    evidence: satisfyingEvidence(highRiskRequirements),
    expect: { route: 'selected', verdict: 'allow' },
  }),
  scenario({
    name: 'high-risk/deny/missing-approval',
    context: highRiskContext,
    evidence: highRiskRequirements
      .filter((r) => r.kind === 'gate-evidence')
      .map((r) => gateEvidence(r.requirementId, GATE_PRODUCER_A, 'pass')),
    expect: { route: 'selected', verdict: 'deny' },
  }),

  /**
   * Unknown risk, an indeterminate boundary and unknown reliability require a gate,
   * an approval and corroboration.
   */
  scenario({
    name: 'unknown-risk/allow/gate+approval+corroboration',
    context: unknownRiskContext,
    evidence: satisfyingEvidence(unknownRiskRequirements),
    expect: { route: 'selected', verdict: 'allow' },
  }),
  scenario({
    name: 'unknown-risk/deny/missing-corroboration',
    context: unknownRiskContext,
    evidence: unknownRiskRequirements
      .filter((r) => r.kind === 'gate-evidence' || r.kind === 'approval')
      .flatMap((r) =>
        r.kind === 'gate-evidence'
          ? [gateEvidence(r.requirementId, GATE_PRODUCER_A, 'pass')]
          : [approvalEvidence(r.requirementId, APPROVER_A, 'approved')],
      ),
    expect: { route: 'selected', verdict: 'deny' },
  }),

  /** Route topology: a leading indeterminate candidate blocks, and all-false facts give no match. */
  scenario({
    name: 'route/blocked/indeterminate-candidate',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'pass')],
    route: { candidates: [indeterminateEdge], facts: emptyFacts },
    expect: { route: 'blocked' },
  }),
  scenario({
    name: 'route/no-match/all-false',
    context: gatherContext,
    evidence: [gateEvidence(gatherRequirementId, GATE_PRODUCER_A, 'pass')],
    route: { candidates: [legalEdge], facts: illegalFacts },
    expect: { route: 'no-match' },
  }),
]);

/**
 * The subset of the corpus that produces a well-formed `allow` over a bound
 * gate/approval/corroboration set — the streams the replay suite reconstructs
 * to an `intact` fold.
 */
export const cleanAllowScenarios: readonly AdmissionScenario[] = Object.freeze(
  admissionScenarioCorpus.filter(
    (s) => s.expect.route === 'selected' && s.expect.verdict === 'allow',
  ),
);

/** A single representative scenario for the strict worst-single-decision bench. */
export const worstCaseScenario: AdmissionScenario =
  admissionScenarioCorpus.find(
    (s) => s.name === 'unknown-risk/allow/gate+approval+corroboration',
  ) ?? (admissionScenarioCorpus[0] as AdmissionScenario);
