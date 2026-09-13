// `settle` end to end, against a real event store and a real content-addressed
// bundle store in a temporary directory.
//
// The load-bearing assertions here are the ones no unit test of the adjudicator
// can make: that the ledger record REFERENCES bytes that are actually in
// custody, that a replay is answered from the durable claim rather than
// recomputed, that a capsule is adjudicated only if a prepare call recorded it,
// and that the pre-effect refusals leave the store untouched.
//
// Every prepared capsule is seeded through `commitPreparedCapsule`, the same
// function the prepare handler commits through. A test-only writer would be a
// second producer of the record settlement trusts, and could drift from the
// real one without anything here noticing.
//
// @oracle-sources: ../../../../src/verbs/settle/handler.ts, the persisted operation claim the SQLite appender hands back on a replay which is read out of the store rather than rebuilt in process

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import {
  baseValidCapsule,
  baseValidDefinition,
} from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { INFRA_STREAM_IDS } from '../../../../src/dispatch/core/infra-streams.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import {
  BUNDLE_REF_FIELD,
  SETTLED_EVENT_TYPES,
  type BundleRefV1,
} from '../../../../src/events/bundle/digest-references.js';
import { EventStore } from '../../../../src/events/store.js';
import { ExecutionSettledData } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { decodeSettlementBundle } from '../../../../src/verbs/settle/settlement-bundle.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-settle-unit';

let stateDir: string;
let store: EventStore;
/** Blobs in custody once the base capsule is prepared, before any settlement. */
let seededBlobs: number;

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

function correlation(): ReturnType<typeof mintDispatchContext> {
  deriveMcpCallerIdentity({ sessionId: 'settle-fixture' });
  return mintDispatchContext(undefined);
}

/** Record `capsule` as prepared, through the production commit. */
async function seedPrepared(
  capsule: ExarchosCapsuleV1 = baseValidCapsule(),
  definition: unknown = baseValidDefinition(),
): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: 'feature',
      capsule,
      definition: WorkflowDefinitionV1Schema.parse(definition),
    }),
  );
}

function withVersion(capsule: ExarchosCapsuleV1, capsuleVersion: number): ExarchosCapsuleV1 {
  return { ...capsule, identity: { ...capsule.identity, capsuleVersion } };
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'settle-unit-'));
  store = new EventStore(stateDir);
  await store.initialize();
  await seedPrepared();
  seededBlobs = await bundleBlobCount();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

function passingClaim(): Record<string, unknown> {
  return {
    taskId: 'task-verify',
    fields: { passed: true },
    evidence: [{ kind: 'test', ref: 'run-1' }],
  };
}

function failingClaim(): Record<string, unknown> {
  return { taskId: 'task-verify', fields: { passed: 'yes' }, evidence: [] };
}

async function settle(raw: Record<string, unknown>): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () => handleSettle(raw, stateDir, wiring()));
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!result.success) throw new Error('unreachable');
  return result.data as unknown as SettlementReceipt;
}

/**
 * Every blob under the run-bundle root.
 *
 * The observable consequence of the replay pre-flight. A replay answered from
 * the persisted claim never builds a bundle; one that fell through to
 * `decideOnce` would build a SECOND document — a fresh `settledAt` makes it a
 * different digest — put it in custody, and then be handed the first call's
 * receipt anyway, leaving an orphan blob nothing references. The receipts are
 * identical either way, which is exactly why comparing them cannot see this.
 */
async function bundleBlobCount(): Promise<number> {
  const root = store.bundleStore.root;
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(root);
  return count;
}

async function settledRows(): Promise<
  { readonly type: string; readonly data: Record<string, unknown> }[]
