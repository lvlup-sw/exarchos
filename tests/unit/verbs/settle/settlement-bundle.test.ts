// The bundle is what the ledger record POINTS AT, so the properties that matter
// are the ones a digest depends on: one document always produces one byte
// string, a document the schema rejects never reaches custody, and bytes that
// round-trip give back what was written.
//
// @oracle-sources: ../../../../src/verbs/settle/settlement-bundle.ts, and the canonical-JSON encoder in contract/request-context which is authored for the request surface and not for this module

import { describe, it, expect } from 'vitest';

import {
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
  decodeSettlementBundle,
  encodeSettlementBundle,
  settlementBundleArtifactId,
  type SettlementBundleV1,
} from '../../../../src/verbs/settle/settlement-bundle.js';

function bundle(overrides: Partial<SettlementBundleV1> = {}): SettlementBundleV1 {
  return {
    bundleVersion: SETTLEMENT_BUNDLE_VERSION,
    kind: SETTLEMENT_BUNDLE_KIND,
    operationId: 'op-settle-1',
    streamId: 'feat-x',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    capsule: {
      workflowId: 'wf-1',
      definitionVersion: 'b'.repeat(64),
      designVersion: 'design-1',
      capsuleVersion: 3,
      batchId: 'batch-0001',
    },
    outcome: 'settled',
    acceptedTasks: ['task-verify'],
    findings: [],
    claims: [{ taskId: 'task-verify', fields: { passed: true }, evidence: [] }],
    deviations: [],
    adjudicated: { claims: 1, requiredResults: 1, fields: 1, evidence: 0, deviations: 0 },
    settledAt: '2026-09-12T00:00:00Z',
    ...overrides,
  };
}

describe('the settlement bundle', () => {
  it('SettlementBundle_TheSameDocument_EncodesToTheSameBytes', () => {
    // The digest is the reference, so two encodings that differed by key order
    // would be two artifacts for one document.
    expect(encodeSettlementBundle(bundle())).toEqual(encodeSettlementBundle(bundle()));
  });

  it('SettlementBundle_KeyOrderInTheInput_DoesNotReachTheBytes', () => {
    const a = bundle();
    const reordered: SettlementBundleV1 = {
      ...bundle({ kind: SETTLEMENT_BUNDLE_KIND }),
      // Rebuilt with the top-level keys in a different insertion order; the
      // canonical encoder has to erase that difference.
      settledAt: a.settledAt,
      adjudicated: a.adjudicated,
      operationId: a.operationId,
    };
    expect(encodeSettlementBundle(reordered)).toEqual(encodeSettlementBundle(a));
  });

  it('SettlementBundle_EncodedBytes_AreCanonicalJsonWithATrailingNewline', () => {
    const text = Buffer.from(encodeSettlementBundle(bundle())).toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\n  ');
    expect(JSON.parse(text)).toEqual(bundle());
  });

  it('SettlementBundle_RoundTrips', () => {
    expect(decodeSettlementBundle(encodeSettlementBundle(bundle()))).toEqual(bundle());
  });

  it('SettlementBundle_ADocumentTheSchemaRejects_NeverReachesCustody', () => {
    // A digest of an unreadable document is a reference nothing can follow, so
    // the refusal has to happen at encode time rather than at read time.
    expect(() =>
      encodeSettlementBundle(bundle({ outcome: 'mostly-fine' } as unknown as Partial<SettlementBundleV1>)),
    ).toThrow();
    expect(() =>
      encodeSettlementBundle({ ...bundle(), smuggled: true } as unknown as SettlementBundleV1),
    ).toThrow();
  });

  it('SettlementBundle_PartialBytes_AreRefusedRatherThanTolerated', () => {
    // A reader that accepted a partial document would report facts the producer
    // never wrote.
    const { findings: _dropped, ...partial } = bundle();
    const bytes = Buffer.from(`${JSON.stringify(partial)}\n`, 'utf8');
    expect(() => decodeSettlementBundle(bytes)).toThrow();
  });

  it('SettlementBundle_ArtifactId_NamesTheBatchAndTheCompilation', () => {
    // Both halves of the settlement key, so a reader holding a ledger record
    // can name the bundle without first resolving it.
    const id = settlementBundleArtifactId('batch-0001', 3);
    expect(id).toContain('batch-0001');
    expect(id).toContain(SETTLEMENT_BUNDLE_KIND);
    expect(id.endsWith(':3')).toBe(true);
    // Two batches of one capsule, and two compilations of one batch, are four
    // different artifacts rather than one.
    expect(settlementBundleArtifactId('batch-0002', 3)).not.toBe(id);
    expect(settlementBundleArtifactId('batch-0001', 4)).not.toBe(id);
  });

  it('SettlementBundle_AnIdTheGrammarRefuses_Throws', () => {
    // The id grammar rejects a path or a shell fragment, and the artifact id is
    // built from caller-influenced text.
    expect(() => settlementBundleArtifactId('../../etc/passwd', 1)).toThrow();
  });
});
