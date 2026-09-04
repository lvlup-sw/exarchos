// ─── The executor's run-bundle document ─────────────────────────────────────
//
// The bytes the run-bundle store hashes are a schema-validated, canonically
// encoded document. Two properties carry the custody story and are pinned here
// on their own, apart from the executor that produces them: encoding is
// deterministic (the same document is the same digest, whatever key order the
// producer happened to build it in), and decoding refuses what the schema does
// not admit (a reader cannot report a partial or foreign document as a run).

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

import { ArtifactIdSchema } from '../../../../src/workflow/admission/types.js';
import {
  decodeExecuteIntentBundle,
  encodeExecuteIntentBundle,
  executeIntentBundleArtifactId,
  EXECUTE_INTENT_BUNDLE_KIND,
  EXECUTE_INTENT_BUNDLE_VERSION,
  ExecuteIntentRunBundleV1Schema,
  type ExecuteIntentRunBundleV1,
} from '../../../../src/verbs/execute/run-bundle.js';
import { MAX_CALLER_OPERATION_ID_LENGTH } from '../../../../src/verbs/execute/executor.js';

function document(): ExecuteIntentRunBundleV1 {
  return {
    bundleVersion: EXECUTE_INTENT_BUNDLE_VERSION,
    kind: EXECUTE_INTENT_BUNDLE_KIND,
    operationId: 'op-doc',
    intent: 'fixture-intent',
    streamId: 'wf-bundle',
    requestDigest: `sha256:${'d'.repeat(64)}`,
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
        status: 'passed',
        events: [{ type: 'task.completed', streamId: 'wf-bundle', sequence: 3 }],
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:00.010Z',
        handlerInvoked: true,
        replayElided: false,
        handler: { success: true },
      },
      {
        index: 1,
        action: 'fixture_quiet',
        tool: 'exarchos_orchestrate',
        onFail: 'stop',
        observationStreamId: 'wf-bundle',
        args: { featureId: 'wf-bundle', taskId: 't1' },
        status: 'failed',
        events: [],
        failure: { code: 'INTENT_SEGMENT_FAILED', message: "leaf 'fixture_quiet' failed: refused" },
        startedAt: '2026-01-01T00:00:00.010Z',
        endedAt: '2026-01-01T00:00:00.020Z',
        handlerInvoked: true,
        replayElided: false,
        handler: { success: false, error: { code: 'FIXTURE_LEAF_REFUSED', message: 'refused' } },
      },
    ],
    interaction: { leavesExecuted: 2, eventsAppended: 1, requests: 1, deferred: ['suspensions'] },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('run-bundle document', () => {
  it('Encode_ThenDecode_RoundTripsTheDocument', () => {
    const bytes = encodeExecuteIntentBundle(document());
    expect(decodeExecuteIntentBundle(bytes)).toEqual(document());
  });

  it('Encode_IsCanonical_SoKeyOrderCannotChangeTheDigest', () => {
    // The same facts built in a different property order. A producer that
    // assembled its leaves' args from a map would do this; the digest the
    // ledger references must not depend on it.
    const reordered = JSON.parse(
      JSON.stringify(document(), (_key, value: unknown) => {
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
          const entries = Object.entries(value as Record<string, unknown>).reverse();
          return Object.fromEntries(entries);
        }
        return value;
      }),
    ) as ExecuteIntentRunBundleV1;
    expect(Object.keys(reordered)).not.toEqual(Object.keys(document()));

    const original = encodeExecuteIntentBundle(document());
    const encodedReordered = encodeExecuteIntentBundle(reordered);

    expect(sha256(encodedReordered)).toBe(sha256(original));
    // Arrays keep their order — a reversed leaf list IS a different run.
    const swapped = document();
    const [first, second] = swapped.leaves;
    expect(first !== undefined && second !== undefined).toBe(true);
    if (first === undefined || second === undefined) return;
    expect(
      sha256(encodeExecuteIntentBundle({ ...swapped, leaves: [second, first] })),
    ).not.toBe(sha256(original));
  });

  it('Encode_RefusesADocumentTheSchemaRejects_SoNoDigestNamesAnUnreadableBundle', () => {
    const extended = { ...document(), extra: 'not declared' } as unknown as ExecuteIntentRunBundleV1;
    expect(() => encodeExecuteIntentBundle(extended)).toThrow();

    const wrongKind = { ...document(), kind: 'something-else' } as unknown as ExecuteIntentRunBundleV1;
    expect(() => encodeExecuteIntentBundle(wrongKind)).toThrow();
  });

  it('Decode_RefusesForeignOrPartialBytes', () => {
    expect(() => decodeExecuteIntentBundle(Buffer.from('not json', 'utf8'))).toThrow();
    expect(() => decodeExecuteIntentBundle(Buffer.from('{"kind":"execute-intent-run"}', 'utf8'))).toThrow();
    // A leaf missing its timing is a partial trace, not a run.
    const partial = document();
    const [leaf] = partial.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const { startedAt: _dropped, ...withoutStart } = leaf;
    const bytes = Buffer.from(
      JSON.stringify({ ...partial, leaves: [withoutStart, ...partial.leaves.slice(1)] }),
      'utf8',
    );
    expect(() => decodeExecuteIntentBundle(bytes)).toThrow();
  });

  it('ArtifactId_IsDerivedFromTheOperationIdAndFitsTheGrammarAtTheBound', () => {
    const id = executeIntentBundleArtifactId('op-1');
    expect(id).toBe(`run-bundle:${EXECUTE_INTENT_BUNDLE_KIND}:op-1`);
    expect(ArtifactIdSchema.safeParse(id).success).toBe(true);

    // The longest operation id the executor accepts still yields a valid id:
    // the prefix must never push a legal caller key past the grammar.
    const longest = 'a'.repeat(MAX_CALLER_OPERATION_ID_LENGTH);
    expect(ArtifactIdSchema.safeParse(executeIntentBundleArtifactId(longest)).success).toBe(true);
  });

  it('Schema_IsStrictAtEveryLevel', () => {
    const doc = document();
    const [leaf] = doc.leaves;
    if (leaf === undefined) throw new Error('fixture has no leaf');
    const withStrayLeafField = { ...doc, leaves: [{ ...leaf, stray: true }] };
    expect(ExecuteIntentRunBundleV1Schema.safeParse(withStrayLeafField).success).toBe(false);
    const withStrayHandlerField = {
      ...doc,
      leaves: [{ ...leaf, handler: { success: true, stray: true } }],
    };
    expect(ExecuteIntentRunBundleV1Schema.safeParse(withStrayHandlerField).success).toBe(false);
  });
});
