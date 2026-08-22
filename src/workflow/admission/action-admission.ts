import { createHash } from 'node:crypto';
import {
  normalizeEvidenceSubjectContent,
  type NormalizedEvidenceSubjectContent,
} from './evidence-subject.js';
import { evaluateAuthoredRequirements } from './policy-evaluation.js';
import { POLICY_CAPABILITY } from './policy-authority.js';
import {
  authoredActionRequirements,
  resolveActionIdRequirements,
  type ActionIdRequires,
} from './requirement-resolution.js';
import {
  ADMISSION_RUNTIME_CONTRACT_VERSION,
  ActionAdmissionActionIdSchema,
  ActionAdmissionHsmFactsV1Schema,
  ActionAdmissionSnapshotV1Schema,
  ActionAdmissionSubjectV1Schema,
  AdmissionEvidenceV1Schema,
  AuthorizationSnapshotV1Schema,
  isActionAdmissionSnapshotV1,
  type ActionAdmissionHsmFactsV1,
  type ActionAdmissionSnapshotV1,
  type ActionAdmissionSubjectV1,
  type AdmissionEvidenceV1,
  type AuthorizationSnapshotV1,
  type ContentDigestV1,
} from './types.js';

export type ActionAdmissionSnapshotErrorCode =
  | 'MISSING_TRUSTED_INPUT'
  | 'MALFORMED_SNAPSHOT';

/** Fail-closed boundary error for the snapshot constructor. */
export class ActionAdmissionSnapshotError extends Error {
  constructor(
    readonly code: ActionAdmissionSnapshotErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ActionAdmissionSnapshotError';
  }
}

const TRUSTED_INPUT_KEYS = [
  'actionId',
  'subject',
  'evidence',
  'authorization',
  'hsmFacts',
] as const;

type TrustedInputKey = (typeof TRUSTED_INPUT_KEYS)[number];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lift only constructor-owned fields. Caller `_meta`, request payload (including
 * transition `target`), and wall-clock values cannot supply or replace them.
 */
function extractTrustedFields(input: unknown): Record<TrustedInputKey, unknown> {
  if (!isPlainRecord(input)) {
    throw new ActionAdmissionSnapshotError(
      'MISSING_TRUSTED_INPUT',
      'action admission snapshot input must be an object',
    );
  }

  return {
    actionId: input.actionId,
    subject: input.subject,
    evidence: input.evidence,
    authorization: input.authorization,
    hsmFacts: input.hsmFacts,
  };
}

function requirePresent(value: unknown, field: TrustedInputKey): unknown {
  if (value === undefined) {
    throw new ActionAdmissionSnapshotError(
      'MISSING_TRUSTED_INPUT',
      `${field} is required and cannot be supplied by caller _meta`,
    );
  }
  return value;
}

function parseTrustedField<T>(
  field: TrustedInputKey,
  value: unknown,
  parse: (input: unknown) => T,
): T {
  try {
    return parse(requirePresent(value, field));
  } catch (error) {
    if (error instanceof ActionAdmissionSnapshotError) throw error;
    throw new ActionAdmissionSnapshotError(
      'MALFORMED_SNAPSHOT',
      `${field} is malformed`,
      { cause: error },
    );
  }
}

