// @oracle-sources: ../../../../src/verbs/execute/run-bundle.ts, the canonical byte string and its sha256 written out by hand in this file — the encoder is compared against those literals, never against its own output run twice
//
// Tests for the run-bundle document, apart from the executor that produces it.
// Encoding is deterministic and fixed: key order does not change the bytes, and the bytes match the literal written by hand below.
// Decoding refuses a document that the schema does not admit, so a reader cannot report a partial or foreign document as a run.

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

/** A small run, written as a literal, so the test does not build its input with the module under test. */
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
 * The canonical encoding of `DOCUMENT`, written by hand: keys sorted at every level, arrays in place, no whitespace, one trailing newline.
 * If the encoder changes its bytes, old bundles keep their digests and new bundles hash differently. Only this literal detects that drift.
 */
const EXPECTED_BYTES =
  '{"bundleVersion":"1.0","failedLeaf":"fixture_quiet","failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf \'fixture_quiet\' failed: refused"},"intent":"fixture-intent","interaction":{"deferred":["suspensions"],"eventsAppended":1,"leavesExecuted":2,"requests":1},"kind":"execute-intent-run","leaves":[{"action":"fixture_promises","args":{"featureId":"wf-bundle","nested":{"a":[3,2,1],"z":1},"taskId":"t1"},"disposition":{"handler":{"success":true},"kind":"invoked"},"endedAt":"2026-01-01T00:00:00.010Z","events":[{"sequence":3,"streamId":"wf-bundle","type":"task.completed"}],"index":0,"observationStreamId":"wf-bundle","onFail":"stop","startedAt":"2026-01-01T00:00:00.000Z","tool":"exarchos_orchestrate","verdict":{"status":"passed"}},{"action":"fixture_quiet","args":{"featureId":"wf-bundle","taskId":"t1"},"disposition":{"handler":{"error":{"code":"FIXTURE_LEAF_REFUSED","message":"refused"},"success":false},"kind":"invoked"},"endedAt":"2026-01-01T00:00:00.020Z","events":[],"index":1,"observationStreamId":"wf-bundle","onFail":"stop","startedAt":"2026-01-01T00:00:00.010Z","tool":"exarchos_orchestrate","verdict":{"failure":{"code":"INTENT_SEGMENT_FAILED","message":"leaf \'fixture_quiet\' failed: refused"},"status":"failed"}}],"operationId":"op-doc","outcome":"failed","requestDigest":"sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","steering":{"riskTier":"high","source":"caller-args"},"streamId":"wf-bundle","tailSequence":3}\n';

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('run-bundle document', () => {
  /** The expected digest comes from the literal, not from the encoder. */
  it('Encode_ProducesTheHandWrittenCanonicalBytes', () => {
    const bytes = encodeExecuteIntentBundle(DOCUMENT);
    expect(Buffer.from(bytes).toString('utf8')).toBe(EXPECTED_BYTES);
    expect(sha256(bytes)).toBe(sha256(Buffer.from(EXPECTED_BYTES, 'utf8')));
  });

  it('Decode_OfTheHandWrittenBytes_IsTheDocument', () => {
    expect(decodeExecuteIntentBundle(Buffer.from(EXPECTED_BYTES, 'utf8'))).toEqual(DOCUMENT);
  });

  /**
   * A producer that builds the leaf args from a map can change the key order, and the digest must not depend on it.
   * Arrays keep their order, because a reversed leaf list is a different run.
   */
  it('Encode_IsCanonical_SoKeyOrderCannotChangeTheDigest', () => {
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

  /** A leaf with no timing is a partial trace, not a run. */
  it('Decode_RefusesForeignOrPartialBytes', () => {
    expect(() => decodeExecuteIntentBundle(Buffer.from('not json', 'utf8'))).toThrow();
    expect(() => decodeExecuteIntentBundle(Buffer.from('{"kind":"execute-intent-run"}', 'utf8'))).toThrow();
    const [leaf] = DOCUMENT.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const { startedAt: _dropped, ...withoutStart } = leaf;
    const bytes = Buffer.from(
      JSON.stringify({ ...DOCUMENT, leaves: [withoutStart, ...DOCUMENT.leaves.slice(1)] }),
      'utf8',
    );
    expect(() => decodeExecuteIntentBundle(bytes)).toThrow();
  });

  /**
   * The schema rejects a handler verdict on a leaf whose handler did not run, and an invoked leaf with no verdict.
   * It rejects a verdict whose failure contradicts its status. It is strict at every level.
   */
  it('Schema_CannotHoldAContradictoryLeaf', () => {
    const [leaf] = DOCUMENT.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const rejects = (patch: Record<string, unknown>): boolean =>
      !ExecuteIntentRunBundleV1Schema.safeParse({ ...DOCUMENT, leaves: [{ ...leaf, ...patch }] }).success;

    expect(rejects({ disposition: { kind: 'replay-elided', handler: { success: true } } })).toBe(true);
    expect(rejects({ disposition: { kind: 'not-invoked', reason: 'admission-refused', handler: { success: true } } })).toBe(true);
    expect(rejects({ disposition: { kind: 'invoked' } })).toBe(true);
    expect(rejects({ verdict: { status: 'passed', failure: { code: 'X', message: 'y' } } })).toBe(true);
    expect(rejects({ verdict: { status: 'failed' } })).toBe(true);
    expect(rejects({ stray: true })).toBe(true);
    expect(rejects({ disposition: { kind: 'invoked', handler: { success: true, stray: true } } })).toBe(true);
  });

  /**
   * The executor does not own the error codes of third-party handlers.
   * A refusal of an empty code aborts the commit after every leaf effect lands, and again on each retry.
   */
  it('Schema_RecordsWhateverCodeAHandlerReturned', () => {
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

  /**
   * A bigint becomes text, a Date becomes its ISO string, and a function or `undefined` is dropped.
   * A structure that JSON cannot walk becomes a note. No argument can make the commit throw after the leaf effects land.
   */
  it('JsonSafeArgs_MakesEveryLeafArgumentEncodable', () => {
    const safe = jsonSafeArgs({
      big: 10n,
      fn: () => 1,
      gone: undefined,
      when: new Date('2026-01-01T00:00:00.000Z'),
      keep: { nested: [1, 'two'] },
    });
    expect(safe).toEqual({ big: '10n', when: '2026-01-01T00:00:00.000Z', keep: { nested: [1, 'two'] } });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const noted = jsonSafeArgs(cyclic);
    expect(Object.keys(noted)).toEqual(['unserialisable']);
    expect(typeof noted.unserialisable).toBe('string');
  });

  /** The longest operation id that the executor accepts still gives a valid artifact id. */
  it('ArtifactId_IsDerivedFromTheOperationIdAndFitsTheGrammarAtTheBound', () => {
    const id = executeIntentBundleArtifactId('op-1');
    expect(id).toBe(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:op-1`);
    expect(ArtifactIdSchema.safeParse(id).success).toBe(true);

    const longest = 'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH);
    expect(ArtifactIdSchema.safeParse(executeIntentBundleArtifactId(longest)).success).toBe(true);
    expect(EXECUTE_INTENT_BUNDLE_VERSION).toBe('1.0');
  });
});
