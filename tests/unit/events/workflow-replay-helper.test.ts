/**
 * The test-only replay helper copies one stream and its bundles into a fresh store through the store appender.
 *
 * Each case appends rows to a source store by hand, copies the stream, and reads the rows, the claims and the bundles of the target.
 * A refusal comes before the first write, so the target then holds no row of the stream and no bundle.
 * Each case opens real SQLite stores in temp directories and sets its own timeout.
 *
 * @oracle-sources: the rows that the test appends to the source store by hand, the rows that the target store returns after the copy
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import type { EventInput } from '../../../src/events/atomic-appender.js';
import { extractBundleRefs, type BundleRefV1 } from '../../../src/events/bundle/digest-references.js';
import { RunBundleStore } from '../../../src/events/bundle/run-bundle-store.js';
import { INTERNAL_EXECUTION_LEDGER_EVENT_TYPES } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import {
  SETTLEMENT_BUNDLE_KIND,
  SETTLEMENT_BUNDLE_VERSION,
  encodeSettlementBundle,
} from '../../../src/verbs/settle/settlement-bundle.js';
import { ArtifactIdSchema } from '../../../src/workflow/admission/types.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { WorkflowReplayError, copyWorkflowStream } from '../../helpers/replay/workflow-replay.js';

/** Each case opens two or three SQLite stores, so it sets its own timeout. */
const CASE_TIMEOUT_MS = 15_000;

const STREAM = 'feat-replay-helper';

let scratch: string;
let source: EventStore;
let target: EventStore;

beforeEach(async () => {
  scratch = makeTempDir('workflow-replay-helper-');
  source = new EventStore(path.join(scratch, 'source'));
  await source.initialize();
  target = new EventStore(path.join(scratch, 'target'));
  await target.initialize();
});

afterEach(async () => {
  source.close();
  target.close();
  await rmrfAsync(scratch);
});

/** Each field of a row except its event id, which the appender of each store assigns. */
function withoutEventId(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) if (key !== 'eventId') fields[key] = value;
  return fields;
}

/** Appends rows to the source under one key, as one keyed batch. */
async function appendKeyed(rows: EventInput[], key: string): Promise<void> {
  const result = await source.getAppender().append(STREAM, rows, key);
  if (!result.ok) throw new Error(`the source refused the keyed rows: ${result.reason}`);
}

/** Appends rows to the source with no claim. A key field in a row stays in its payload. */
async function appendUnkeyed(rows: EventInput[]): Promise<void> {
  const result = await source.getAppender().appendUnkeyed(STREAM, rows);
  if (!result.ok) throw new Error(`the source refused the unkeyed rows: ${result.reason}`);
}

/** Puts bytes in the source bundle store and returns a reference to them. */
async function sourceBundle(name: string, text: string): Promise<BundleRefV1> {
  const digest = await source.bundleStore.put(Buffer.from(text, 'utf8'));
  return { artifactId: ArtifactIdSchema.parse(`run-bundle:${name}`), digest };
}

/** A row that names bundles in the reference field. */
function namingRow(type: string, refs: readonly BundleRefV1[]): EventInput {
  return { type, data: { bundleRefs: refs.map((ref) => ({ artifactId: ref.artifactId, digest: ref.digest })) } };
}

