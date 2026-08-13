import { describe, it, expect } from 'vitest';
import {
  buildSourceIdentity,
  contractIdentityFromLock,
  CommitShaSchema,
  type RawSourceInputs,
} from './build-identity.js';
import { AUTHORITY_IDS, type AuthorityLock, type AuthorityPin } from '../../contract/authority-pin.js';

const COMMIT = 'a'.repeat(40);

function hex(seed: string): string {
  // deterministic 64-hex from a short seed (pad/truncate)
  return `sha256:${(seed.repeat(64)).slice(0, 64).replace(/[^0-9a-f]/g, '0')}`;
}

/** A well-formed, approved lock with all six frozen authorities. */
function makeLock(overrides: Partial<Record<string, Partial<AuthorityPin>>> = {}): AuthorityLock {
  const base: Record<string, AuthorityPin> = {
    'strategos-contracts': {
      kind: 'schema', version: '2.0.0', versionSpec: '2.0.0', digest: hex('a'), source: 's', approved: true,
    },
    'mcp-protocol': {
      kind: 'protocol', version: '2025-11-25', versionSpec: '2025-11-25', digest: null, source: 's', approved: true,
    },
    'mcp-sdk': {
      kind: 'package', version: '1.29.0', versionSpec: '1.29.0', digest: null, source: 's', approved: true,
    },
    'action-id-registry': {
      kind: 'registry', version: null, versionSpec: null, digest: hex('b'), source: 's', approved: true,
    },
    'compatibility-policy': {
      kind: 'policy', version: '1.0.0', versionSpec: '1.0.0', digest: hex('c'), source: 's', approved: true,
    },
    'invariant-catalog': {
      kind: 'catalog', version: '3', versionSpec: '3', digest: hex('d'), source: 's', approved: true,
    },
  };
  const authorities: Record<string, AuthorityPin> = {};
  for (const id of AUTHORITY_IDS) {
    authorities[id] = { ...base[id]!, ...(overrides[id] ?? {}) };
  }
  return { lockVersion: 1, approved: true, approvedBy: 'P03-01', authorities };
}

describe('buildSourceIdentity (P05-01 source provenance)', () => {
  it('SourceIdentity_IsDeterministic_And_OrderIndependent', () => {
    const a: RawSourceInputs = {
      commit: COMMIT,
      treeEntries: [
        { path: 'src/a.ts', content: 'export const a = 1;\n' },
        { path: 'src/b.ts', content: 'export const b = 2;\n' },
      ],
    };
    // same entries, reversed order → digestTree is order-independent
    const b: RawSourceInputs = {
      commit: COMMIT,
      treeEntries: [...a.treeEntries].reverse(),
    };
    expect(buildSourceIdentity(a).treeDigest).toBe(buildSourceIdentity(b).treeDigest);
  });

  it('SourceIdentity_NormalizesLineEndings_AcrossPlatforms', () => {
    const lf = buildSourceIdentity({
      commit: COMMIT,
      treeEntries: [{ path: 'a.ts', content: 'x\ny\n' }],
    });
    const crlf = buildSourceIdentity({
      commit: COMMIT,
      treeEntries: [{ path: 'a.ts', content: 'x\r\ny\r\n' }],
    });
    expect(lf.treeDigest).toBe(crlf.treeDigest);
  });

  it('SourceIdentity_DifferentContent_ProducesDifferentDigest', () => {
    const one = buildSourceIdentity({ commit: COMMIT, treeEntries: [{ path: 'a', content: '1' }] });
    const two = buildSourceIdentity({ commit: COMMIT, treeEntries: [{ path: 'a', content: '2' }] });
    expect(one.treeDigest).not.toBe(two.treeDigest);
  });

  it('SourceIdentity_RejectsNonFullCommitSha', () => {
    expect(() => buildSourceIdentity({ commit: 'abc123', treeEntries: [{ path: 'a', content: '1' }] })).toThrow();
    expect(() => CommitShaSchema.parse('uncommitted')).toThrow();
    expect(CommitShaSchema.parse(COMMIT)).toBe(COMMIT);
  });
});

describe('contractIdentityFromLock (P05-01 contract identity)', () => {
  it('ContractIdentity_IsDeterministic', () => {
    expect(contractIdentityFromLock(makeLock()).digest).toBe(
      contractIdentityFromLock(makeLock()).digest,
    );
  });

  it('ContractIdentity_FoldsEveryAuthority_AndCarriesProvenance', () => {
    const id = contractIdentityFromLock(makeLock());
    expect(id.authorityCount).toBe(AUTHORITY_IDS.length);
    expect(id.approvedBy).toBe('P03-01');
    expect(id.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ContractIdentity_ChangesWhenAnyAuthorityDigestChanges', () => {
    const base = contractIdentityFromLock(makeLock()).digest;
    const drifted = contractIdentityFromLock(
      makeLock({ 'compatibility-policy': { digest: hex('z') } }),
    ).digest;
    expect(drifted).not.toBe(base);
  });

  it('ContractIdentity_ChangesWhenAnAuthorityVersionChanges', () => {
    const base = contractIdentityFromLock(makeLock()).digest;
    const drifted = contractIdentityFromLock(
      makeLock({ 'mcp-sdk': { version: '1.30.0', versionSpec: '1.30.0' } }),
    ).digest;
    expect(drifted).not.toBe(base);
  });

  it('ContractIdentity_FailsClosed_WhenAuthorityMissing', () => {
    const lock = makeLock();
    // Drop a required authority — deriving an identity must throw, not silently truncate.
    const truncated: AuthorityLock = {
      ...lock,
      authorities: Object.fromEntries(
        Object.entries(lock.authorities).filter(([k]) => k !== 'invariant-catalog'),
      ),
    };
    expect(() => contractIdentityFromLock(truncated)).toThrow(/invariant-catalog/);
  });
});
