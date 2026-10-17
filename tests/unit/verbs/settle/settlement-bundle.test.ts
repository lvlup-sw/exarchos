// The ledger record points at the bundle by digest. One document always gives
// one byte string. A document that the schema rejects never reaches custody.
// Bytes that round-trip give back the written document.
//
// @oracle-sources: ../../../../src/verbs/settle/settlement-bundle.ts, and the canonical-JSON encoder in contract/request-context which is authored for the request surface and not for this module

import { describe, it, expect } from 'vitest';

import { SETTLEMENT_OUTCOMES } from '../../../../src/verbs/settle/adjudicate.js';
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
  /** The digest is the reference. Two encodings that differ by key order give two artifacts for one document. */
  it('SettlementBundle_TheSameDocument_EncodesToTheSameBytes', () => {
    expect(encodeSettlementBundle(bundle())).toEqual(encodeSettlementBundle(bundle()));
  });

  /** The input has its top-level keys in a different insertion order. The canonical encoder must erase that difference. */
  it('SettlementBundle_KeyOrderInTheInput_DoesNotReachTheBytes', () => {
    const a = bundle();
    const reordered: SettlementBundleV1 = {
      ...bundle({ kind: SETTLEMENT_BUNDLE_KIND }),
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

  /** Nothing can follow a digest of an unreadable document, so the refusal must occur at encode time. */
  it('SettlementBundle_ADocumentTheSchemaRejects_NeverReachesCustody', () => {
    expect(() =>
      encodeSettlementBundle(bundle({ outcome: 'mostly-fine' } as unknown as Partial<SettlementBundleV1>)),
    ).toThrow();
    expect(() =>
      encodeSettlementBundle({ ...bundle(), smuggled: true } as unknown as SettlementBundleV1),
    ).toThrow();
  });

  /**
   * A bundle that an earlier build wrote carries one of these three names, and no verification
   * list and no decision list. The bytes are written here by hand, and each one still decodes.
   */
  it.each(['settled', 'rejected', 'deviation-pending'])(
    'SettlementBundle_AStoredBundleWithTheOutcome_%s_StillDecodes',
    (outcome) => {
      const stored = { ...bundle(), outcome };
      expect(stored).not.toHaveProperty('verification');
      expect(stored).not.toHaveProperty('decisions');
      const bytes = Buffer.from(`${JSON.stringify(stored)}\n`, 'utf8');
      expect(decodeSettlementBundle(bytes).outcome).toBe(outcome);
    },
  );

  /** The three names that this build adds. Each one encodes, and the bytes give the same document. */
  it.each(['recompile-required', 'corrective-capsule', 'accepted-with-rationale'] satisfies SettlementBundleV1['outcome'][])(
    'SettlementBundle_TheAddedOutcome_%s_RoundTrips',
    (outcome) => {
      const document = bundle({ outcome });
      expect(decodeSettlementBundle(encodeSettlementBundle(document))).toEqual(document);
    },
  );

  /** The enum of the bundle is the one outcome list, so the two cannot name different outcomes. */
  it('SettlementBundle_ItsOutcomeEnum_IsTheSharedOutcomeList', () => {
    expect(SETTLEMENT_OUTCOMES).toHaveLength(6);
    for (const outcome of SETTLEMENT_OUTCOMES) {
      expect(decodeSettlementBundle(encodeSettlementBundle(bundle({ outcome }))).outcome).toBe(outcome);
    }
    const unknown = Buffer.from(`${JSON.stringify({ ...bundle(), outcome: 'mostly-fine' })}\n`, 'utf8');
    expect(() => decodeSettlementBundle(unknown)).toThrow();
  });

  /** A reader that accepts a partial document reports facts that the producer did not write. */
  it('SettlementBundle_PartialBytes_AreRefusedRatherThanTolerated', () => {
    const { findings: _dropped, ...partial } = bundle();
    const bytes = Buffer.from(`${JSON.stringify(partial)}\n`, 'utf8');
    expect(() => decodeSettlementBundle(bytes)).toThrow();
  });

  /**
   * The id holds both halves of the settlement key, so a reader with a ledger record can name the bundle without resolving it.
   * A different batch or a different compilation gives a different id.
   */
  it('SettlementBundle_ArtifactId_NamesTheBatchAndTheCompilation', () => {
    const id = settlementBundleArtifactId('batch-0001', 3);
    expect(id).toContain('batch-0001');
    expect(id).toContain(SETTLEMENT_BUNDLE_KIND);
    expect(id.endsWith(':3')).toBe(true);
    expect(settlementBundleArtifactId('batch-0002', 3)).not.toBe(id);
    expect(settlementBundleArtifactId('batch-0001', 4)).not.toBe(id);
  });

  /** The artifact id comes from caller text, so the id grammar rejects a path or a shell fragment. */
  it('SettlementBundle_AnIdTheGrammarRefuses_Throws', () => {
    expect(() => settlementBundleArtifactId('../../etc/passwd', 1)).toThrow();
  });
});
