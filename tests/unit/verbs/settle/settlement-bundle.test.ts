// The ledger record points at the bundle by digest. One document always gives
// one byte string. A document that the schema rejects never reaches custody.
// Bytes that round-trip give back the written document.
//
// The claims of a bundle are the stored traces of the claim codec. The codec reads a request entry
// into one normal form, and that form goes to the bytes and comes back with no field lost.
//
// @oracle-sources: ../../../../src/verbs/settle/settlement-bundle.ts, and the canonical-JSON encoder in contract/request-context which is authored for the request surface and not for this module

import { describe, it, expect } from 'vitest';

import { canonicalJson } from '../../../../src/contract/request-context.js';
import {
  CLAIM_STATUSES,
  INCOMPLETE_CLAIM_STATUSES,
  SETTLEMENT_OUTCOMES,
  type SettlementClaim,
} from '../../../../src/verbs/settle/adjudicate.js';
import {
  ClaimTraceSchema,
  MAX_CLAIM_REASON_LENGTH,
  MAX_RATIONALE_ENTRIES_PER_CLAIM,
  MAX_RATIONALE_STATEMENT_LENGTH,
  claimOfRequest,
  claimOfTrace,
  claimTraceOf,
} from '../../../../src/verbs/settle/claim-codec.js';
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