> {
  const events = await store.query(STREAM);
  return events
    .filter((e) => e.type === 'execution.settled')
    .map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe('settle — the adjudication endpoint', () => {
  it('Settle_ASatisfiedBatch_SettlesAndCommitsOneRecord', async () => {
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-0001', claims: [passingClaim()] }),
    );
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-verify']);
    expect(receipt.findings).toEqual([]);
    expect(receipt.capsule.batchId).toBe('batch-0001');

    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    // The payload is the summary a reader needs without opening anything.
    const data = ExecutionSettledData.parse(rows[0]?.data);
    expect(data.batchId).toBe('batch-0001');
    expect(data.capsuleVersion).toBe(7);
    expect(data.outcome).toBe('settled');
    expect(data.findingCounts).toEqual([]);
    expect(data.adjudicated.claims).toBe(1);
  });

  it('Settle_TheCommittedRecord_ReferencesBytesInCustody', async () => {
    // The custody contract: the interior is durable BEFORE the fact naming it
    // exists, and the reference resolves to a document a reader can decode.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-custody', claims: [passingClaim()] }),
    );
    const refs = receipt.bundleRefs;
    expect(refs, 'the receipt carries no bundle reference').toBeDefined();
    expect(refs?.length).toBe(1);

    const rows = await settledRows();
    const rowRefs = rows[0]?.data[BUNDLE_REF_FIELD] as readonly BundleRefV1[] | undefined;
    expect(rowRefs?.length).toBe(1);

    const digest = rowRefs?.[0]?.digest;
    expect(digest).toBeDefined();
    if (digest === undefined) return;
    expect(await store.bundleStore.has(digest)).toBe('ok');

    const decoded = decodeSettlementBundle(await store.bundleStore.resolve(digest));
    expect(decoded.outcome).toBe('settled');
    expect(decoded.capsule.batchId).toBe('batch-custody');
    // The interior carries what the ledger row deliberately does not.
    expect(decoded.claims).toEqual([
      { taskId: 'task-verify', fields: { passed: true }, evidence: [{ kind: 'test', ref: 'run-1' }] },
    ]);
  });

  it('Settle_ThisRecord_IsARegisteredSettlementEndpoint', () => {
    // The integrity oracle keys on this membership, and it is what makes the
    // "custodial settlement must reference bytes" rule apply to these rows.
    expect(SETTLED_EVENT_TYPES).toContain('execution.settled');
  });

  it('Settle_ARejectedBatch_IsStillASettlementAndStillCommits', async () => {
    // A refusal is the caller's next input, and the next call has to be able to
    // read that this batch did not take.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-rejected', claims: [failingClaim()] }),
    );
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.findings.map((f) => f.kind)).toContain('field-type-mismatch');

    const rows = await settledRows();
    expect(rows).toHaveLength(1);
    const data = ExecutionSettledData.parse(rows[0]?.data);
    expect(data.outcome).toBe('rejected');
    expect(data.findingCounts).toEqual([{ kind: 'field-type-mismatch', count: 1 }]);
  });

  describe('the terms are the prepared capsule', () => {
    it('Settle_ACapsuleVersionNeverPrepared_IsRefusedBeforeAnyEffect', async () => {
      const result = await settle({ featureId: STREAM, capsuleVersion: 9, batchId: 'batch-unprepared', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_NOT_PREPARED');
      expect(await settledRows()).toEqual([]);
      expect(await bundleBlobCount()).toBe(seededBlobs);
    });

    it('Settle_ASubmittedCapsuleThatIsNotTheRecordedOne_IsRefused', async () => {
      // Same version, different terms: a document a caller edited after the
      // compilation. Adjudicating against it would let the caller rewrite the
      // contract its own work is judged by.
      const base = baseValidCapsule();
      const edited = {
        ...base,
        contracts: { ...base.contracts, evidenceKinds: ['test', 'diff', 'anything'] },
      };
      const result = await settle({ featureId: STREAM, capsule: edited, batchId: 'batch-edited', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_DIGEST_MISMATCH');
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ASubmittedCapsuleThatIsTheRecordedOne_Settles', async () => {
      const receipt = receiptOf(
        await settle({ featureId: STREAM, capsule: baseValidCapsule(), batchId: 'batch-inline', claims: [passingClaim()] }),
      );
      expect(receipt.outcome).toBe('settled');
    });

    it('Settle_AVersionThatDisagreesWithTheSubmittedCapsule_IsRefused', async () => {
      const result = await settle({
        featureId: STREAM,
        capsuleVersion: 8,
        capsule: baseValidCapsule(),
        batchId: 'batch-disagree',
        claims: [passingClaim()],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('Settle_NoCapsuleNamedAtAll_IsRefused', async () => {
      const result = await settle({ featureId: STREAM, batchId: 'batch-nameless', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('capsuleVersion');
      }
    });

    it('Settle_ATaskNamingAStepItsPinnedDefinitionLacks_IsUnresolved', async () => {
      // The reference pass runs against the definition the record pinned, not
      // without one: a task pointing at a step the definition does not have is
      // refused rather than adjudicated as if the step existed.
      const base = baseValidCapsule();
      const ghost = withVersion(
        {
          ...base,
          graph: {
            ...base.graph,
            tasks: base.graph.tasks.map((t) => (t.taskId === 'task-verify' ? { ...t, stepId: 'step-ghost' } : t)),
          },
        },
        10,
      );
      await seedPrepared(ghost);
      const result = await settle({ featureId: STREAM, capsuleVersion: 10, batchId: 'batch-ghost', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CAPSULE_UNRESOLVED');
        expect(result.error.message).toContain('step-ghost');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_APreparedCapsuleThatDoesNotResolve_IsRefusedSeparately', async () => {
      const base = baseValidCapsule();
      const dangling = withVersion(
        { ...base, graph: { ...base.graph, dependencies: [{ from: 'task-compile', to: 'task-ghost' }] } },
        11,
      );
      await seedPrepared(dangling);
      const result = await settle({ featureId: STREAM, capsuleVersion: 11, batchId: 'batch-dangling', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CAPSULE_UNRESOLVED');
        expect(result.error.message).toContain('task-ghost');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ASubmittedCapsuleTheContractRejects_RefusesBeforeAnyEffect', async () => {
      const base = baseValidCapsule();
      const result = await settle({
        featureId: STREAM,
        capsule: { ...base, authority: { ...base.authority, invariants: [] } },
        batchId: 'batch-invalid',
        claims: [passingClaim()],
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CAPSULE_INVALID');
      expect(await settledRows()).toEqual([]);
    });
  });

  describe('the settlement key is the batch identity', () => {
    it('Settle_ARetryOfTheSameBatch_ReturnsThePersistedVerdictAndAppendsNothing', async () => {
      // No caller-held id: a harness that timed out and resubmits the batch it
      // already sent carries nothing but the batch itself, and that has to be
      // enough to find the verdict instead of producing a second one.
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-replay', claims: [passingClaim()] };
      const first = receiptOf(await settle(args));
      const afterFirst = await bundleBlobCount();
      expect(afterFirst).toBe(seededBlobs + 1);

      const replayed = receiptOf(await settle(args));
      expect(replayed).toEqual(first);
      expect(await settledRows()).toHaveLength(1);
      // The replay adjudicated NOTHING, which the receipts alone cannot show:
      // `decideOnce` hands back the first call's result either way, so a replay
      // that fell through would return the same receipt while leaving an orphan
      // bundle behind it.
      expect(await bundleBlobCount()).toBe(afterFirst);
    });

    it('Settle_TheSameBatchWithFieldsInAnotherKeyOrder_IsTheSameRequest', async () => {
      // Object key order is an accident of whoever serialized the batch. Two
      // encodings of one batch are one request, or a harmlessly re-serialized
      // retry is refused as a conflicting one.
      const first = receiptOf(
        await settle({
          featureId: STREAM,
          capsuleVersion: 7,
          batchId: 'batch-key-order',
          claims: [{ taskId: 'task-verify', fields: { passed: true, notes: 'n' }, evidence: [] }],
        }),
      );
      const second = receiptOf(
        await settle({
          featureId: STREAM,
          capsuleVersion: 7,
          batchId: 'batch-key-order',
          claims: [{ taskId: 'task-verify', fields: { notes: 'n', passed: true }, evidence: [] }],
        }),
      );
      expect(second).toEqual(first);
      expect(await settledRows()).toHaveLength(1);
    });

    it('Settle_DifferentClaimsUnderASettledBatch_AreRefusedBeforeAnyEffect', async () => {
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [passingClaim()] });
      const second = await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-collide', claims: [failingClaim()] });
      expect(second.success).toBe(false);
      if (!second.success) {
        expect(second.error.code).toBe('OPERATION_DIGEST_MISMATCH');
        expect(second.error.message).toContain('batch-collide');
      }
      expect(await settledRows()).toHaveLength(1);
      // Refused BEFORE the effect, not after it: a mismatch caught downstream
      // would already have put a bundle nothing will ever reference into custody.
      expect(await bundleBlobCount()).toBe(seededBlobs + 1);
    });

    it('Settle_ACorrectedBatchUnderTheSamePinnedCapsule_SettlesAsANewBatch', async () => {
      // The exception path's third call: the first batch was rejected, and the
      // correction goes back under the SAME capsule as a new batch. If the batch
      // identity were compiled into the capsule this would be the same key with
      // a different request, and correcting a rejection would cost a fresh
      // compilation.
      const rejected = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-first-attempt', claims: [failingClaim()] }),
      );
      expect(rejected.outcome).toBe('rejected');

      const corrected = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-second-attempt', claims: [passingClaim()] }),
      );
      expect(corrected.outcome).toBe('settled');
      expect(corrected.operationId).not.toBe(rejected.operationId);

      const rows = await settledRows();
      expect(rows.map((r) => ExecutionSettledData.parse(r.data).outcome)).toEqual(['rejected', 'settled']);
    });

    it('Settle_TheSameBatchIdUnderAnotherCapsuleVersion_IsAnotherSettlement', async () => {
      // Half a key is not a key. A batch id reused against a recompiled capsule
      // names different terms, and answering it with the old verdict would
      // report work judged against terms it never ran under.
      await seedPrepared(withVersion(baseValidCapsule(), 8));
      const v7 = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-reused', claims: [passingClaim()] }),
      );
      const v8 = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 8, batchId: 'batch-reused', claims: [passingClaim()] }),
      );
      expect(v8.operationId).not.toBe(v7.operationId);
      expect(await settledRows()).toHaveLength(2);
    });

    it('Settle_ConcurrentSubmissionsOfOneBatch_AdjudicateOnce', async () => {
      // Both calls reach the pre-flight before either commits. Without
      // serialization both would adjudicate and both would put a bundle in
      // custody; the loser would then be handed the winner's receipt with its
      // own orphan left behind.
      const args = { featureId: STREAM, capsuleVersion: 7, batchId: 'batch-race', claims: [passingClaim()] };
      const [a, b] = await Promise.all([settle(args), settle(args)]);
      expect(receiptOf(b)).toEqual(receiptOf(a));
      expect(await settledRows()).toHaveLength(1);
      expect(await bundleBlobCount()).toBe(seededBlobs + 1);
    });

    it('Settle_TheReceiptOperationId_IsDerivedFromTheBatchIdentity', async () => {
      const receipt = receiptOf(
        await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-derived', claims: [passingClaim()] }),
      );
      expect(receipt.operationId).toMatch(/^settle:[0-9a-f]{64}$/);
      const rows = await settledRows();
      expect(ExecutionSettledData.parse(rows[0]?.data).operationId).toBe(receipt.operationId);
    });

    it('Settle_NoBatchId_IsRefusedBeforeAnyEffect', async () => {
      const result = await settle({ featureId: STREAM, capsuleVersion: 7, claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('batchId');
      }
      expect(await settledRows()).toEqual([]);
    });

    it('Settle_ACallerOperationId_IsRefusedRatherThanUsedAsASecondKey', async () => {
      // Two keys for one settlement are two authorities over whether it
      // happened: the same batch under two caller ids would adjudicate twice.
      const result = await settle({
        featureId: STREAM,
        capsuleVersion: 7,
        batchId: 'batch-with-op',
        claims: [passingClaim()],
        operationId: 'op-caller',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('operationId');
      }
      expect(await settledRows()).toEqual([]);
    });
  });

  it('Settle_TwoSpellingsOfTheSubjectThatDisagree_AreRefused', async () => {
    const result = await settle({
      featureId: STREAM,
      streamId: 'feat-other',
      capsuleVersion: 7,
      batchId: 'batch-spellings',
      claims: [passingClaim()],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it.each([...INFRA_STREAM_IDS])(
    'Settle_AReservedInfrastructureStream_IsRefused_%s',
    async (reserved) => {
      // Every member, not one representative: the refusal is what keeps a
      // settlement record off the streams the reservation exists to keep
      // separate, and a single-member test would go quiet the day the set grew.
      const result = await settle({ featureId: reserved, capsuleVersion: 7, batchId: 'batch-reserved', claims: [passingClaim()] });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('reserved infrastructure stream');
      expect(await settledRows()).toEqual([]);
    },
  );

  it('Settle_NoSubject_IsRefused', async () => {
    const result = await settle({ capsuleVersion: 7, batchId: 'batch-no-subject', claims: [passingClaim()] });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
  });

  it('Settle_AMalformedClaim_IsRefusedWithoutAdjudicating', async () => {
    const result = await settle({
      featureId: STREAM,
      capsuleVersion: 7,
      batchId: 'batch-malformed',
      claims: [{ fields: { passed: true } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('taskId');
    expect(await settledRows()).toEqual([]);
  });

  it('Settle_TheTailSequence_IsTheRowThisCallAppended', async () => {
    // Read inside the write lock, so it names the sequence this append landed
    // on rather than whatever the stream held when the transaction opened.
    const receipt = receiptOf(
      await settle({ featureId: STREAM, capsuleVersion: 7, batchId: 'batch-tail', claims: [passingClaim()] }),
    );
    const events = await store.query(STREAM);
    const row = events.find((e) => e.type === 'execution.settled');
    expect(row?.sequence).toBe(receipt.tailSequence);
  });
});