describe('copyWorkflowStream', () => {
  /** Each reserved ledger kind reaches the target through the appender, in its sequence. */
  it('CopyWorkflowStream_AStreamWithReservedRows_CopiesEachRowThroughTheAppender', async () => {
    await appendKeyed([{ type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } }], 'start');
    for (const [index, type] of INTERNAL_EXECUTION_LEDGER_EVENT_TYPES.entries()) {
      await appendKeyed([{ type, data: { index } }], `reserved-${type}`);
    }
    await appendUnkeyed([{ type: 'state.patched', data: { patch: { phase: 'delegate' } } }]);

    const copied = await copyWorkflowStream(source, target, STREAM);

    const original = await source.query(STREAM);
    const copy = await target.query(STREAM);
    expect(original.length).toBe(INTERNAL_EXECUTION_LEDGER_EVENT_TYPES.length + 2);
    expect(copied.rows.map((row) => row.sequence)).toEqual(original.map((row) => row.sequence));
    expect(copy.map(withoutEventId)).toEqual(original.map(withoutEventId));
    const copiedTypes: readonly string[] = copy.map((row) => row.type);
    for (const type of INTERNAL_EXECUTION_LEDGER_EVENT_TYPES) expect(copiedTypes, type).toContain(type);
  }, CASE_TIMEOUT_MS);

  /** The copied row keeps its timestamp, key, operation id and the other base fields. Only the event id differs. */
  it('CopyWorkflowStream_ACopiedRow_KeepsEachFieldButItsEventId', async () => {
    const seeded = {
      type: 'workflow.started',
      data: { featureId: STREAM, workflowType: 'feature' },
      timestamp: '2026-11-09T10:00:00.000Z',
      operationId: 'operation-seeded',
      correlationId: 'correlation-seeded',
      causationId: 'causation-seeded',
      agentId: 'agent-seeded',
      agentRole: 'implementer',
      source: 'replay-self-test',
    };
    await appendKeyed([seeded], 'key-seeded');

    await copyWorkflowStream(source, target, STREAM);

    const [original] = await source.query(STREAM);
    const [copy] = await target.query(STREAM);
    expect(copy).toMatchObject({ ...seeded, streamId: STREAM, sequence: 1, idempotencyKey: 'key-seeded' });
    expect(withoutEventId(copy ?? {})).toEqual(withoutEventId(original ?? {}));
    expect(typeof Reflect.get(copy ?? {}, 'eventId')).toBe('string');
    expect(Reflect.get(copy ?? {}, 'eventId')).not.toBe(Reflect.get(original ?? {}, 'eventId'));
  }, CASE_TIMEOUT_MS);

  /** A keyed batch stamps its key on each row, so the copy appends both rows in one call and writes one claim. */
  it('CopyWorkflowStream_AKeyedBatchOfTwoRows_IsCopiedInOneAppend', async () => {
    const first = { type: 'state.patched', data: { patch: { first: true } } };
    const second = { type: 'state.patched', data: { patch: { second: true } } };
    await source.getAppender().append(STREAM, [first, second], 'batch-key');

    await copyWorkflowStream(source, target, STREAM);

    const original = await source.query(STREAM);
    const copy = await target.query(STREAM);
    expect(copy.map((row) => [row.sequence, row.idempotencyKey, row.data])).toEqual([
      [1, 'batch-key', first.data],
      [2, 'batch-key', second.data],
    ]);
    const claim = target.getAppender().getSqliteBackend()?.lookupIdempotencyClaim(STREAM, 'batch-key');
    expect(claim?.sequences).toEqual(original.map((row) => row.sequence));
  }, CASE_TIMEOUT_MS);

  /** Two runs that are not consecutive and share a key refuse before the target holds a row or a bundle. */
  it('CopyWorkflowStream_AKeyThatTwoRunsShare_IsRefusedBeforeAnyWrite', async () => {
    const named = await sourceBundle('shared-key', 'the bytes of the first run');
    await appendKeyed([namingRow('workflow.started', [named])], 'shared-key');
    await appendKeyed([{ type: 'state.patched', data: { patch: {} } }], 'other-key');
    await appendUnkeyed([{ type: 'state.patched', data: { patch: {} }, idempotencyKey: 'shared-key' }]);

    await expect(copyWorkflowStream(source, target, STREAM)).rejects.toMatchObject({ code: 'KEY_REUSED' });

    expect(await target.query(STREAM)).toEqual([]);
    expect(await target.bundleStore.has(named.digest)).toBe('missing');
  }, CASE_TIMEOUT_MS);

  /** A bound copies the rows at or below it, and only the bundles that those rows name. */
  it('CopyWorkflowStream_ABound_CopiesTheRowsThroughItsSequenceOnly', async () => {
    const early = await sourceBundle('early', 'the bytes of the first row');
    const middle = await sourceBundle('middle', 'the bytes of the second row');
    const late = await sourceBundle('late', 'the bytes of the third row');
    await appendKeyed([namingRow('workflow.started', [early])], 'first');
    await appendUnkeyed([namingRow('state.patched', [middle])]);
    await appendKeyed([namingRow('state.patched', [late])], 'third');

    const copied = await copyWorkflowStream(source, target, STREAM, { throughSequence: 2 });

    expect((await target.query(STREAM)).map((row) => row.sequence)).toEqual([1, 2]);
    expect(copied.digests).toEqual([early.digest, middle.digest]);
    expect(await target.bundleStore.has(middle.digest)).toBe('ok');
    expect(await target.bundleStore.has(late.digest)).toBe('missing');
  }, CASE_TIMEOUT_MS);

  /** A bound inside a keyed run refuses before the first write, because a keyed append cannot copy a part of its run. */
  it('CopyWorkflowStream_ABoundInsideAKeyedRun_IsRefusedBeforeAnyWrite', async () => {
    await appendUnkeyed([{ type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } }]);
    await appendKeyed(
      [
        { type: 'state.patched', data: { patch: { first: true } } },
        { type: 'state.patched', data: { patch: { second: true } } },
      ],
      'batch-key',
    );

    await expect(copyWorkflowStream(source, target, STREAM, { throughSequence: 2 })).rejects.toMatchObject({
      code: 'BOUND_SPLITS_A_RUN',
    });

    expect(await target.query(STREAM)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /** Each bundle that a row names resolves in the target by the same digest, to the same bytes. */
  it('CopyWorkflowStream_EachNamedBundle_ResolvesInTheTargetByTheSameDigest', async () => {
    const one = await sourceBundle('one', 'the bytes of one bundle');
    const two = await sourceBundle('two', 'the bytes of another bundle');
    await appendKeyed([namingRow('workflow.prepared', [one, two])], 'prepared');
    await appendUnkeyed([namingRow('state.patched', [two])]);

    const copied = await copyWorkflowStream(source, target, STREAM);

    expect(copied.digests).toEqual([one.digest, two.digest]);
    for (const ref of [one, two]) {
      const bytes = await target.bundleStore.resolve(ref.digest);
      expect(bytes.equals(await source.bundleStore.resolve(ref.digest))).toBe(true);
    }
  }, CASE_TIMEOUT_MS);

  /** A digest that only the verification trace of a settlement bundle names reaches the target too. */
  it('CopyWorkflowStream_ADigestThatASettlementBundleNames_IsCopied', async () => {
    const segment = await sourceBundle('segment', 'the run bundle of one verification segment');
    const bundle = encodeSettlementBundle({
      bundleVersion: SETTLEMENT_BUNDLE_VERSION,
      kind: SETTLEMENT_BUNDLE_KIND,
      operationId: 'settle-seeded',
      streamId: STREAM,
      requestDigest: 'request-seeded',
      capsule: { workflowId: STREAM, definitionVersion: 'definition-seeded', designVersion: 'design-v1', capsuleVersion: 1, batchId: 'batch-1' },
      outcome: 'settled',
      acceptedTasks: ['task-a'],
      findings: [],
      claims: [{ taskId: 'task-a', fields: {}, evidence: [] }],
      deviations: [],
      adjudicated: { claims: 1, requiredResults: 1, fields: 0, evidence: 0, deviations: 0, verification: 1 },
      verification: [{ taskId: 'task-a', outcome: 'verified', bundleRefs: [segment] }],
      settledAt: '2026-11-09T10:00:00.000Z',
    });
    const settlement = {
      artifactId: ArtifactIdSchema.parse('run-bundle:settlement-seeded'),
      digest: await source.bundleStore.put(bundle),
    };
    await appendKeyed([namingRow('execution.settled', [settlement])], 'settled');
    const namedByRows = (await source.query(STREAM)).flatMap((row) => extractBundleRefs(row).refs.map((ref) => ref.digest.value));
    expect(namedByRows).toEqual([settlement.digest.value]);

    const copied = await copyWorkflowStream(source, target, STREAM);

    expect(copied.digests).toEqual([settlement.digest, segment.digest]);
    expect(await target.bundleStore.has(segment.digest)).toBe('ok');
  }, CASE_TIMEOUT_MS);

  /** A named digest that does not resolve in the source refuses with the digest and the sequence of its row. */
  it('CopyWorkflowStream_ABundleMissingInTheSource_IsRefusedWithItsDigest', async () => {
    const elsewhere = new RunBundleStore(path.join(scratch, 'elsewhere'));
    const absent = {
      artifactId: ArtifactIdSchema.parse('run-bundle:absent'),
      digest: await elsewhere.put(Buffer.from('bytes that the source never held', 'utf8')),
    };
    await appendKeyed([{ type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } }], 'start');
    await appendKeyed([namingRow('workflow.prepared', [absent])], 'prepared');

    const refusal = copyWorkflowStream(source, target, STREAM);

    await expect(refusal).rejects.toBeInstanceOf(WorkflowReplayError);
    await expect(refusal).rejects.toMatchObject({ code: 'BUNDLE_MISSING' });
    await expect(refusal).rejects.toThrow(`sha256:${absent.digest.value}`);
    await expect(refusal).rejects.toThrow('sequence 2');
    expect(await target.query(STREAM)).toEqual([]);
  }, CASE_TIMEOUT_MS);

  /** A target that already holds rows of the stream refuses, and it keeps only its own rows. */
  it('CopyWorkflowStream_ATargetThatHoldsTheStream_IsRefused', async () => {
    await appendKeyed([{ type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } }], 'start');
    const held = await target.getAppender().appendUnkeyed(STREAM, [{ type: 'workflow.started', data: { featureId: STREAM } }]);
    expect(held.ok).toBe(true);

    await expect(copyWorkflowStream(source, target, STREAM)).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' });

    expect((await target.query(STREAM)).map((row) => row.data)).toEqual([{ featureId: STREAM }]);
  }, CASE_TIMEOUT_MS);
});