/** A request entry of a completed claim with each part that such a claim can carry. */
function completedEntry(): Record<string, unknown> {
  return {
    taskId: 'task-verify',
    fields: { passed: true, worktreePath: '/work/task-verify', notes: { tries: 2, tags: ['a', 'b'] } },
    evidence: [
      { kind: 'test', ref: 'run-1' },
      { kind: 'typecheck', ref: 'run-2' },
    ],
    rationale: [
      { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' },
      { delegatedDecision: 'execution-order', statement: 'the two tasks ran in sequence' },
    ],
  };
}

/** A request entry of a claim that is not completed, with each part that such a claim can carry. */
function blockedEntry(): Record<string, unknown> {
  return { taskId: 'task-compile', status: 'blocked', reason: 'the schema migration is not merged' };
}

/** Reads a request entry that the codec must accept. */
function claimOf(entry: unknown): SettlementClaim {
  const claim = claimOfRequest(entry, 'claims[0]');
  if (typeof claim === 'string') throw new Error(`the codec refused the entry: ${claim}`);
  return claim;
}

/**
 * The claim codec. It reads a request entry into the one normal form of a claim. It gives the
 * stored trace of a claim, and the claim of a stored trace. The request reader, the bundle and
 * the decision round of the handler convert a claim only through these functions.
 */
describe('the claim codec', () => {
  /**
   * The two entries are the maximal claims: between them they set each key of the stored schema.
   * A key that the schema gains and neither entry sets fails the first assertion. Each claim then
   * goes to bundle bytes and comes back as the same claim, key for key.
   */
  it('ClaimCodec_AMaximalClaim_SurvivesTheRequestTheBundleBytesAndTheReadBack', () => {
    const claims = [claimOf(completedEntry()), claimOf(blockedEntry())];
    const keysSet = new Set(claims.flatMap((claim) => Object.keys(claim)));
    expect([...keysSet].sort()).toEqual(Object.keys(ClaimTraceSchema.shape).sort());

    const bytes = encodeSettlementBundle(bundle({ claims: claims.map(claimTraceOf) }));
    const readBack = decodeSettlementBundle(bytes).claims.map(claimOfTrace);
    expect(readBack).toStrictEqual(claims);
    expect(readBack).toStrictEqual([
      {
        taskId: 'task-verify',
        fields: { passed: true, worktreePath: '/work/task-verify', notes: { tries: 2, tags: ['a', 'b'] } },
        evidence: [
          { kind: 'test', ref: 'run-1' },
          { kind: 'typecheck', ref: 'run-2' },
        ],
        rationale: [
          { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' },
          { delegatedDecision: 'execution-order', statement: 'the two tasks ran in sequence' },
        ],
      },
      {
        taskId: 'task-compile',
        status: 'blocked',
        reason: 'the schema migration is not merged',
        fields: {},
        evidence: [],
      },
    ]);
  });

  /**
   * The status `completed` is the default, and the normal form does not hold it. A claim with the
   * status and a claim with no status are thus one claim. It has the keys and the canonical text
   * of a claim of the earlier build.
   */
  it('ClaimCodec_TheStatusCompleted_IsAbsentFromTheNormalForm', () => {
    const bare = claimOf({ taskId: 'task-verify', fields: { passed: true }, evidence: [] });
    const explicit = claimOf({ taskId: 'task-verify', status: 'completed', fields: { passed: true }, evidence: [] });
    expect(explicit).toStrictEqual(bare);
    expect(Object.keys(bare).sort()).toEqual(['evidence', 'fields', 'taskId']);
    expect(canonicalJson(claimTraceOf(explicit))).toBe('{"evidence":[],"fields":{"passed":true},"taskId":"task-verify"}');

    const defaults = claimOf({ taskId: 'task-verify' });
    expect(defaults).toStrictEqual({ taskId: 'task-verify', fields: {}, evidence: [] });
  });

  /** Each status that is not `completed` stays on the claim with its reason, and the stored trace holds both. */
  it.each([...INCOMPLETE_CLAIM_STATUSES])('ClaimCodec_TheStatus_%s_StaysOnTheClaimWithItsReason', (status) => {
    const claim = claimOf({ taskId: 'task-verify', status, reason: 'the reason' });
    expect(claim).toStrictEqual({ taskId: 'task-verify', status, reason: 'the reason', fields: {}, evidence: [] });
    expect(claimOfTrace(claimTraceOf(claim))).toStrictEqual(claim);
    expect(CLAIM_STATUSES).toEqual(['completed', ...INCOMPLETE_CLAIM_STATUSES]);
  });

  /** An empty field record, an empty evidence list and an empty rationale list carry nothing, so the entry is the same claim without them. */
  it('ClaimCodec_AClaimThatIsNotCompletedWithEmptyFieldsAndEvidence_IsTheSameClaim', () => {
    const spelled = claimOf({ ...blockedEntry(), fields: {}, evidence: [], rationale: [] });
    expect(spelled).toStrictEqual(claimOf(blockedEntry()));
  });

  /**
   * A claim that records no delegated choice holds no rationale. An absent list, an empty list and
   * a null are one claim. It has the keys and the canonical text of a claim of the earlier build.
   * Thus its request digest and its stored bytes do not move.
   */
  it('ClaimCodec_AClaimWithNoRationale_HasTheNormalFormOfTheEarlierBuild', () => {
    const bare = claimOf({ taskId: 'task-verify', fields: { passed: true }, evidence: [] });
    for (const rationale of [[], null, undefined]) {
      const spelled = claimOf({ taskId: 'task-verify', fields: { passed: true }, evidence: [], rationale });
      expect(spelled).toStrictEqual(bare);
      expect(spelled).not.toHaveProperty('rationale');
    }
    expect(canonicalJson(claimTraceOf(bare))).toBe('{"evidence":[],"fields":{"passed":true},"taskId":"task-verify"}');
  });

  /**
   * The rationale stays on a completed claim, also when the entry spells out the default status.
   * The entries keep the order of the request and the statement of the worker, and the stored trace holds both.
   * A key of an entry that the codec does not read does not reach the claim.
   */
  it('ClaimCodec_ARationaleOnACompletedClaim_KeepsItsEntriesInOrderWithTheirStatements', () => {
    const rationale = [
      { delegatedDecision: 'execution-order', statement: 'the two tasks ran in sequence' },
      { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' },
      { delegatedDecision: 'execution-order', statement: 'the second task ran last' },
    ];
    const claim = claimOf({ taskId: 'task-verify', status: 'completed', fields: { passed: true }, rationale });
    expect(claim).toStrictEqual({ taskId: 'task-verify', fields: { passed: true }, evidence: [], rationale });
    expect(claimOfTrace(claimTraceOf(claim))).toStrictEqual(claim);
    expect(canonicalJson(claimTraceOf(claim))).toContain('"statement":"a table drives the parser"');

    const extra = claimOf({ taskId: 'task-verify', rationale: [{ ...rationale[0], grants: 'a waiver' }] });
    expect(extra.rationale).toStrictEqual([rationale[0]]);
  });

  /**
   * The rules of a rationale. Each entry is refused with a reason that names its path, so the
   * request is invalid input. A claim records at most four choices, and a statement holds at most
   * 280 characters. A list of exactly four entries and a statement of exactly that length are read.
   */
  it('ClaimCodec_AnEntryThatBreaksARationaleRule_IsRefusedWithItsPath', () => {
    const choice = { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' };
    const tooLong = 'x'.repeat(MAX_RATIONALE_STATEMENT_LENGTH + 1);
    const refused: [Record<string, unknown>, string][] = [
      [{ rationale: choice }, 'claims[0].rationale must be an array of { delegatedDecision, statement }'],
      [{ rationale: 'a table drives the parser' }, 'claims[0].rationale must be an array of { delegatedDecision, statement }'],
      [
        { rationale: Array.from({ length: MAX_RATIONALE_ENTRIES_PER_CLAIM + 1 }, () => choice) },
        'claims[0].rationale holds 5 entries, and a claim records at most 4 delegated choices',
      ],
      [{ rationale: ['implementation-approach'] }, 'claims[0].rationale[0] must be an object'],
      [{ rationale: [choice, { statement: 's' }] }, 'claims[0].rationale[1].delegatedDecision is required'],
      [{ rationale: [{ ...choice, delegatedDecision: '' }] }, 'claims[0].rationale[0].delegatedDecision is required'],
      [{ rationale: [{ ...choice, delegatedDecision: 3 }] }, 'claims[0].rationale[0].delegatedDecision is required'],
      [
        { rationale: [{ ...choice, delegatedDecision: 'd'.repeat(257) }] },
        'claims[0].rationale[0].delegatedDecision holds 257 characters, and the id of a delegated decision holds at most 256',
      ],
      [
        { rationale: [{ delegatedDecision: 'execution-order' }] },
        'claims[0].rationale[0].statement must be text of 1 to 280 characters',
      ],
      [{ rationale: [{ ...choice, statement: '' }] }, 'claims[0].rationale[0].statement must be text of 1 to 280 characters'],
      [{ rationale: [{ ...choice, statement: 9 }] }, 'claims[0].rationale[0].statement must be text of 1 to 280 characters'],
      [
        { rationale: [choice, { ...choice, statement: tooLong }] },
        'claims[0].rationale[1].statement must be text of 1 to 280 characters',
      ],
      [
        { status: 'blocked', reason: 'r', rationale: [choice] },
        "claims[0] has the status 'blocked', so it carries no rationale",
      ],
      [
        { status: 'failed', reason: 'r', rationale: [choice] },
        "claims[0] has the status 'failed', so it carries no rationale",
      ],
      [
        { status: 'skipped', reason: 'r', rationale: [choice] },
        "claims[0] has the status 'skipped', so it carries no rationale",
      ],
    ];
    for (const [entry, reason] of refused) {
      const read = claimOfRequest({ taskId: 'task-verify', ...entry }, 'claims[0]');
      expect(typeof read, JSON.stringify(entry)).toBe('string');
      expect(read, JSON.stringify(entry)).toContain(reason);
    }

    expect(MAX_RATIONALE_ENTRIES_PER_CLAIM).toBe(4);
    expect(MAX_RATIONALE_STATEMENT_LENGTH).toBe(280);
    const longest = 'x'.repeat(MAX_RATIONALE_STATEMENT_LENGTH);
    const most = Array.from({ length: MAX_RATIONALE_ENTRIES_PER_CLAIM }, () => ({ ...choice, statement: longest }));
    expect(claimOf({ taskId: 'task-verify', rationale: most }).rationale).toStrictEqual(most);
    const longestId = [{ ...choice, delegatedDecision: 'd'.repeat(256) }];
    expect(claimOf({ taskId: 'task-verify', rationale: longestId }).rationale).toStrictEqual(longestId);
  });

  /**
   * The cross-field rules. Each entry is refused with a reason that names its path, so the request
   * is invalid input. The reason of a claim holds at most 280 characters, and a reason of exactly
   * that length is read.
   */
  it('ClaimCodec_AnEntryThatBreaksAStatusRule_IsRefusedWithItsPath', () => {
    const refused: [Record<string, unknown>, string][] = [
      [{ taskId: 'task-verify', status: 'done' }, "claims[0].status must be one of 'completed', 'failed', 'blocked', 'skipped'"],
      [{ taskId: 'task-verify', status: 7 }, 'claims[0].status must be one of'],
      [{ taskId: 'task-verify', status: 'blocked' }, "claims[0].reason is required with the status 'blocked'"],
      [{ taskId: 'task-verify', status: 'failed' }, "claims[0].reason is required with the status 'failed'"],
      [{ taskId: 'task-verify', status: 'skipped' }, "claims[0].reason is required with the status 'skipped'"],
      [{ taskId: 'task-verify', status: 'blocked', reason: '' }, 'claims[0].reason must be text of 1 to 280 characters'],
      [{ taskId: 'task-verify', status: 'blocked', reason: 9 }, 'claims[0].reason must be text of 1 to 280 characters'],
      [
        { taskId: 'task-verify', status: 'blocked', reason: 'x'.repeat(MAX_CLAIM_REASON_LENGTH + 1) },
        'claims[0].reason must be text of 1 to 280 characters',
      ],
      [{ taskId: 'task-verify', reason: 'it went well' }, 'claims[0].reason is given only with the status'],
      [{ taskId: 'task-verify', status: 'completed', reason: 'it went well' }, 'claims[0].reason is given only with the status'],
      [
        { taskId: 'task-verify', status: 'blocked', reason: 'r', fields: { passed: false } },
        "claims[0] has the status 'blocked', so it carries no fields and no evidence",
      ],
      [
        { taskId: 'task-verify', status: 'skipped', reason: 'r', evidence: [{ kind: 'test', ref: 'run-1' }] },
        "claims[0] has the status 'skipped', so it carries no fields and no evidence",
      ],
    ];
    for (const [entry, reason] of refused) {
      const read = claimOfRequest(entry, 'claims[0]');
      expect(typeof read, JSON.stringify(entry)).toBe('string');
      expect(read, JSON.stringify(entry)).toContain(reason);
    }
    expect(MAX_CLAIM_REASON_LENGTH).toBe(280);
    const longest = 'x'.repeat(MAX_CLAIM_REASON_LENGTH);
    expect(claimOf({ taskId: 'task-verify', status: 'blocked', reason: longest }).reason).toBe(longest);
  });

  /** The entries that were malformed before a claim had a status are refused with the same reasons. */
  it('ClaimCodec_AMalformedEntry_IsRefusedWithItsPath', () => {
    const refused: [unknown, string][] = [
      ['task-verify', 'claims[0] must be an object'],
      [{ fields: { passed: true } }, 'claims[0].taskId is required'],
      [{ taskId: 'task-verify', fields: [] }, 'claims[0].fields must be an object of returned result fields'],
      [{ taskId: 'task-verify', evidence: {} }, 'claims[0].evidence must be an array'],
      [{ taskId: 'task-verify', evidence: ['run-1'] }, 'claims[0].evidence[0] must be an object'],
      [{ taskId: 'task-verify', evidence: [{ kind: 'test' }] }, 'claims[0].evidence[0] requires both kind and ref'],
    ];
    for (const [entry, reason] of refused) {
      expect(claimOfRequest(entry, 'claims[0]'), JSON.stringify(entry)).toBe(reason);
    }
  });

  /**
   * The stored schema is strict. A claim with a field that the schema does not declare gives no
   * trace. Thus a field of the normal form cannot leave the bundle without a failure. A stored
   * trace with such a field does not decode.
   */
  it('ClaimCodec_AFieldTheStoredSchemaDoesNotDeclare_ThrowsAndIsNeverDropped', () => {
    const claim = claimOf(completedEntry());
    expect(() => claimTraceOf({ ...claim, ...{ smuggled: true } })).toThrow();
    const stored = { ...bundle(), claims: [{ taskId: 'task-verify', fields: {}, evidence: [], smuggled: true }] };
    expect(() => decodeSettlementBundle(Buffer.from(`${JSON.stringify(stored)}\n`, 'utf8'))).toThrow();
  });

  /**
   * A bundle that an earlier build wrote holds a claim with no status key, and it decodes to a
   * completed claim. A stored reason has no bound, so a long one decodes. A stored status outside
   * the three names does not, and neither does the default status, which the normal form never holds.
   */
  it('ClaimCodec_AStoredTrace_DecodesWithNoStatusAndWithAnUnboundedReason', () => {
    const decode = (claims: readonly unknown[]): SettlementClaim[] =>
      decodeSettlementBundle(Buffer.from(`${JSON.stringify({ ...bundle(), claims })}\n`, 'utf8')).claims.map(claimOfTrace);

    const earlier = { taskId: 'task-verify', fields: { passed: true }, evidence: [] };
    expect(decode([earlier])).toStrictEqual([earlier]);
    expect(decode([earlier])[0]).not.toHaveProperty('status');

    const long = { taskId: 'task-verify', status: 'failed', reason: 'x'.repeat(4 * MAX_CLAIM_REASON_LENGTH), fields: {}, evidence: [] };
    expect(decode([long])).toStrictEqual([long]);

    expect(() => decode([{ ...earlier, status: 'done' }])).toThrow();
    expect(() => decode([{ ...earlier, status: 'completed' }])).toThrow();
  });

  /**
   * The request bounds a rationale, and the stored schema does not. A stored claim with five
   * entries and a long statement decodes. The stored schema is strict for an entry too.
   * An entry with a key that it does not declare does not decode, and neither does an entry
   * with no statement. An empty list does not decode, because the normal form never holds one.
   */
  it('ClaimCodec_AStoredRationale_DecodesWithoutTheRequestBoundsAndRefusesAnUndeclaredKey', () => {
    const decode = (claims: readonly unknown[]): SettlementClaim[] =>
      decodeSettlementBundle(Buffer.from(`${JSON.stringify({ ...bundle(), claims })}\n`, 'utf8')).claims.map(claimOfTrace);
    const earlier = { taskId: 'task-verify', fields: { passed: true }, evidence: [] };
    const choice = { delegatedDecision: 'implementation-approach', statement: 'a table drives the parser' };

    const overTheBounds = {
      ...earlier,
      rationale: Array.from({ length: MAX_RATIONALE_ENTRIES_PER_CLAIM + 1 }, () => ({
        ...choice,
        statement: 'x'.repeat(4 * MAX_RATIONALE_STATEMENT_LENGTH),
      })),
    };
    expect(decode([overTheBounds])).toStrictEqual([overTheBounds]);

    expect(() => decode([{ ...earlier, rationale: [] }])).toThrow();
    expect(() => decode([{ ...earlier, rationale: [{ ...choice, grants: 'a waiver' }] }])).toThrow();
    expect(() => decode([{ ...earlier, rationale: [{ delegatedDecision: 'execution-order' }] }])).toThrow();
    expect(() => decode([{ ...earlier, rationale: [{ ...choice, delegatedDecision: '' }] }])).toThrow();
  });
});
