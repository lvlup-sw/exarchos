import { z } from 'zod';

/**
 * Internal, append-only admission proof contract.
 *
 * This version identifies persisted runtime records; it is not a public
 * transition response and does not define workflow topology or policy.
 * Compatible fields may be added in later runtime contract versions while
 * historical V1 records remain replayable.
 */
export const ADMISSION_RUNTIME_CONTRACT_VERSION = '1.0' as const;
export const AdmissionRuntimeContractVersionSchema = z.literal(
  ADMISSION_RUNTIME_CONTRACT_VERSION,
);

// Stable IDs deliberately accept opaque, provider-neutral tokens while
// rejecting blanks, path-like values, and values whose identity changes under
// trimming. Calling `.parse()` is the only supported way to construct a
// branded ID from untrusted text.
const StableIdValueSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    'stable IDs may contain only letters, digits, dot, underscore, colon, and hyphen',
  );

export const RequirementIdSchema =
  StableIdValueSchema.brand<'AdmissionRequirementId'>();
export type RequirementId = z.infer<typeof RequirementIdSchema>;

export const EvidenceIdSchema = StableIdValueSchema.brand<'AdmissionEvidenceId'>();
export type EvidenceId = z.infer<typeof EvidenceIdSchema>;

export const DecisionIdSchema = StableIdValueSchema.brand<'AdmissionDecisionId'>();
export type DecisionId = z.infer<typeof DecisionIdSchema>;

export const WaiverIdSchema = StableIdValueSchema.brand<'AdmissionWaiverId'>();
export type WaiverId = z.infer<typeof WaiverIdSchema>;

export const WorkflowIdSchema = StableIdValueSchema.brand<'AdmissionWorkflowId'>();
export type WorkflowId = z.infer<typeof WorkflowIdSchema>;

export const PhaseAttemptIdSchema =
  StableIdValueSchema.brand<'AdmissionPhaseAttemptId'>();
export type PhaseAttemptId = z.infer<typeof PhaseAttemptIdSchema>;

export const WaveIdSchema = StableIdValueSchema.brand<'AdmissionWaveId'>();
export type WaveId = z.infer<typeof WaveIdSchema>;

export const TaskIdSchema = StableIdValueSchema.brand<'AdmissionTaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const CommitIdSchema = StableIdValueSchema.brand<'AdmissionCommitId'>();
export type CommitId = z.infer<typeof CommitIdSchema>;

export const DiffIdSchema = StableIdValueSchema.brand<'AdmissionDiffId'>();
export type DiffId = z.infer<typeof DiffIdSchema>;

export const ArtifactIdSchema = StableIdValueSchema.brand<'AdmissionArtifactId'>();
export type ArtifactId = z.infer<typeof ArtifactIdSchema>;

export const GateIdSchema = StableIdValueSchema.brand<'AdmissionGateId'>();
export type GateId = z.infer<typeof GateIdSchema>;

export const PolicyIdSchema = StableIdValueSchema.brand<'AdmissionPolicyId'>();
export type PolicyId = z.infer<typeof PolicyIdSchema>;

export const OperationIdSchema = StableIdValueSchema.brand<'AdmissionOperationId'>();
export type OperationId = z.infer<typeof OperationIdSchema>;

export const InvocationIdSchema =
  StableIdValueSchema.brand<'AdmissionInvocationId'>();
export type InvocationId = z.infer<typeof InvocationIdSchema>;

export const PrincipalIdSchema = StableIdValueSchema.brand<'AdmissionPrincipalId'>();
export type PrincipalId = z.infer<typeof PrincipalIdSchema>;

export const ProviderRefSchema = StableIdValueSchema.brand<'AdmissionProviderRef'>();
export type ProviderRef = z.infer<typeof ProviderRefSchema>;

export const AuthorizationIdSchema =
  StableIdValueSchema.brand<'AdmissionAuthorizationId'>();
export type AuthorizationId = z.infer<typeof AuthorizationIdSchema>;

export const CapabilityIdSchema =
  StableIdValueSchema.brand<'AdmissionCapabilityId'>();
