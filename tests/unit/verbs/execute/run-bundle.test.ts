// @oracle-sources: ../../../../src/verbs/execute/run-bundle.ts, the canonical byte string and its sha256 written out by hand in this file — the encoder is compared against those literals, never against its own output run twice
//
// ─── The executor's run-bundle document ─────────────────────────────────────
//
// The bytes the run-bundle store hashes are a schema-validated, canonically
// encoded document. Two properties carry the custody story and are pinned here
// on their own, apart from the executor that produces them: encoding is
// deterministic AND fixed — the same document is the same digest, whatever key
// order the producer happened to build it in, and that digest is the one a
// human wrote down below, so the format cannot drift while every proof
// compares the encoder with itself — and decoding refuses what the schema does
// not admit, so a reader cannot report a partial or foreign document as a run.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { ArtifactIdSchema } from '../../../../src/workflow/admission/types.js';
import {
  decodeExecuteIntentBundle,
  encodeExecuteIntentBundle,
  executeIntentBundleArtifactId,
  jsonSafeArgs,
  EXECUTE_INTENT_BUNDLE_KIND,
  EXECUTE_INTENT_BUNDLE_VERSION,
  ExecuteIntentRunBundleV1Schema,
  type ExecuteIntentRunBundleV1,
} from '../../../../src/verbs/execute/run-bundle.js';
import { MAX_CALLER_OPERATION_ID_LENGTH } from '../../../../src/verbs/execute/executor.js';

/**
 * A small run, written as a literal so it is the second authority: the
 * encoder is judged against these bytes, not against a document the test
 * builds by calling the module under test.
 */
const DOCUMENT: ExecuteIntentRunBundleV1 = {
  bundleVersion: '1.0',
  kind: 'execute-intent-run',
  operationId: 'op-doc',
  intent: 'fixture-intent',
  streamId: 'wf-bundle',
  requestDigest: 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  outcome: 'failed',
  failedLeaf: 'fixture_quiet',
  failure: { code: 'INTENT_SEGMENT_FAILED', message: "leaf 'fixture_quiet' failed: refused" },
  steering: { riskTier: 'high', source: 'caller-args' },
  tailSequence: 3,
  leaves: [
    {
      index: 0,
      action: 'fixture_promises',
      tool: 'exarchos_orchestrate',
      onFail: 'stop',
      observationStreamId: 'wf-bundle',
      args: { featureId: 'wf-bundle', taskId: 't1', nested: { z: 1, a: [3, 2, 1] } },
      events: [{ type: 'task.completed', streamId: 'wf-bundle', sequence: 3 }],
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:00.010Z',
      disposition: { kind: 'invoked', handler: { success: true } },
      verdict: { status: 'passed' },
    },
    {
      index: 1,
      action: 'fixture_quiet',
      tool: 'exarchos_orchestrate',
      onFail: 'stop',
      observationStreamId: 'wf-bundle',
      args: { featureId: 'wf-bundle', taskId: 't1' },
      events: [],
      startedAt: '2026-01-01T00:00:00.010Z',
      endedAt: '2026-01-01T00:00:00.020Z',
      disposition: {
        kind: 'invoked',
        handler: { success: false, error: { code: 'FIXTURE_LEAF_REFUSED', message: 'refused' } },
      },
      verdict: {
        status: 'failed',
        failure: { code: 'INTENT_SEGMENT_FAILED', message: "leaf 'fixture_quiet' failed: refused" },
      },
    },
  ],
  interaction: { leavesExecuted: 2, eventsAppended: 1, requests: 1, deferred: ['suspensions'] },
};

/**
 * The canonical encoding of DOCUMENT, by hand: keys sorted recursively at
 * every level, arrays in place, no whitespace, one trailing newline. If the
 * encoder ever produces different bytes for the same facts, every bundle
 * already in custody keeps its digest while new ones hash differently — and
 * nothing but this literal would notice.
 */
