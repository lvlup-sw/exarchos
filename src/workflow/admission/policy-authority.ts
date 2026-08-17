// ─── P06-04 / Transition tasks 021, 022, 044 — Trusted issuer authority ──────
//
// Policy evaluation must never trust a record to authorize *itself*. Evidence
// and waiver records carry a self-described producer / actor / role, but under
// the P01-07 trusted-identity model callers cannot self-assert issuer, role, or
// capability. The authorization decision is therefore delegated to a
// `PolicyAuthority` supplied out-of-band by the trusted dispatch context — the
// evaluator consults it, it does NOT read trust off the record's own fields.
//
// A record whose issuing principal is unknown to the authority (or known but
// lacking the capability) is UNAUTHORIZED, and unauthorized evidence denies.
//
// Pure: no I/O, no clock, no config reads. `createCapabilityAuthority` builds a
// deterministic directory-backed authority from an explicit capability grant
// table (which, in production, the trusted resolver populates — never the
// caller of the transition).

import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  EvidenceProducerV1,
} from './types.js';

/**
 * The capabilities the policy layer checks issuers against. These are the
 * out-of-band capability names a trusted resolver grants to a principal; they
 * are deliberately NOT branded {@link import('./types.js').CapabilityId} values
 * because the directory is external trust data, not a record field.
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
 * The trust oracle consulted during policy evaluation. Every method answers a
 * single question — "may THIS principal issue THIS kind of artifact?" — using
 * trust the caller cannot forge. Implementations must ignore any role or
 * capability the record asserts about itself and answer solely from the
 * out-of-band trust they were constructed with.
 */
export interface PolicyAuthority {
  /** Whether the gate-evidence producer is trusted to issue gate evidence. */
  authorizesGateEvidence(producer: EvidenceProducerV1): boolean;
  /** Whether the approving principal is trusted to issue approval evidence. */
  authorizesApproval(principal: AttributedPrincipalV1): boolean;
  /**
   * Whether the waiver actor is trusted to grant a waiver. The frozen
   * authorization snapshot is provenance for audit; the trust decision comes
   * from the out-of-band directory, never from the snapshot the record carries.
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
 * Build a deterministic {@link PolicyAuthority} from an explicit capability
 * grant table. Grants for the same principal are merged. A principal absent
 * from the table holds no capabilities, so its evidence and waivers are
 * unauthorized. The returned authority is frozen and reads nothing but the
 * directory it closed over — a record cannot widen its own authorization.
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

/**
 * An authority that trusts no one — every issuer is unauthorized. Useful as a
 * fail-closed default and as the discriminating baseline for authorization
 * tests. Frozen and shareable.
 */
export const DENY_ALL_AUTHORITY: PolicyAuthority = Object.freeze({
  authorizesGateEvidence: (): boolean => false,
  authorizesApproval: (): boolean => false,
  authorizesWaiver: (): boolean => false,
});
