import { describe, it, expect } from 'vitest';
import { deriveMetaModel } from '../../../../src/contract/compiler/meta-model.js';
import { compile } from '../../../../src/contract/compiler/compile.js';
import type { AuthorityVerdict } from '../../../../src/contract/authority-pin.js';
import { buildProofFixtures, serializeProofFixtures } from '../../../../src/contract/compiler/fixtures.js';
import { buildSchemaBundle, compileDescriptor } from '../../../../src/contract/compiler/descriptors.js';

const okVerdict: AuthorityVerdict = { ok: true, violations: [], report: 'ok (stub)' };
const OK = { verifyAuthority: () => okVerdict } as const;

describe('proof fixtures', () => {
  it('AreByteStableAndSortedByActionId', () => {
    const entries = deriveMetaModel().actions;
    const descriptors = entries.map(compileDescriptor);
    const schemas = buildSchemaBundle(entries);
    const a = buildProofFixtures('1.0.0', descriptors, schemas, 'sha256:root', {
      ok: true,
      authorityIds: ['contract-surface', 'mcp-sdk'],
    });
    const b = buildProofFixtures('1.0.0', descriptors, schemas, 'sha256:root', {
      ok: true,
      authorityIds: ['mcp-sdk', 'contract-surface'],
    });
    // Authority ids sorted → order of input is irrelevant.
    expect(serializeProofFixtures(a)).toBe(serializeProofFixtures(b));
    const ids = a.actions.map((x) => x.actionId);
    expect(ids).toEqual([...ids].sort());
  });

  it('CarryDistinctPerActionDigestsThatDownstreamCanVerify', () => {
    const r = compile(deriveMetaModel(), OK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const fx = r.output.proofFixtures;
      for (const a of fx.actions) {
        expect(a.descriptorDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(a.inputSchemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(a.outputSchemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(a.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
      // Descriptor digests are unique per action (no accidental collapse).
      const digests = fx.actions.map((a) => a.descriptorDigest);
      expect(new Set(digests).size).toBe(digests.length);
    }
  });

  it('BindTheAuthoritySnapshotThatGatedGeneration', () => {
    const r = compile(deriveMetaModel(), OK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.proofFixtures.authority.ok).toBe(true);
      expect(r.output.proofFixtures.authority.authorityIds).toContain('contract-surface');
    }
  });
});
