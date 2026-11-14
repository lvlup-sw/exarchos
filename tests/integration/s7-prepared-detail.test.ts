/**
 * Historical pages authenticate immutable custody and retain every approved task exactly once.
 * @oracle-sources: authored fixture contexts, SQLite rows and claims, UTF-8 serialized carrier bytes
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fc from 'fast-check';
import { mintDispatchContext, runWithDispatchContext } from '../../src/dispatch/dispatch-context.js';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { writeFile, rm } from 'node:fs/promises';
import { nodeTestProfile } from '../helpers/verification-profile.js';
import { WorkflowPreparedData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { readDesignRecord } from '../../src/workflow/design-record/read.js';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle } from '../../src/contract/capsule/prepared-bundle.js';
import { fixture, task, textOf, prepared } from '../helpers/capsule/prepared-authority.js';
import { handleReadPreparedCapsule } from '../../src/verbs/prepare/read-prepared-capsule.js';
import { PreparedDetailOutputSchema } from '../../src/registry/output-schemas.js';
import { preparedDetailCarrier, preparedDetailItems, preparedDetailDeliverable, summarizePreparedCapsuleReceipt } from '../../src/verbs/prepare/economy.js';
import { estimateOutputTokens } from '../../src/dispatch/core/economy.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const close: (() => Promise<void> | void)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const fn of close.splice(0).reverse()) await fn(); });

/** Builds independent complete custody without the reader or compiler as its expected-value oracle. */
async function setup(count = 30, large = false) {
  const root = makeTempDir('prepared-detail-'); close.push(() => rmrfAsync(root));
  const events = new EventStore(root); await events.initialize(); close.push(() => events.close());
  const tasks = Array.from({ length: count }, (_, i) => task(`task-${i}`, {
    blockedBy: i < 10 ? [] : [`task-${i - 10}`, `task-${(i - 10 + 1) % 10 + (i >= 20 ? 10 : 0)}`],
    instructions: large ? '界\"'.repeat(1800) : `Implement task ${i} with its exact approved obligations.`,
  }));
  const text = textOf(tasks); const bundle = fixture(text); const capsule = bundle.capsule;
  const read = readDesignRecord(Buffer.from(text), 'unavailable/plan.md'); if (read.kind !== 'typed') throw new Error('Invalid fixture');
  capsule.provenance.compilerVersion = 'exarchos-prepare-8';
  capsule.graph.tasks = read.snapshot.tasks.map(entry => ({ taskId: entry.id, title: entry.title, stepId: 'delegate', stage: { kind: 'task-batch', stepId: 'delegate' },
    taskContext: { taskId: entry.id, title: entry.title, instructions: entry.instructions, files: [...entry.files], testFiles: [...entry.testFiles],
      acceptance: [...entry.acceptance], riskTier: entry.riskTier, boundaryTouching: entry.boundaryTouching, testLayer: entry.testLayer,
      blockedBy: [...entry.blockedBy], resultContractRef: entry.id,
      source: { reference: read.snapshot.reference, digest: read.snapshot.digest, span: { ...entry.span } },
      knowledgeSlice: { invariantIds: [], adrRefs: [], symbols: [], files: [] } } }));
  capsule.graph.dependencies = tasks.flatMap(entry => entry.blockedBy.map(from => ({ from, to: entry.id })));
  capsule.graph.joins = tasks.filter(entry => entry.blockedBy.length > 1).map(entry => ({ joinId: `join:${contentDigest(entry.id)}`, forTaskId: entry.id, waitsFor: [...entry.blockedBy], mode: 'all' }));
  capsule.contracts.taskResults = Object.fromEntries(tasks.map(entry => [entry.id, [{ name: 'worktreePath', type: 'string' as const, required: true },
    ...(entry.blockedBy.length ? [{ name: 'forkCommit', type: 'string' as const, required: true }] : [])]]));
  capsule.contracts.taskInputs = {};
  capsule.settlementContract.scope = { repository: '/isolated/repository.git', checkout: '/isolated/checkout', configDigest: 'a'.repeat(64) };
  capsule.settlementContract.verificationProfile = nodeTestProfile();
  capsule.settlementContract.verificationMode = 'immutable-task-diff-v1';
  capsule.settlementContract.requiredResults = tasks.map(entry => entry.id);
  capsule.settlementContract.taskVerification = Object.fromEntries(tasks.map(entry => [entry.id, { riskTier: 'low' as const, boundaryTouching: false, baseRef: 'main', baseCommit: 'a'.repeat(40) }]));
  const store = async () => {
    const digest = await events.bundleStore.put(encodePreparedBundle(bundle));
    const row = prepared(bundle);
    await events.append(capsule.identity.workflowId, { type: row.type, schemaVersion: '1.0', data: { ...row.data,
      bundleRefs: [{ artifactId: 'run-bundle:fixture', digest }] } });
  };
  await store();
  const args = { streamId: capsule.identity.workflowId, capsuleVersion: capsule.identity.capsuleVersion };
  const ctx = { stateDir: root, eventStore: events, treeObserver: async () => { throw new Error('Unexpected checkout read'); } };
  const call = (extra: Record<string, unknown> = {}) => handleReadPreparedCapsule({ ...args, ...extra }, root, ctx);
  const snapshot = () => {
    const db = new Database(join(root, 'exarchos.db'), { readonly: true });
    try { return { events: db.query('SELECT * FROM events ORDER BY streamId, sequence').all(), claims: db.query('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all(), state: db.query('SELECT * FROM workflow_state ORDER BY 1').all(), streams: db.query('SELECT * FROM streams ORDER BY 1').all() }; }
    finally { db.close(); }
  };
  return { root, events, bundle, capsule, tasks, call, args, store, snapshot };
}

/** Parses the declared successful output rather than trusting a cast. */
function page(result: unknown) {
  const parsed = PreparedDetailOutputSchema.parse(result);
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed;
}

describe('authenticated prepared detail', () => {
  it('ThirtyTasks_BoundedReceiptUsableDetail', async () => {
    const f = await setup(); const before = f.snapshot(); const original = structuredClone(f.bundle);
    const receipt = { operationId: 'prepare:fixture', workflowId: f.args.streamId, capsuleVersion: f.args.capsuleVersion,
      capsuleDigest: capsuleDigest(f.capsule), definitionVersion: f.capsule.identity.definitionVersion, capsule: f.capsule,
      bundleRefs: (await f.events.query(f.args.streamId))[0]?.data?.bundleRefs };
    const summary = summarizePreparedCapsuleReceipt(receipt);
    expect(summary.detailRead?.arguments).toEqual({ ...f.args, offset: 0, limit: 10 });
    const recovered = []; let offset = 0;
    do {
      const result = page(await f.call({ offset })); expect(estimateOutputTokens(result)).toBeLessThanOrEqual(8000);
      expect(result.data.count).toBe(10); recovered.push(...result.data.items);
      offset = result.data.continuation?.arguments.offset ?? f.tasks.length;
    } while (offset < f.tasks.length);
    expect(recovered.map(item => item.taskId)).toEqual(f.tasks.map(item => item.id));
    expect(recovered.map(item => item.context.instructions)).toEqual(f.tasks.map(item => item.instructions));
    expect(recovered).toEqual(preparedDetailItems(f.capsule));
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 29 }), async (limit, start) => {
      const result = page(await f.call({ offset: start, limit }));
      expect(result.data.items.map(item => item.taskId)).toEqual(f.tasks.slice(start, start + limit).map(item => item.id));
      expect(estimateOutputTokens(result)).toBeLessThanOrEqual(8000);
    }), { seed: 192711, numRuns: 12 });
    expect(f.bundle).toEqual(original); expect(f.snapshot()).toEqual(before);
  });

  it('LongestPrefix_CompleteCarrierAndExactBoundary', async () => {
    const f = await setup(10, true); const result = page(await f.call());
    expect(result.data.count).toBeGreaterThan(0); expect(result.data.count).toBeLessThan(10);
    const metadata = { operationId: result.data.operationId, capsule: result.data.capsule, capsuleDigest: result.data.capsuleDigest,
      bundleRefs: result.data.bundleRefs, total: result.data.total };
    const items = preparedDetailItems(f.capsule);
    expect(estimateOutputTokens(preparedDetailCarrier(metadata, items.slice(0, result.data.count + 1), 0, 10))).toBeGreaterThan(8000);
    expect(result.data.continuation?.arguments.offset).toBe(result.data.count);
    expect(preparedDetailDeliverable(f.capsule)).toBe(true);
    const item = structuredClone(items[0]); if (item === undefined) throw new Error('Missing item');
    item.context.instructions = '';
    const empty = preparedDetailCarrier(metadata, [item], 0, 10);
    const room = 32000 - Buffer.byteLength(JSON.stringify(empty));
    item.context.instructions = 'x'.repeat(room);
    expect(estimateOutputTokens(preparedDetailCarrier(metadata, [item], 0, 10))).toBe(8000);
    item.context.instructions += 'x';
    expect(estimateOutputTokens(preparedDetailCarrier(metadata, [item], 0, 10))).toBe(8001);
  });

  it('HistoricalCapsule_PageStable', async () => {
    const f = await setup(); const first = await f.call({ offset: 10, limit: 3 });
    f.capsule.identity.capsuleVersion += 1; await f.store();
    await writeFile(join(f.root, 'plan.md'), 'Mutable source no longer contains the approved plan.');
    expect(await f.call({ offset: 10, limit: 3 })).toEqual(first);
    const end = page(await f.call({ offset: 30 })); expect(end.data.items).toEqual([]); expect(end.data.continuation).toBeUndefined();
    for (const extra of [{ offset: -1 }, { offset: 31 }, { offset: 0.5 }, { limit: 0 }, { limit: 11 }, { limit: Infinity }, { unexpected: true }]) {
      expect((await f.call(extra)).error?.code).toBe('INVALID_INPUT');
    }
  });

  it('MissingBundle_NoRegeneration', async () => {
    for (const mode of ['missing', 'corrupt', 'foreign', 'duplicate']) {
      const f = await setup(1); const rows = await f.events.query(f.args.streamId); const before = f.snapshot();
      const recorded = WorkflowPreparedData.parse(rows[0]?.data); const ref = recorded.bundleRefs[0];
      if (ref === undefined) throw new Error('Missing custody reference');
      const blob = join(f.events.bundleStore.root, 'sha256', ref.digest.value.slice(0, 2), ref.digest.value.slice(2));
      if (mode === 'missing') await rm(blob);
      if (mode === 'corrupt') await writeFile(blob, 'corrupt immutable bytes');
      if (mode === 'foreign') {
        const altered = structuredClone(f.bundle); altered.capsule.identity.workflowId = 'foreign';
        const digest = await f.events.bundleStore.put(encodePreparedBundle(altered));
        const db = new Database(join(f.root, 'exarchos.db'));
        try {
          const stored = db.query('SELECT payload FROM events WHERE streamId=? AND sequence=?').get(f.args.streamId, rows[0]?.sequence);
          if (typeof stored !== 'object' || stored === null || !('payload' in stored) || typeof stored.payload !== 'string') throw new Error('Missing payload');
          const payload = JSON.parse(stored.payload); payload.data = { ...recorded, bundleRefs: [{ ...ref, digest }] };
          db.query('UPDATE events SET data=?, payload=? WHERE streamId=? AND sequence=?').run(JSON.stringify(payload.data), JSON.stringify(payload), f.args.streamId, rows[0]?.sequence);
        } finally { db.close(); }
      }
      if (mode === 'duplicate') {
        const row = rows[0]; if (row === undefined) throw new Error('Missing row');
        await f.events.append(f.args.streamId, { type: row.type, schemaVersion: '1.0', data: row.data });
      }
      const selected = f.snapshot(); const result = await f.call(); expect(result.error?.code).toBe('PREPARED_DETAIL_UNAVAILABLE');
      expect(f.snapshot()).toEqual(mode === 'duplicate' || mode === 'foreign' ? selected : before); vi.restoreAllMocks();
    }
  });

  it('DetailRead_ZeroWrites', async () => {
    const f = await setup(); const before = f.snapshot();
    const append = vi.spyOn(f.events, 'append'); const decide = vi.spyOn(f.events.getAppender(), 'decideOnce');
    await f.call(); await f.call({ offset: 30 }); await f.call({ capsuleVersion: 999 }); await f.call({ streamId: 'unknown' });
    const correlation = mintDispatchContext({ correlationId: '界'.repeat(9000), causationId: 'escaped"'.repeat(100) });
    const correlated = await runWithDispatchContext(correlation, () => f.call());
    expect(correlated.success, JSON.stringify(correlated)).toBe(true);
    if (correlated.success) {
      expect(correlated._meta).toEqual({ operationId: correlation.operationId, correlationId: correlation.correlationId, causationId: correlation.causationId });
      expect(estimateOutputTokens(correlated)).toBeLessThanOrEqual(8000);
    } else expect(correlated.error?.code).toBe('PREPARED_DETAIL_UNAVAILABLE');
    const warning = 'Existing store warning '.repeat(500);
    const warned = await handleReadPreparedCapsule(f.args, f.root, { stateDir: f.root, eventStore: f.events }, [warning]);
    expect(warned.success).toBe(true); expect(warned.warnings).toEqual([warning]); expect(estimateOutputTokens(warned)).toBeLessThanOrEqual(8000);
    const warningOverflow = await handleReadPreparedCapsule(f.args, f.root, { stateDir: f.root, eventStore: f.events }, ['x'.repeat(33000)]);
    expect(warningOverflow.error?.code).toBe('PREPARED_DETAIL_UNAVAILABLE');
    const impossible = await runWithDispatchContext(mintDispatchContext({ correlationId: 'x'.repeat(33000) }), () => f.call());
    expect(impossible.error?.code).toBe('PREPARED_DETAIL_UNAVAILABLE');
    expect(append).not.toHaveBeenCalled(); expect(decide).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  });
});