function parseEvidenceList(value: unknown): readonly AdmissionEvidenceV1[] {
  if (!Array.isArray(value)) {
    throw new ActionAdmissionSnapshotError(
      'MALFORMED_SNAPSHOT',
      'evidence must be an array of persisted evidence records',
    );
  }
  return value.map((item, index) => {
    const parsed = AdmissionEvidenceV1Schema.safeParse(item);
    if (!parsed.success) {
      throw new ActionAdmissionSnapshotError(
        'MALFORMED_SNAPSHOT',
        `evidence[${index}] is malformed`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  });
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalizeEvidence(
  evidence: readonly AdmissionEvidenceV1[],
): readonly AdmissionEvidenceV1[] {
  return [...evidence].sort((left, right) =>
    compareStrings(left.evidenceId, right.evidenceId),
  );
}

function canonicalizeAuthorization(
  authorization: AuthorizationSnapshotV1,
): AuthorizationSnapshotV1 {
  return {
    authorizationId: authorization.authorizationId,
    posture: authorization.posture,
    capabilityIds: [...authorization.capabilityIds].sort(compareStrings),
    resolverVersion: authorization.resolverVersion,
    resolvedAt: authorization.resolvedAt,
  };
}

function canonicalizeSubject(
  subject: ActionAdmissionSubjectV1,
): ActionAdmissionSubjectV1 {
  return {
    featureId: subject.featureId,
    stream: subject.stream,
  };
}

function canonicalizeHsmFacts(
  hsmFacts: ActionAdmissionHsmFactsV1,
): ActionAdmissionHsmFactsV1 {
  return hsmFacts.phaseAttemptId === undefined
    ? { phase: hsmFacts.phase }
    : { phase: hsmFacts.phase, phaseAttemptId: hsmFacts.phaseAttemptId };
}

function serializeCanonicalJson(value: NormalizedEvidenceSubjectContent): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .map(
      ([key, child]) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(child)}`,
    )
    .join(',')}}`;
}

function digestTrustedInputs(input: {
  readonly actionId: string;
  readonly subject: ActionAdmissionSubjectV1;
  readonly evidence: readonly AdmissionEvidenceV1[];
  readonly authorization: AuthorizationSnapshotV1;
  readonly hsmFacts: ActionAdmissionHsmFactsV1;
}): ContentDigestV1 {
  const canonical = normalizeEvidenceSubjectContent({
    actionId: input.actionId,
    subject: input.subject,
    evidence: input.evidence,
    authorization: input.authorization,
    hsmFacts: input.hsmFacts,
  });
  const value = createHash('sha256')
    .update(serializeCanonicalJson(canonical), 'utf8')
    .digest('hex');
  return { algorithm: 'sha256', value };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

/**
 * Construct an immutable workflow-scoped ActionId admission snapshot.
 *
 * Only ActionId, feature/stream subject, persisted evidence, authorization,
 * and HSM facts are trusted. Caller `_meta`, request payload, and wall-clock
 * values are ignored. Equivalent trusted inputs share one digest regardless
 * of key or list order.
 */
export function createActionAdmissionSnapshot(
  input: unknown,
): ActionAdmissionSnapshotV1 {
  const trusted = extractTrustedFields(input);
  const actionId = parseTrustedField('actionId', trusted.actionId, (value) =>
    ActionAdmissionActionIdSchema.parse(value),
  );
  const subject = parseTrustedField('subject', trusted.subject, (value) =>
    ActionAdmissionSubjectV1Schema.parse(value),
  );
  const evidence = parseTrustedField('evidence', trusted.evidence, parseEvidenceList);
  const authorization = parseTrustedField(
    'authorization',
    trusted.authorization,
    (value) => AuthorizationSnapshotV1Schema.parse(value),
  );
  const hsmFacts = parseTrustedField('hsmFacts', trusted.hsmFacts, (value) =>
    ActionAdmissionHsmFactsV1Schema.parse(value),
  );

  const canonicalSubject = canonicalizeSubject(subject);
  const canonicalEvidence = canonicalizeEvidence(evidence);
  const canonicalAuthorization = canonicalizeAuthorization(authorization);
  const canonicalHsmFacts = canonicalizeHsmFacts(hsmFacts);
  const digest = digestTrustedInputs({
    actionId,
    subject: canonicalSubject,
    evidence: canonicalEvidence,
    authorization: canonicalAuthorization,
    hsmFacts: canonicalHsmFacts,
  });

  const snapshot = ActionAdmissionSnapshotV1Schema.parse({
    contractVersion: ADMISSION_RUNTIME_CONTRACT_VERSION,
    actionId,
    subject: canonicalSubject,
    evidence: canonicalEvidence,
    authorization: canonicalAuthorization,
    hsmFacts: canonicalHsmFacts,
    digest,
  });
  return deepFreeze(snapshot);
}

export type ActionAdmissionVerdict = 'allow' | 'deny' | 'indeterminate';

export interface ActionAdmissionDecision {
  readonly verdict: ActionAdmissionVerdict;
  readonly digest: ContentDigestV1;
}

/** Snapshot-resident freshness window; wall-clock is not an evaluator input. */
export const ACTION_ADMISSION_FRESHNESS_HORIZON_MS = 60 * 60 * 1000;

function digestText(value: string): ContentDigestV1 {
  return {
    algorithm: 'sha256',
    value: createHash('sha256').update(value, 'utf8').digest('hex'),
  };
}

function decision(
  verdict: ActionAdmissionVerdict,
  digest: ContentDigestV1,
): ActionAdmissionDecision {
  return deepFreeze({ verdict, digest });
}

function resolveEvaluationSnapshot(
  snapshot: unknown,
): ActionAdmissionSnapshotV1 | undefined {
  if (isActionAdmissionSnapshotV1(snapshot)) return snapshot;
  try {
    return createActionAdmissionSnapshot(snapshot);
  } catch {
    return undefined;
  }
}

interface ActionAdmissionNeeds {
  readonly kind: 'none' | 'declared';
  readonly values?: readonly string[];
}

interface ActionAdmissionContract {
  readonly requires: ActionIdRequires;
  readonly needs: ActionAdmissionNeeds;
  readonly executionAuthority: { readonly kind: string };
}

function isActionIdRequires(value: unknown): value is ActionIdRequires {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'none') {
    return typeof value.because === 'string' && value.because.trim().length > 0;
  }
  return value.kind === 'declared' && Array.isArray(value.values);
}

function isActionAdmissionContract(value: unknown): value is ActionAdmissionContract {
  if (!isPlainRecord(value)) return false;
  const needs = value.needs;
  const executionAuthority = value.executionAuthority;
  return (
    isActionIdRequires(value.requires) &&
    isPlainRecord(needs) &&
    (needs.kind === 'none' || needs.kind === 'declared') &&
    isPlainRecord(executionAuthority) &&
    typeof executionAuthority.kind === 'string'
  );
}

function capabilitiesSatisfied(
  needs: ActionAdmissionNeeds,
  authorization: AuthorizationSnapshotV1,
): boolean {
  if (needs.kind === 'none') return true;
  const required = needs.values ?? [];
  if (required.length === 0) return false;
  const held = new Set(authorization.capabilityIds.map((id) => String(id)));
  return required.every((capability) => held.has(capability));
}

function snapshotAuthorizesEvidence(
  evidence: AdmissionEvidenceV1,
  authorization: AuthorizationSnapshotV1,
): boolean {
  const required =
    evidence.kind === 'gate'
      ? POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE
      : POLICY_CAPABILITY.ISSUE_APPROVAL;
  return authorization.capabilityIds.some((id) => String(id) === required);
}

/**
 * Evaluate registry ActionId admission against a frozen snapshot and contract.
 *
 * Order is fixed and total: known ActionId, then execution ownership /
 * capabilities, then ActionId-wide requires. Waivers are considered only when
 * the snapshot carries a phase attempt. Missing trusted inputs, capability
 * failure, unsatisfied requires, contradiction, and snapshot-resident stale or
 * unauthorized evidence never allow. The decision does not select a transition
 * target and does not replace the HSM transition guard — HSM edge conditions
 * remain a separate conjunct.
 */
export function evaluateActionAdmission(
  actionId: unknown,
  snapshot: unknown,
  contract: unknown,
): ActionAdmissionDecision {
  const parsedActionId = ActionAdmissionActionIdSchema.safeParse(actionId);
  if (!parsedActionId.success || !isActionAdmissionContract(contract)) {
    return decision(
      'indeterminate',
      digestText(`indeterminate:${String(actionId ?? '')}`),
    );
  }

  const resolved = resolveEvaluationSnapshot(snapshot);
  if (resolved === undefined) {
    return decision(
      'indeterminate',
      digestText(`indeterminate:${parsedActionId.data}`),
    );
  }

  if (resolved.actionId !== parsedActionId.data) {
    return decision('deny', resolved.digest);
  }

  if (!capabilitiesSatisfied(contract.needs, resolved.authorization)) {
    return decision('deny', resolved.digest);
  }

  const authored = authoredActionRequirements(contract.requires);
  if (authored.length === 0) {
    return decision('allow', resolved.digest);
  }

  const obligations = resolveActionIdRequirements(contract.requires);
  const requirements = evaluateAuthoredRequirements({
    requirements: authored,
    obligations,
    evidence: resolved.evidence,
    ...(resolved.hsmFacts.phaseAttemptId === undefined
      ? {}
      : { phaseAttemptId: resolved.hsmFacts.phaseAttemptId }),
    evaluatedAt: resolved.authorization.resolvedAt,
    freshnessHorizonMs: ACTION_ADMISSION_FRESHNESS_HORIZON_MS,
    authorizesEvidence: (evidence) =>
      snapshotAuthorizesEvidence(evidence, resolved.authorization),
  });

  return decision(requirements.verdict, resolved.digest);
}

export type { ActionAdmissionSnapshotV1 };
