import { describe, it, expect } from 'vitest';
import {
  AUTHORITY_IDS,
  computeAuthorities,
  verifyAuthorities,
  buildAuthorityLock,
  AuthorityLockSchema,
  type AuthorityInputs,
  type AuthorityValue,
  type AuthorityLock,
} from '../../../src/contract/authority-pin.js';

// A fixed, exact-pinned input set the tests derive scenarios from.
function sampleInputs(overrides: Partial<AuthorityInputs> = {}): AuthorityInputs {
  return {
    strategosContractsVersion: '2.12.0-preview.3',
    strategosContractsSource: 'export const FooSchema = 1;\n',
    mcpProtocolVersion: '2025-11-25',
    mcpSdkVersionSpec: '1.29.0',
    actionIds: ['exarchos_workflow.init', 'exarchos_event.append'],
    compatibilityPolicyVersion: '1.0.0',
    compatibilityPolicySource: 'export function compareSemver() {}\n',
    invariantCatalogSchemaVersion: '3',
    invariantCatalogSource: 'schema-version: 3\n',
    contractSurfaceVersion: '1.0.0',
    contractSurfaceSource: '{"version":"1.0.0"}',
    ...overrides,
  };
}

describe('computeAuthorities', () => {
  it('Compute_ProducesEverySixthAuthority', () => {
    const live = computeAuthorities(sampleInputs());
    expect(live.map((a) => a.id).sort()).toEqual([...AUTHORITY_IDS].sort());
  });

  it('Compute_IsDeterministic', () => {
    expect(computeAuthorities(sampleInputs())).toEqual(computeAuthorities(sampleInputs()));
  });

  it('Compute_DigestsAreLineEndingIndependent', () => {
    const lf = computeAuthorities(sampleInputs({ strategosContractsSource: 'a\nb\n' }));
    const crlf = computeAuthorities(sampleInputs({ strategosContractsSource: 'a\r\nb\r\n' }));
    const byId = (l: AuthorityValue[], id: string) => l.find((a) => a.id === id)?.digest;
    expect(byId(crlf, 'strategos-contracts')).toBe(byId(lf, 'strategos-contracts'));
  });

  it('Compute_ActionIdDigestIsOrderIndependent', () => {
    const a = computeAuthorities(sampleInputs({ actionIds: ['a.x', 'b.y'] }));
    const b = computeAuthorities(sampleInputs({ actionIds: ['b.y', 'a.x'] }));
    const dig = (l: AuthorityValue[]) => l.find((x) => x.id === 'action-id-registry')?.digest;
    expect(dig(a)).toBe(dig(b));
  });
});

describe('buildAuthorityLock + schema', () => {
  it('BuildLock_ProducesSchemaValidApprovedLock', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    // Round-trips through the wire schema.
    expect(() => AuthorityLockSchema.parse(lock)).not.toThrow();
    expect(lock.approved).toBe(true);
    expect(Object.keys(lock.authorities).sort()).toEqual([...AUTHORITY_IDS].sort());
  });
});

describe('verifyAuthorities — happy path', () => {
  it('Verify_MatchingApprovedLockPasses', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const verdict = verifyAuthorities(live, lock);
    expect(verdict.ok).toBe(true);
    expect(verdict.violations).toEqual([]);
  });
});

describe('verifyAuthorities — fail-closed (exit proofs)', () => {
  it('Verify_FloatingAuthorityBlocks', () => {
    // A range-versioned MCP SDK dependency is a FLOATING authority.
    const live = computeAuthorities(sampleInputs({ mcpSdkVersionSpec: '^1.29.0' }));
    // Lock built from the same (floating) live set — the freeze must still block.
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const verdict = verifyAuthorities(live, lock);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'floating' && v.authority === 'mcp-sdk')).toBe(
      true,
    );
  });

  it('Verify_UnapprovedLockBlocks', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test', approved: false });
    const verdict = verifyAuthorities(live, lock);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'lock-unapproved')).toBe(true);
    expect(verdict.violations.some((v) => v.kind === 'unapproved')).toBe(true);
  });

  it('Verify_UnapprovedSinglePinBlocks', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    // Whole lock approved, but one pin flipped to unapproved.
    const tampered: AuthorityLock = {
      ...lock,
      authorities: {
        ...lock.authorities,
        'invariant-catalog': { ...lock.authorities['invariant-catalog']!, approved: false },
      },
    };
    const verdict = verifyAuthorities(live, tampered);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'unapproved' && v.authority === 'invariant-catalog'),
    ).toBe(true);
  });

  it('Verify_DigestMismatchBlocks', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const tampered: AuthorityLock = {
      ...lock,
      authorities: {
        ...lock.authorities,
        'strategos-contracts': {
          ...lock.authorities['strategos-contracts']!,
          digest: 'sha256:' + '0'.repeat(64),
        },
      },
    };
    const verdict = verifyAuthorities(live, tampered);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'mismatch' && v.authority === 'strategos-contracts'),
    ).toBe(true);
  });

  it('Verify_VersionMismatchBlocks', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const tampered: AuthorityLock = {
      ...lock,
      authorities: {
        ...lock.authorities,
        'mcp-protocol': { ...lock.authorities['mcp-protocol']!, version: '2024-11-05' },
      },
    };
    const verdict = verifyAuthorities(live, tampered);
    expect(verdict.ok).toBe(false);
    expect(
      verdict.violations.some((v) => v.kind === 'mismatch' && v.authority === 'mcp-protocol'),
    ).toBe(true);
  });

  it('Verify_MissingPinBlocks', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test' });
    const withoutOne: Record<string, (typeof lock.authorities)[string]> = { ...lock.authorities };
    delete withoutOne['mcp-sdk'];
    const tampered: AuthorityLock = { ...lock, authorities: withoutOne };
    const verdict = verifyAuthorities(live, tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.violations.some((v) => v.kind === 'missing' && v.authority === 'mcp-sdk')).toBe(
      true,
    );
  });

  it('Verify_ReportNamesViolations', () => {
    const live = computeAuthorities(sampleInputs());
    const lock = buildAuthorityLock(live, { approvedBy: 'test', approved: false });
    const verdict = verifyAuthorities(live, lock);
    expect(verdict.report).toContain('BLOCKED');
    expect(verdict.report).toContain('lock-unapproved');
  });
});