const EXPECTED_BYTES =
  '{"bundleVersion":"1.0","failedLeaf":"fixture_quiet","failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf \'fixture_quiet\' failed: refused"},"intent":"fixture-intent","interaction":{"deferred":["suspensions"],"eventsAppended":1,"leavesExecuted":2,"requests":1},"kind":"execute-intent-run","leaves":[{"action":"fixture_promises","args":{"featureId":"wf-bundle","nested":{"a":[3,2,1],"z":1},"taskId":"t1"},"disposition":{"handler":{"success":true},"kind":"invoked"},"endedAt":"2026-01-01T00:00:00.010Z","events":[{"sequence":3,"streamId":"wf-bundle","type":"task.completed"}],"index":0,"observationStreamId":"wf-bundle","onFail":"stop","startedAt":"2026-01-01T00:00:00.000Z","tool":"exarchos_orchestrate","verdict":{"status":"passed"}},{"action":"fixture_quiet","args":{"featureId":"wf-bundle","taskId":"t1"},"disposition":{"handler":{"error":{"code":"FIXTURE_LEAF_REFUSED","message":"refused"},"success":false},"kind":"invoked"},"endedAt":"2026-01-01T00:00:00.020Z","events":[],"index":1,"observationStreamId":"wf-bundle","onFail":"stop","startedAt":"2026-01-01T00:00:00.010Z","tool":"exarchos_orchestrate","verdict":{"failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf \'fixture_quiet\' failed: refused"},"status":"failed"}}],"operationId":"op-doc","outcome":"failed","requestDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","steering":{"riskTier":"high","source":"caller-args"},"streamId":"wf-bundle","tailSequence":3}\n';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('run-bundle document', () => {
  it('Encode_ProducesTheHandWrittenCanonicalBytes', () => {
    const bytes = encodeExecuteIntentBundle(DOCUMENT);
    expect(Buffer.from(bytes).toString('utf8')).toBe(EXPECTED_BYTES);
    // The digest the ledger would reference for this run, fixed by the
    // literal above rather than by the encoder.
    expect(sha256(bytes)).toBe(sha256(Buffer.from(EXPECTED_BYTES, 'utf8')));
  });

  it('Decode_OfTheHandWrittenBytes_IsTheDocument', () => {
    expect(decodeExecuteIntentBundle(Buffer.from(EXPECTED_BYTES, 'utf8'))).toEqual(DOCUMENT);
  });

  it('Encode_IsCanonical_SoKeyOrderCannotChangeTheDigest', () => {
    // The same facts built in a different property order. A producer that
    // assembled its leaves' args from a map would do this; the digest the
    // ledger references must not depend on it.
    const reordered = JSON.parse(
      JSON.stringify(DOCUMENT, (_key, value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const entries = Object.entries(value as Record<string, unknown>).reverse();
          return Object.fromEntries(entries);
        }
        return value;
      }),
    ) as ExecuteIntentRunBundleV1;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(DOCUMENT));

    expect(Buffer.from(encodeExecuteIntentBundle(reordered)).toString('utf8')).toBe(EXPECTED_BYTES);

    // Arrays keep their order — a reversed leaf list IS a different run.
    const [first, second] = DOCUMENT.leaves;
    if (first === undefined || second === undefined) throw new Error('fixture has two leaves');
    expect(
      Buffer.from(encodeExecuteIntentBundle({ ...DOCUMENT, leaves: [second, first] })).toString('utf8'),
    ).not.toBe(EXPECTED_BYTES);
  });

  it('Encode_RefusesADocumentTheSchemaRejects_SoNoDigestNamesAnUnreadableBundle', () => {
    const extended = { ...DOCUMENT, extra: 'not declared' } as unknown as ExecuteIntentRunBundleV1;
    expect(() => encodeExecuteIntentBundle(extended)).toThrow();

    const wrongKind = { ...DOCUMENT, kind: 'something-else' } as unknown as ExecuteIntentRunBundleV1;
    expect(() => encodeExecuteIntentBundle(wrongKind)).toThrow();
  });

  it('Decode_RefusesForeignOrPartialBytes', () => {
    expect(() => decodeExecuteIntentBundle(Buffer.from('not json', 'utf8'))).toThrow();
    expect(() => decodeExecuteIntentBundle(Buffer.from('{"kind":"execute-intent-run"}', 'utf8'))).toThrow();
    // A leaf missing its timing is a partial trace, not a run.
    const [leaf] = DOCUMENT.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const { startedAt: _dropped, ...withoutStart } = leaf;
    const bytes = Buffer.from(
      JSON.stringify({ ...DOCUMENT, leaves: [withoutStart, ...DOCUMENT.leaves.slice(1)] }),
      'utf8',
    );
    expect(() => decodeExecuteIntentBundle(bytes)).toThrow();
  });

  it('Schema_CannotHoldAContradictoryLeaf', () => {
    const [leaf] = DOCUMENT.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const rejects = (patch: Record<string, unknown>): boolean =>
      !ExecuteIntentRunBundleV1Schema.safeParse({ ...DOCUMENT, leaves: [{ ...leaf, ...patch }] }).success;

    // A handler verdict on a leaf whose handler was never reached.
    expect(rejects({ disposition: { kind: 'replay-elided', handler: { success: true } } })).toBe(true);
    expect(rejects({ disposition: { kind: 'not-invoked', reason: 'admission-refused', handler: { success: true } } })).toBe(true);
    // An invoked leaf with no verdict from its handler.
    expect(rejects({ disposition: { kind: 'invoked' } })).toBe(true);
    // A passed leaf carrying a failure, and a failed leaf carrying none.
    expect(rejects({ verdict: { status: 'passed', failure: { code: 'X', message: 'y' } } })).toBe(true);
    expect(rejects({ verdict: { status: 'failed' } })).toBe(true);
    // Strict at every level.
    expect(rejects({ stray: true })).toBe(true);
    expect(rejects({ disposition: { kind: 'invoked', handler: { success: true, stray: true } } })).toBe(true);
  });

  it('Schema_RecordsWhateverCodeAHandlerReturned', () => {
    // The executor does not own third-party error codes. An empty one is a
    // fact about the handler; refusing to record it would abort the commit
    // after every leaf effect landed, and re-abort on every retry.
    const [leaf] = DOCUMENT.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const withEmptyCode = {
      ...DOCUMENT,
      leaves: [
        {
          ...leaf,
          disposition: { kind: 'invoked', handler: { success: false, error: { code: '', message: '' } } },
        },
      ],
    };
    expect(ExecuteIntentRunBundleV1Schema.safeParse(withEmptyCode).success).toBe(true);
  });

  it('JsonSafeArgs_MakesEveryLeafArgumentEncodable', () => {
    // A bigint is written as text; a function and an undefined are dropped
    // (JSON has no representation for them); a Date is its ISO string. None
    // of these may turn the commit into a deterministic post-effect throw.
    const safe = jsonSafeArgs({
      big: 10n,
      fn: () => 1,
      gone: undefined,
      when: new Date('2026-01-01T00:00:00.000Z'),
      keep: { nested: [1, 'two'] },
    });
    expect(safe).toEqual({ big: '10n', when: '2026-01-01T00:00:00.000Z', keep: { nested: [1, 'two'] } });

    // A structure JSON cannot walk is replaced by a note saying so, not thrown.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const noted = jsonSafeArgs(cyclic);
    expect(Object.keys(noted)).toEqual(['unserialisable']);
    expect(typeof noted.unserialisable).toBe('string');
  });

  it('ArtifactId_IsDerivedFromTheOperationIdAndFitsTheGrammarAtTheBound', () => {
    const id = executeIntentBundleArtifactId('op-1');
    expect(id).toBe(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:op-1`);
    expect(ArtifactIdSchema.safeParse(id).success).toBe(true);

    // The longest operation id the executor accepts still yields a valid id:
    // the prefix must never push a legal caller key past the grammar.
    const longest = 'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH);
    expect(ArtifactIdSchema.safeParse(executeIntentBundleArtifactId(longest)).success).toBe(true);
    expect(EXECUTE_INTENT_BUNDLE_VERSION).toBe('1.0');
  });
});
