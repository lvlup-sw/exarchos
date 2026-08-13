/**
 * P06-04 — Trusted issuer authority unit tests.
 *
 * The authority answers "may THIS principal issue THIS kind of artifact?" from
 * an out-of-band directory only. A record cannot self-assert its way past it:
 * an unknown principal, or a known principal lacking the specific capability, is
 * unauthorized. Capabilities do not cross kinds.
 */
import { describe, expect, it } from 'vitest';
import {
  createCapabilityAuthority,
  DENY_ALL_AUTHORITY,
  POLICY_CAPABILITY,
} from './policy-authority.js';
import type {
  AttributedPrincipalV1,
  AuthorizationSnapshotV1,
  EvidenceProducerV1,
} from './types.js';

const producer = (producerId: string): EvidenceProducerV1 =>
  ({
    producerId,
    providerRef: 'provider.static-analysis',
    providerVersion: '1.0',
    invocationId: 'inv-1',
  }) as EvidenceProducerV1;

const principal = (principalId: string): AttributedPrincipalV1 =>
  ({ principalKind: 'operator', principalId, role: 'whatever' }) as AttributedPrincipalV1;

const authorization = (): AuthorizationSnapshotV1 =>
  ({
    authorizationId: 'authz-1',
    posture: 'shared-mutating',
    capabilityIds: ['capability.issue-waiver'],
    resolverVersion: '1.0',
    resolvedAt: '2026-07-21T20:00:00.000Z',
  }) as AuthorizationSnapshotV1;

describe('createCapabilityAuthority', () => {
  const authority = createCapabilityAuthority([
    { principalId: 'p.gate', capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
    { principalId: 'p.approve', capabilities: [POLICY_CAPABILITY.ISSUE_APPROVAL] },
    { principalId: 'p.waive', capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
  ]);

  it('Authority_GrantedGateProducer_IsAuthorized', () => {
    expect(authority.authorizesGateEvidence(producer('p.gate'))).toBe(true);
  });

  it('Authority_UnknownProducer_IsUnauthorized', () => {
    expect(authority.authorizesGateEvidence(producer('p.unknown'))).toBe(false);
  });

  it('Authority_CapabilitiesDoNotCrossKinds', () => {
    // The gate producer cannot approve or waive; the approver cannot issue gates.
    expect(authority.authorizesApproval(principal('p.gate'))).toBe(false);
    expect(authority.authorizesWaiver(principal('p.gate'), authorization())).toBe(false);
    expect(authority.authorizesGateEvidence(producer('p.approve'))).toBe(false);
  });

  it('Authority_GrantedApprover_IsAuthorized', () => {
    expect(authority.authorizesApproval(principal('p.approve'))).toBe(true);
  });

  it('Authority_GrantedWaiverGrantor_IsAuthorized', () => {
    expect(authority.authorizesWaiver(principal('p.waive'), authorization())).toBe(true);
  });

  it('Authority_MergesRepeatedGrantsForSamePrincipal', () => {
    const merged = createCapabilityAuthority([
      { principalId: 'p.multi', capabilities: [POLICY_CAPABILITY.ISSUE_GATE_EVIDENCE] },
      { principalId: 'p.multi', capabilities: [POLICY_CAPABILITY.GRANT_WAIVER] },
    ]);
    expect(merged.authorizesGateEvidence(producer('p.multi'))).toBe(true);
    expect(merged.authorizesWaiver(principal('p.multi'), authorization())).toBe(true);
  });

  it('Authority_IgnoresSelfAssertedAuthorizationSnapshot', () => {
    // The snapshot claims a waiver capability, but the principal is not in the
    // trusted directory: the record cannot authorize itself.
    const empty = createCapabilityAuthority([]);
    expect(empty.authorizesWaiver(principal('p.waive'), authorization())).toBe(false);
  });
});

describe('DENY_ALL_AUTHORITY', () => {
  it('Authority_DenyAll_RejectsEveryIssuer', () => {
    expect(DENY_ALL_AUTHORITY.authorizesGateEvidence(producer('p.gate'))).toBe(false);
    expect(DENY_ALL_AUTHORITY.authorizesApproval(principal('p.approve'))).toBe(false);
    expect(DENY_ALL_AUTHORITY.authorizesWaiver(principal('p.waive'), authorization())).toBe(false);
  });
});
