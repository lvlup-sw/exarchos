/**
 * Trusted issuer authority for policy evaluation.
 *
 * A record never authorizes itself. Evidence and waiver records describe their own
 * producer, actor, and role, but the evaluator does not trust those fields.
 * It asks a `PolicyAuthority` that the trusted dispatch context supplies.
 * An issuer that the authority does not know, or that lacks the capability, is
 * unauthorized, and unauthorized evidence denies. The module is pure.
 */
import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  EvidenceProducerV1,
} from './types.js';

/**
 * The capability names that a trusted resolver grants to a principal.
 * They are not branded {@link import('./types.js').CapabilityId} values, because
 * the directory is external trust data and not a record field.
 */
export const POLICY_CAPABILITY = {
  /** Permits a principal to issue gate evidence. */
  ISSUE_GATE_EVIDENCE: 'admission:issue-gate-evidence',
  /** Permits a principal to issue approval evidence. */
  ISSUE_APPROVAL: 'admission:issue-approval',
  /** Permits a principal to grant (author) a waiver. */
  GRANT_WAIVER: 'admission:grant-waiver',
} as const;

export type PolicyCapabilityName =
  (typeof POLICY_CAPABILITY)[keyof typeof POLICY_CAPABILITY];

/**
 * The trust oracle for policy evaluation. Each method tells if a principal can
 * issue one kind of artifact. Implementations must ignore the role or capability
 * that a record asserts about itself.
 */
export interface PolicyAuthority {
  /** Whether the gate-evidence producer is trusted to issue gate evidence. */
  authorizesGateEvidence(producer: EvidenceProducerV1): boolean;
  /** Whether the approving principal is trusted to issue approval evidence. */
  authorizesApproval(principal: AttributedPrincipalV1): boolean;
  /**
   * Whether the waiver actor is trusted to grant a waiver. The authorization
   * snapshot is audit provenance only. The decision comes from the directory.
   */
  authorizesWaiver(
    actor: AttributedPrincipalV1,
    authorization: AuthorizationSnapshotV1,
  ): boolean;
}

/** One principal's out-of-band capability grant. */
export interface PrincipalCapabilityGrant {
  readonly principalId: string;
  readonly capabilities: readonly string[];
}

/**
 * Build a frozen {@link PolicyAuthority} from a capability grant table. Grants for
 * one principal merge. A principal that is not in the table holds no capabilities.
 */
export function createCapabilityAuthority(
  grants: readonly PrincipalCapabilityGrant[],
): PolicyAuthority {
  const directory = new Map<string, Set<string>>();
  for (const grant of grants) {
    const existing = directory.get(grant.principalId) ?? new Set<string>();
    for (const capability of grant.capabilities) existing.add(capability);
    directory.set(grant.principalId, existing);
  }

  const holds = (principalId: string, capability: string): boolean =>
    directory.get(principalId)?.has(capability) ?? false;

  return Object.freeze({
    authorizesGateEvidence: (producer: EvidenceProducerV1): boolean =>
      holds(producer.producerId, POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE),
    authorizesApproval: (principal: AttributedPrincipalV1): boolean =>
      holds(principal.principalId, POLICY_CAPABILITY.ISSUE_APPROVAL),
    authorizesWaiver: (actor: AttributedPrincipalV1): boolean =>
      holds(actor.principalId, POLICY_CAPABILITY.GRANT_WAIVER),
  });
}

/** An authority that trusts no issuer, for use as a fail-closed default. */
export const DENY_ALL_AUTHORITY: PolicyAuthority = Object.freeze({
  authorizesGateEvidence: (): boolean => false,
  authorizesApproval: (): boolean => false,
  authorizesWaiver: (): boolean => false,
});