export type CapabilityId = z.infer<typeof CapabilityIdSchema>;

export const ApprovalClassSchema =
  StableIdValueSchema.brand<'AdmissionApprovalClass'>();
export type ApprovalClass = z.infer<typeof ApprovalClassSchema>;

const NonEmptyTextSchema = z.string().trim().min(1).max(2_000);
const VersionTextSchema = z.string().trim().min(1).max(128);
const TimestampSchema = z.string().datetime({ offset: true });

/** V1 accepts one deterministic content-addressing algorithm. */
export const ContentDigestV1Schema = z
  .object({
    algorithm: z.literal('sha256'),
    value: z.string().regex(/^[a-f0-9]{64}$/, 'sha256 digest must be 64 lowercase hex characters'),
  })
  .strict()
  .readonly();
export type ContentDigestV1 = z.infer<typeof ContentDigestV1Schema>;

// ─── Immutable evidence subjects ────────────────────────────────────────────

const WorkflowSubjectV1Schema = z
  .object({
    kind: z.literal('workflow'),
    workflowId: WorkflowIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const PhaseAttemptSubjectV1Schema = z
  .object({
    kind: z.literal('phase-attempt'),
    phaseAttemptId: PhaseAttemptIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const WaveSubjectV1Schema = z
  .object({
    kind: z.literal('wave'),
    waveId: WaveIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const TaskSubjectV1Schema = z
  .object({
    kind: z.literal('task'),
    taskId: TaskIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const CommitSubjectV1Schema = z
  .object({
    kind: z.literal('commit'),
    commitId: CommitIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const DiffSubjectV1Schema = z
  .object({
    kind: z.literal('diff'),
    diffId: DiffIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const ArtifactSubjectV1Schema = z
  .object({
    kind: z.literal('artifact'),
    artifactId: ArtifactIdSchema,
    digest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

export const EvidenceSubjectV1Schema = z.discriminatedUnion('kind', [
  WorkflowSubjectV1Schema,
  PhaseAttemptSubjectV1Schema,
  WaveSubjectV1Schema,
  TaskSubjectV1Schema,
  CommitSubjectV1Schema,
  DiffSubjectV1Schema,
  ArtifactSubjectV1Schema,
]);
export type EvidenceSubjectV1 = z.infer<typeof EvidenceSubjectV1Schema>;

// ─── Attributable identity and authorization snapshots ─────────────────────

const PrincipalFields = {
  principalId: PrincipalIdSchema,
  role: StableIdValueSchema,
} as const;

const OperatorPrincipalV1Schema = z
  .object({ principalKind: z.literal('operator'), ...PrincipalFields })
  .strict()
  .readonly();
const AgentPrincipalV1Schema = z
  .object({ principalKind: z.literal('agent'), ...PrincipalFields })
  .strict()
  .readonly();
const ServicePrincipalV1Schema = z
  .object({ principalKind: z.literal('service'), ...PrincipalFields })
  .strict()
  .readonly();

export const AttributedPrincipalV1Schema = z.discriminatedUnion('principalKind', [
  OperatorPrincipalV1Schema,
  AgentPrincipalV1Schema,
  ServicePrincipalV1Schema,
]);
export type AttributedPrincipalV1 = z.infer<typeof AttributedPrincipalV1Schema>;

export const AuthorizationSnapshotV1Schema = z
  .object({
    authorizationId: AuthorizationIdSchema,
    posture: z.enum(['read-only', 'task-isolated', 'shared-mutating']),
    capabilityIds: z.array(CapabilityIdSchema).min(1).readonly(),
    resolverVersion: VersionTextSchema,
    resolvedAt: TimestampSchema,
  })
  .strict()
  .readonly();
export type AuthorizationSnapshotV1 = z.infer<
  typeof AuthorizationSnapshotV1Schema
>;

// ─── Requirements ───────────────────────────────────────────────────────────

const RequirementFields = {
  contractVersion: AdmissionRuntimeContractVersionSchema,
  requirementId: RequirementIdSchema,
  phaseAttemptId: PhaseAttemptIdSchema,
  subject: EvidenceSubjectV1Schema,
} as const;

const GateEvidenceRequirementV1Schema = z
  .object({
    ...RequirementFields,
    kind: z.literal('gate-evidence'),
    gateId: GateIdSchema,
  })
  .strict()
  .readonly();

const ApprovalRequirementV1Schema = z
  .object({
    ...RequirementFields,
    kind: z.literal('approval'),
    approvalClass: ApprovalClassSchema,
    minimumApprovals: z.number().int().positive(),
  })
  .strict()
  .readonly();

const CorroborationRequirementV1Schema = z
  .object({
    ...RequirementFields,
    kind: z.literal('corroboration'),
    sourceRequirementId: RequirementIdSchema,
    minimumIndependentSources: z.number().int().min(2),
  })
  .strict()
  .readonly();

/**
 * A frozen requirement fact emitted by the runtime. This is intentionally not
 * a requirement registry or authoring policy.
 */
export const AdmissionRequirementV1Schema = z.discriminatedUnion('kind', [
  GateEvidenceRequirementV1Schema,
  ApprovalRequirementV1Schema,
  CorroborationRequirementV1Schema,
]);
export type AdmissionRequirementV1 = z.infer<typeof AdmissionRequirementV1Schema>;

// ─── Evidence ───────────────────────────────────────────────────────────────

export const EvidenceProducerV1Schema = z
  .object({
    producerId: PrincipalIdSchema,
    providerRef: ProviderRefSchema,
    providerVersion: VersionTextSchema,
    invocationId: InvocationIdSchema,
  })
  .strict()
  .readonly();
export type EvidenceProducerV1 = z.infer<typeof EvidenceProducerV1Schema>;

const EvidenceFields = {
  contractVersion: AdmissionRuntimeContractVersionSchema,
  evidenceId: EvidenceIdSchema,
  requirementId: RequirementIdSchema,
  phaseAttemptId: PhaseAttemptIdSchema,
  subject: EvidenceSubjectV1Schema,
  producer: EvidenceProducerV1Schema,
  policyId: PolicyIdSchema,
  policyDigest: ContentDigestV1Schema,
  contentDigest: ContentDigestV1Schema,
  createdAt: TimestampSchema,
} as const;

const GateEvidenceV1Schema = z
  .object({
    ...EvidenceFields,
    kind: z.literal('gate'),
    verdict: z.enum(['pass', 'fail', 'indeterminate']),
  })
  .strict()
  .readonly();

const ApprovalEvidenceV1Schema = z
  .object({
    ...EvidenceFields,
    kind: z.literal('approval'),
    verdict: z.enum(['approved', 'rejected']),
    attributedTo: AttributedPrincipalV1Schema,
  })
  .strict()
  .readonly();

export const AdmissionEvidenceV1Schema = z.discriminatedUnion('kind', [
  GateEvidenceV1Schema,
  ApprovalEvidenceV1Schema,
]);
export type AdmissionEvidenceV1 = z.infer<typeof AdmissionEvidenceV1Schema>;

// ─── Typed remediation ──────────────────────────────────────────────────────

const RunGateRemediationV1Schema = z
  .object({
    action: z.literal('run_gate'),
    requirementId: RequirementIdSchema,
    gateId: GateIdSchema,
  })
  .strict()
  .readonly();

const CollectEvidenceRemediationV1Schema = z
  .object({
    action: z.literal('collect_evidence'),
    requirementId: RequirementIdSchema,
    subject: EvidenceSubjectV1Schema,
  })
  .strict()
  .readonly();

const ClassifyRiskRemediationV1Schema = z
  .object({
    action: z.literal('classify_risk'),
    phaseAttemptId: PhaseAttemptIdSchema,
  })
  .strict()
  .readonly();

const RequestApprovalRemediationV1Schema = z
  .object({
    action: z.literal('request_approval'),
    requirementId: RequirementIdSchema,
  })
  .strict()
  .readonly();

const RequestWaiverRemediationV1Schema = z
  .object({
    action: z.literal('request_waiver'),
    requirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    phaseAttemptId: PhaseAttemptIdSchema,
  })
  .strict()
  .readonly();

const RetryTransitionRemediationV1Schema = z
  .object({
    action: z.literal('retry_transition'),
    phaseAttemptId: PhaseAttemptIdSchema,
  })
  .strict()
  .readonly();

export const RemediationActionV1Schema = z.discriminatedUnion('action', [
  RunGateRemediationV1Schema,
  CollectEvidenceRemediationV1Schema,
  ClassifyRiskRemediationV1Schema,
  RequestApprovalRemediationV1Schema,
  RequestWaiverRemediationV1Schema,
  RetryTransitionRemediationV1Schema,
]);
export type RemediationActionV1 = z.infer<typeof RemediationActionV1Schema>;

// ─── Internal decision records ──────────────────────────────────────────────

export const UnsatisfiedRequirementReasonSchema = z.enum([
  'missing',
  'failed',
  'stale',
  'malformed',
  'contradictory',
  'waiver-expired',
]);
export type UnsatisfiedRequirementReason = z.infer<
  typeof UnsatisfiedRequirementReasonSchema
>;

const UnsatisfiedRequirementV1Schema = z
  .object({
    requirementId: RequirementIdSchema,
    reason: UnsatisfiedRequirementReasonSchema,
  })
  .strict()
  .readonly();

export const AdmissionIndeterminateCodeSchema = z.enum([
  'POLICY_UNAVAILABLE',
  'REQUIREMENT_UNRESOLVED',
  'EVIDENCE_MALFORMED',
  'EVIDENCE_UNSUPPORTED',
  'DIGEST_MISMATCH',
  'EVALUATOR_FAILED',
]);
export type AdmissionIndeterminateCode = z.infer<
  typeof AdmissionIndeterminateCodeSchema
>;

const AdmissionIndeterminateErrorV1Schema = z
  .object({
    code: AdmissionIndeterminateCodeSchema,
    message: NonEmptyTextSchema,
  })
  .strict()
  .readonly();

const DecisionFields = {
  contractVersion: AdmissionRuntimeContractVersionSchema,
  decisionId: DecisionIdSchema,
  operationId: OperationIdSchema,
  phaseAttemptId: PhaseAttemptIdSchema,
  policyId: PolicyIdSchema,
  policyVersion: VersionTextSchema,
  policyDigest: ContentDigestV1Schema,
  requirementSetDigest: ContentDigestV1Schema,
  inputDigest: ContentDigestV1Schema,
  evidenceIds: z.array(EvidenceIdSchema).readonly(),
  waiverIds: z.array(WaiverIdSchema).readonly(),
  decidedAt: TimestampSchema,
} as const;

const AllowDecisionRecordV1Schema = z
  .object({
    ...DecisionFields,
    outcome: z.literal('allow'),
    satisfiedRequirementIds: z.array(RequirementIdSchema).readonly(),
    waivedRequirementIds: z.array(RequirementIdSchema).readonly(),
  })
  .strict()
  .readonly();

const DenyDecisionRecordV1Schema = z
  .object({
    ...DecisionFields,
    outcome: z.literal('deny'),
    satisfiedRequirementIds: z.array(RequirementIdSchema).readonly(),
    unsatisfiedRequirements: z
      .array(UnsatisfiedRequirementV1Schema)
      .min(1)
      .readonly(),
    remediation: z.array(RemediationActionV1Schema).min(1).readonly(),
  })
  .strict()
  .readonly();

const IndeterminateDecisionRecordV1Schema = z
  .object({
    ...DecisionFields,
    outcome: z.literal('indeterminate'),
    unresolvedRequirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    errors: z.array(AdmissionIndeterminateErrorV1Schema).min(1).readonly(),
    remediation: z.array(RemediationActionV1Schema).min(1).readonly(),
  })
  .strict()
  .readonly();

/**
 * Persisted internal decision fact. It must not be used as the v2.12 public
 * transition result carrier.
 *
 * Strict outcome arms reject mixed records (for example `outcome: "allow"`
 * with `unsatisfiedRequirements`) instead of silently dropping incompatible
 * fields.
 */
export const AdmissionDecisionRecordV1Schema = z.discriminatedUnion('outcome', [
  AllowDecisionRecordV1Schema,
  DenyDecisionRecordV1Schema,
  IndeterminateDecisionRecordV1Schema,
]);
export type AdmissionDecisionRecordV1 = z.infer<
  typeof AdmissionDecisionRecordV1Schema
>;

/** Boundary constructor for an internal, immutable V1 decision record. */
export function parseAdmissionDecisionRecordV1(
  input: unknown,
): AdmissionDecisionRecordV1 {
  return AdmissionDecisionRecordV1Schema.parse(input);
}

/** Non-throwing guard for folds that read historical event payloads. */
export function isAdmissionDecisionRecordV1(
  input: unknown,
): input is AdmissionDecisionRecordV1 {
  return AdmissionDecisionRecordV1Schema.safeParse(input).success;
}

// ─── Attributable waiver provenance ─────────────────────────────────────────

const WorkflowWaiverScopeV1Schema = z
  .object({
    kind: z.literal('workflow'),
    workflowId: WorkflowIdSchema,
  })
  .strict()
  .readonly();

const PhaseAttemptWaiverScopeV1Schema = z
  .object({
    kind: z.literal('phase-attempt'),
    phaseAttemptId: PhaseAttemptIdSchema,
  })
  .strict()
  .readonly();

const SubjectWaiverScopeV1Schema = z
  .object({
    kind: z.literal('subject'),
    subject: EvidenceSubjectV1Schema,
  })
  .strict()
  .readonly();

export const WaiverScopeV1Schema = z.discriminatedUnion('kind', [
  WorkflowWaiverScopeV1Schema,
  PhaseAttemptWaiverScopeV1Schema,
  SubjectWaiverScopeV1Schema,
]);
export type WaiverScopeV1 = z.infer<typeof WaiverScopeV1Schema>;

const WaiverProvenanceFields = {
  contractVersion: AdmissionRuntimeContractVersionSchema,
  waiverId: WaiverIdSchema,
  actor: AttributedPrincipalV1Schema,
  authorization: AuthorizationSnapshotV1Schema,
  recordedAt: TimestampSchema,
} as const;

const IssuedWaiverProvenanceV1Schema = z
  .object({
    ...WaiverProvenanceFields,
    event: z.literal('issued'),
    rationale: NonEmptyTextSchema,
    scope: WaiverScopeV1Schema,
    subjectDigest: ContentDigestV1Schema,
    expiresAt: TimestampSchema,
    waivedRequirementIds: z.array(RequirementIdSchema).min(1).readonly(),
    policyId: PolicyIdSchema,
    policyDigest: ContentDigestV1Schema,
  })
  .strict()
  .readonly();

const RevokedWaiverProvenanceV1Schema = z
  .object({
    ...WaiverProvenanceFields,
    event: z.literal('revoked'),
    reason: NonEmptyTextSchema,
  })
  .strict()
  .readonly();

const SupersededWaiverProvenanceV1Schema = z
  .object({
    ...WaiverProvenanceFields,
    event: z.literal('superseded'),
    supersededByWaiverId: WaiverIdSchema,
    reason: NonEmptyTextSchema,
  })
  .strict()
  .readonly();

/**
 * Append-only waiver lifecycle facts. Every arm freezes the actor and resolved
 * authorization snapshot used for that operation; replay never consults
 * current identity or capability state.
 */
export const WaiverProvenanceV1Schema = z.discriminatedUnion('event', [
  IssuedWaiverProvenanceV1Schema,
  RevokedWaiverProvenanceV1Schema,
  SupersededWaiverProvenanceV1Schema,
]);
export type WaiverProvenanceV1 = z.infer<typeof WaiverProvenanceV1Schema>;
