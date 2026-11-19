/**
 * Settlement phase authority uses immutable whole plans and committing completion rows.
 * @oracle-sources: ../../src/verbs/settle/handler.ts, persisted receipts and independent completion traces
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { capsuleDigest, contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { encodePreparedBundle, type PreparedBundleV1 } from '../../src/contract/capsule/prepared-bundle.js';
import { resolveConfig } from '../../src/config/resolve.js';
import type { DispatchContext } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { handleSettle } from '../../src/verbs/settle/handler.js';
import { SettlementReceiptData } from '../../src/verbs/settle/schemas.js';
import { configureStateStoreBackend } from '../../src/workflow/state-store.js';
import { handleInit } from '../../src/workflow/tools.js';
import { loadPreparedCustody, selectPreparedAuthority } from '../../src/workflow/capsule/prepared-custody.js';
import { fixture, prepared, task, textOf } from '../helpers/capsule/prepared-authority.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const STREAM = 'wf-capsule-corpus';
const A = 'task-compile';
const B = 'task-verify';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  configureStateStoreBackend(undefined);
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function store() {
  const stateDir = makeTempDir('settle-authority-');
  cleanup.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  cleanup.push(() => backend.close());
  const events = new EventStore(stateDir, { backend });
  await events.initialize();
  cleanup.push(() => events.close());
  configureStateStoreBackend(backend);
  const ctx: DispatchContext = { stateDir, eventStore: events, enableTelemetry: false };
  return { stateDir, backend, events, ctx };
}
type Store = Awaited<ReturnType<typeof store>>;

function bundle(version = 7, ids = [A, B], frontier = [A]): PreparedBundleV1 {
  const base = fixture(textOf(ids.map(id => task(id))));
  return { ...base, capsule: { ...base.capsule,
    identity: { ...base.capsule.identity, capsuleVersion: version },
    graph: { ...base.capsule.graph, tasks: frontier.map(taskId => ({ taskId, title: taskId, stepId: 'delegate' })), dependencies: [], joins: [] },
    contracts: { ...base.capsule.contracts, taskInputs: {}, taskResults: Object.fromEntries(frontier.map(id => [id, []])) },
    settlementContract: { ...base.capsule.settlementContract, requiredResults: frontier,
      taskVerification: Object.fromEntries(frontier.map(id => [id, { riskTier: 'low', boundaryTouching: false, baseRef: 'main' }])) },
  } };
}

async function prepare(s: Store, b = bundle()) {
  const digest = await s.events.bundleStore.put(encodePreparedBundle(b));
  const ref = { artifactId: `run-bundle:test-${b.capsule.identity.capsuleVersion}`, digest };
  const source = prepared(b);
  return s.events.append(STREAM, { type: 'workflow.prepared', schemaVersion: '1.0',
    operationId: `outer-${b.capsule.identity.capsuleVersion}`, correlationId: 'correlation-distinct', causationId: 'cause-distinct',
    data: { ...source.data, bundleRefs: [ref] } });
}
async function seed(s: Store, completed = [A], document = false) {
  if (document) {
    expect((await handleInit({ featureId: STREAM, workflowType: 'feature' }, s.stateDir, s.events)).success).toBe(true);
  } else {
    await s.events.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  }
  await s.events.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await s.events.append(STREAM, { type: 'state.patched', data: { patch: { tasks: [{ id: A, title: A, status: 'complete' }], riskTier: 'low', boundaryTouching: false } } });
  for (const taskId of completed) await s.events.append(STREAM, { type: 'task.completed', data: { taskId } });
}
function args() { return { featureId: STREAM, capsuleVersion: 7, batchId: 'batch', claims: [{ taskId: A, fields: {}, evidence: [] }] }; }
function settle(s: Store, overrides: Record<string, unknown> = {}) {
  return handleSettle({ ...args(), ...overrides }, s.stateDir, s.ctx, {});
}
async function receipt(s: Store) {
  const result = await settle(s);
  expect(result.success, JSON.stringify(result)).toBe(true);
  return SettlementReceiptData.parse(result.data);
}
async function settledRows(s: Store) { return s.events.query(STREAM, { type: 'execution.settled' }); }

/** The hook races only settlement transactions. Custody is never read inside their closures. */
function race(s: Store, before: (attempt: number) => Promise<void>) {
  const appender = s.events.getAppender();
  const original = appender.decideOnce.bind(appender);
  const resolve = s.events.bundleStore.resolve.bind(s.events.bundleStore);
  let committing = false;
  let attempts = 0;
  vi.spyOn(s.events.bundleStore, 'resolve').mockImplementation(async digest => {
    expect(committing).toBe(false);
    return resolve(digest);
  });
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
    if (!id.startsWith('settle:')) return original(id, digest, closure);
    await before(++attempts);
    return original(id, digest, tx => {
      committing = true;
      try { return closure(tx); } finally { committing = false; }
    });
  });
  return () => attempts;
}

describe('settle whole-plan authority', () => {
  it('Settle_DroppedPendingTask_DoesNotAdvance', async () => {
    const s = await store(); await seed(s); await prepare(s);
    expect((await receipt(s)).phaseMove).toMatchObject({ kind: 'stayed', reason: 'no-edge-admits' });
  });
  it('Settle_NewerCompatibleFrontier_CanAdvance', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s); await prepare(s, bundle(8, [A, B], [B]));
    expect((await receipt(s)).phaseMove).toMatchObject({ kind: 'moved', from: 'delegate', to: 'review' });
  });
  it.each(['plan', 'definition', 'skips', 'skip-order', 'skip-duplicates', 'absent-skips'] as const)(
    'Settle_StableDifferentPlanDefinitionOrSkips_PersistsMismatchOnce: %s', async change => {
      const s = await store(); await seed(s, [A, B]);
      let named = bundle();
      let latest = bundle(8);
      if (change === 'plan') latest = bundle(8, [A, B, 'later']);
      if (change === 'definition') {
        const definition = { ...latest.definition, steps: latest.definition.steps.map(step => ({ ...step, stepName: `${step.stepName} updated` })) };
        latest = { ...latest, definition, capsule: { ...latest.capsule, identity: { ...latest.capsule.identity, definitionVersion: contentDigest(definition) } } };
      }
      if (change === 'skips') latest = { ...latest, capsule: { ...latest.capsule, settlementContract: { ...latest.capsule.settlementContract, skipPhases: ['unknown'] } } };
      if (change === 'skip-order' || change === 'skip-duplicates') {
        named = { ...named, capsule: { ...named.capsule, settlementContract: { ...named.capsule.settlementContract, skipPhases: ['unknown', 'other'] } } };
        latest = { ...latest, capsule: { ...latest.capsule, settlementContract: { ...latest.capsule.settlementContract, skipPhases: change === 'skip-order' ? ['other', 'unknown'] : ['unknown', 'other', 'unknown'] } } };
      }
      if (change === 'absent-skips') {
        const { designRecord: _record, ...legacy } = named;
        const { skipPhases: _skips, ...contract } = named.capsule.settlementContract;
        named = { ...legacy, capsule: { ...named.capsule, provenance: { ...named.capsule.provenance, compilerVersion: 'exarchos-prepare-6' }, settlementContract: contract } };
      }
      await prepare(s, named); await prepare(s, latest);
      const first = await receipt(s);
      expect(first.phaseMove).toEqual({ kind: 'not-decided', reason: 'prepared-authority-mismatch' });
      await prepare(s, bundle(9));
      expect(await receipt(s)).toEqual(first);
      expect(await settledRows(s)).toHaveLength(1);
      expect((await settle(s, { claims: [{ taskId: A, fields: { changed: true }, evidence: [] }] })).error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    });
  it('Settle_UnchangedPreparedEnvelopeMetadata_CommitsFirstAttempt', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const attempts = race(s, async () => { await s.events.append(STREAM, { type: 'task.failed', data: { taskId: B } }); });
    expect((await receipt(s)).phaseMove).toMatchObject({ kind: 'stayed' });
    expect(attempts()).toBe(1);
  });
  it.each([1, 3])('Settle_NewPreparedEnvelopeAfterRead_ReloadsOutsideCommit: %s', async changes => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const attempts = race(s, async n => { if (n <= changes) await prepare(s, bundle(7 + n)); });
    const result = await settle(s);
    if (changes === 1) {
      expect(SettlementReceiptData.parse(result.data).phaseMove).toMatchObject({ kind: 'moved' });
      expect(attempts()).toBe(2);
    } else {
      expect(result.error?.code).toBe('CONCURRENCY_CONFLICT');
      expect(await settledRows(s)).toHaveLength(0);
      vi.restoreAllMocks();
      expect((await receipt(s)).phaseMove).toMatchObject({ kind: 'moved' });
    }
  });
  it('Settle_LateMissingCustody_PreservesCompletionAndNoMove', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    race(s, async n => {
      if (n !== 1) return;
      const source = prepared(bundle(8));
      await s.events.append(STREAM, { type: source.type, data: source.data });
    });
    expect((await settle(s)).error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(await settledRows(s)).toHaveLength(0);
    expect(await s.events.query(STREAM, { type: 'task.completed' })).toHaveLength(2);
    vi.restoreAllMocks();
    await prepare(s, bundle(9));
    expect((await receipt(s)).phaseMove).toMatchObject({ kind: 'moved' });
  });
  it('Settle_FrozenSkips_IgnoreCurrentConfig', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const ctx = { ...s.ctx, projectConfig: resolveConfig({ workflow: { skipPhases: ['review'] } }) };
    const result = await handleSettle(args(), s.stateDir, ctx, {});
    expect(SettlementReceiptData.parse(result.data).phaseMove).toMatchObject({ kind: 'moved', to: 'review' });
  });
  it.each(['missing', 'text', 'duplicate-source', 'marker', 'definition'] as const)('Settle_CorruptCustody_RefusesWithoutReceipt: %s', async damage => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    let newer = bundle(8);
    if (damage === 'text') newer = { ...newer, designRecord: { reference: 'plan.md', text: 'invalid plan' } };
    if (damage === 'duplicate-source') newer = { ...newer, capsule: { ...newer.capsule, provenance: { ...newer.capsule.provenance,
      sources: [...newer.capsule.provenance.sources, ...newer.capsule.provenance.sources.filter(source => source.sourceId === 'design-record')] } } };
    if (damage === 'definition') newer = { ...newer, definition: { ...newer.definition, name: 'wrong-type' } };
    if (damage === 'missing') {
      const row = prepared(newer); await s.events.append(STREAM, { type: row.type, data: row.data });
    } else if (damage === 'marker') {
      const { designRecord: _record, ...legacy } = newer; await prepare(s, legacy);
    } else await prepare(s, newer);
    const result = await settle(s);
    expect(result.error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(await settledRows(s)).toHaveLength(0);
  });
  it('Settle_GeneratedPolicyAndCompletionTraces_NeverMixAuthorities', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), fc.boolean(), async (trace, changed) => {
      const s = await store(); await seed(s); await prepare(s);
      for (const complete of trace) await s.events.append(STREAM, { type: complete ? 'task.completed' : 'task.failed', data: { taskId: B } });
      if (changed) {
        const newer = bundle(8);
        await prepare(s, { ...newer, capsule: { ...newer.capsule, settlementContract: { ...newer.capsule.settlementContract, skipPhases: ['review'] } } });
      }
      const actual = await receipt(s);
      const expected = changed ? 'not-decided' : trace.at(-1) ? 'moved' : 'stayed';
      expect(actual.phaseMove?.kind).toBe(expected);
      if (changed) expect(actual.phaseMove).toEqual({ kind: 'not-decided', reason: 'prepared-authority-mismatch' });
      expect(await s.events.query(STREAM, { type: 'task.completed' })).toHaveLength(1 + trace.filter(Boolean).length);
    }), { seed: 192706, numRuns: 24 });
  });
});

describe('settle actual receipt replay', () => {
  it('Settle_UnavailableCustody_ReplaysReceiptAndRejectsChangedPayload', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const first = await receipt(s);
    await s.events.append(STREAM, { type: 'task.failed', data: { taskId: B } });
    const resolve = vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('unavailable'));
    expect(await receipt(s)).toEqual(first);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect((await settle(s, { claims: [{ taskId: A, fields: { changed: true }, evidence: [] }] })).error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(await settledRows(s)).toHaveLength(1);
  });
  it('Settle_SubmittedCapsuleDigest_IsStillCheckedOnReplay', async () => {
    const s = await store(); await seed(s); const b = bundle(); await prepare(s, b); await receipt(s);
    const changed = { ...b.capsule, intent: { ...b.capsule.intent, goals: [{ statement: 'Changed request' }] } };
    expect(capsuleDigest(changed)).not.toBe(capsuleDigest(b.capsule));
    expect((await settle(s, { capsule: changed })).error?.code).toBe('CAPSULE_DIGEST_MISMATCH');
  });
  it.each([false, true])('Settle_WinnerDuringCustody_ReplaysBeforeFreshValidation: fails=%s', async fails => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const resolve = s.events.bundleStore.resolve.bind(s.events.bundleStore);
    let winner: Awaited<ReturnType<typeof receipt>> | undefined;
    let entered = false;
    vi.spyOn(s.events.bundleStore, 'resolve').mockImplementation(async digest => {
      if (!entered) {
        entered = true;
        winner = await receipt(s);
        if (fails) throw new Error('custody disappeared after winner');
      }
      return resolve(digest);
    });
    expect(await receipt(s)).toEqual(winner);
    expect(await settledRows(s)).toHaveLength(1);
  });
  it('Settle_CopiedSettlementRow_IsNotAClaim', async () => {
    const first = await store(); await seed(first); await prepare(first); await receipt(first);
    const record = (await settledRows(first))[0];
    if (!record) throw new Error('Missing settlement record');
    const s = await store(); await seed(s); await prepare(s);
    await s.events.append(STREAM, { type: record.type, data: record.data });
    vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('missing'));
    expect((await settle(s)).error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(await settledRows(s)).toHaveLength(1);
  });
  it('Settle_BoundedCustodySelectionBenchmark_ReportsSeparateCosts', async () => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const rows = await s.events.query(STREAM);
    const started = performance.now();
    for (let n = 0; n < 100; n += 1) {
      const selected = selectPreparedAuthority(rows, STREAM);
      if (!selected) throw new Error('Missing authority');
      await loadPreparedCustody(selected, s.events.bundleStore);
    }
    const custodyMs = performance.now() - started;
    const settlementStart = performance.now();
    await receipt(s);
    console.log(JSON.stringify({ iterations: 100, custodySelectionMs: custodyMs, settlementMs: performance.now() - settlementStart, segmentRuns: 0 }));
  });
});


/** Restore only the task document fields to model publication failure. */
function pendingDocument(s: Store, ids = [A, B]) {
  const current = s.backend.getState(STREAM);
  if (current === null) throw new Error('Missing state document');
  s.backend.setState(STREAM, { ...current, phase: 'delegate', tasks: ids.map(id => ({ id, title: id, status: 'pending', blockedBy: [] })),
    _version: (current._version ?? 1) + 1 });
}
function documentStatuses(s: Store) { return s.backend.getState(STREAM)?.tasks?.map(entry => entry.status); }

describe('settle bounded legacy task repair', () => {
  it.each([true, false])('Settle_RequiredOnlyCompletion_RepairDependsOnVerifiedCustody: %s', async available => {
    const s = await store(); await seed(s, [A, B], true); pendingDocument(s);
    await prepare(s, bundle(7, [A, B, 'later'], [A, B]));
    const accepted = await receipt(s);
    expect(accepted.acceptedTasks).toEqual([A]);
    expect(accepted.phaseMove).toMatchObject({ kind: 'stayed' });
    pendingDocument(s);
    await s.events.append(STREAM, { type: 'task.failed', data: { taskId: B } });
    if (!available) vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('missing'));
    const result = await settle(s);
    expect(SettlementReceiptData.parse(result.data)).toEqual(accepted);
    expect(documentStatuses(s)).toEqual(available ? ['complete', 'complete'] : ['complete', 'pending']);
    expect(result.warnings?.some(w => w.startsWith('SUPPLEMENTAL_REPAIR_UNAVAILABLE')) ?? false).toBe(!available);
    expect(s.backend.getState(STREAM)?.phase).toBe('delegate');
  });
  it.each([true, false])('Settle_MandatoryRepairFailure_KeepsReceipt: custody=%s', async available => {
    const s = await store(); await seed(s, [A, B], true); pendingDocument(s);
    await prepare(s, bundle(7, [A, B, 'later'], [A, B]));
    const accepted = await receipt(s);
    pendingDocument(s, available ? [B] : [A]);
    if (!available) vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('missing'));
    vi.spyOn(s.backend, 'setState').mockImplementation(() => { throw new Error('publication failed'); });
    const failed = await settle(s);
    expect(failed.error?.code).toBe('STATE_SYNC_FAILED');
    expect(failed.error).toHaveProperty('settlementReceipt', accepted);
    expect(await settledRows(s)).toHaveLength(1);
  });
  it('Settle_OwnedCommitTaskPublicationFailure_RetriesFromActualClaim', async () => {
    const s = await store(); await seed(s, [A, B], true); pendingDocument(s);
    await prepare(s, bundle(7, [A, B, 'later'], [A, B]));
    const appender = s.events.getAppender();
    const original = appender.decideOnce.bind(appender);
    let held: unknown;
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      const result = await original(id, digest, closure);
      if (id.startsWith('settle:')) {
        held = result;
        pendingDocument(s);
        vi.spyOn(s.backend, 'setState').mockImplementation(() => { throw new Error('persistent publication failure'); });
      }
      return result;
    });
    const first = await settle(s);
    expect(first.error?.code).toBe('STATE_SYNC_FAILED');
    expect(first.error).toHaveProperty('settlementReceipt', held);
    await s.events.append(STREAM, { type: 'task.failed', data: { taskId: B } });
    vi.spyOn(s.events.bundleStore, 'resolve').mockRejectedValue(new Error('missing'));
    const again = await settle(s);
    expect(again.error?.code).toBe('STATE_SYNC_FAILED');
    expect(again.error).toHaveProperty('settlementReceipt', held);
    expect((await settle(s, { claims: [{ taskId: A, fields: { changed: true }, evidence: [] }] })).error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    vi.restoreAllMocks();
    expect(await receipt(s)).toEqual(held);
    expect(await settledRows(s)).toHaveLength(1);
  });
});


describe('settle receipt integrity', () => {
  it.each([false, true])('Settle_LateWinnerDifferentPayload_PreservesDigestRefusal: %s', async fails => {
    const s = await store(); await seed(s, [A, B]); await prepare(s);
    const original = s.events.bundleStore.resolve.bind(s.events.bundleStore);
    let entered = false;
    vi.spyOn(s.events.bundleStore, 'resolve').mockImplementation(async digest => {
      if (!entered) {
        entered = true;
        await receipt(s);
        if (fails) throw new Error('unavailable after winner');
      }
      return original(digest);
    });
    const result = await settle(s, { claims: [{ taskId: A, fields: { changed: true }, evidence: [] }] });
    expect(result.error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    expect(await settledRows(s)).toHaveLength(1);
  });
  it('Settle_ReceiptDigestDisagreesWithClaim_RefusesReplay', async () => {
    const s = await store(); await seed(s); await prepare(s);
    const appender = s.events.getAppender();
    const original = appender.decideOnce.bind(appender);
    vi.spyOn(appender, 'decideOnce').mockImplementation((id, digest, closure) => original(id, digest, tx => {
      const decision = closure(tx);
      if (!id.startsWith('settle:') || typeof decision.result !== 'object' || decision.result === null) return decision;
      return { ...decision, result: { ...decision.result, requestDigest: 'different' } };
    }));
    await settle(s);
    expect((await settle(s)).error?.code).toBe('CAPSULE_UNRESOLVED');
    expect(await settledRows(s)).toHaveLength(1);
  });
});


it('Settle_ActualClaimStreamDiffers_RefusesReceiptWithoutRepair', async () => {
  const source = await store(); await seed(source); await prepare(source);
  const request = { claims: [{ taskId: 'unknown', fields: {}, evidence: [] }] };
  const rejected = SettlementReceiptData.parse((await settle(source, request)).data);
  expect(rejected.outcome).toBe('rejected');
  const row = (await settledRows(source))[0];
  if (row === undefined) throw new Error('Missing rejected settlement row');
  const target = await store();
  const wrongStream = 'other-workflow';
  await target.events.getAppender().decideOnce(rejected.operationId, rejected.requestDigest, () => ({
    streamId: wrongStream,
    events: [{ type: row.type, data: row.data }],
    result: rejected,
  }));
  const claim = target.backend.lookupOperationClaim(rejected.operationId);
  expect(claim).toMatchObject({ streamId: wrongStream, requestDigest: rejected.requestDigest, result: rejected });
  const custody = vi.spyOn(target.events.bundleStore, 'resolve');
  const result = await settle(target, request);
  expect(result.success).toBe(false);
  expect(result.error?.code).toBe('CAPSULE_UNRESOLVED');
  expect(custody).not.toHaveBeenCalled();
  expect(await target.events.query(STREAM)).toEqual([]);
  expect(await target.events.query(wrongStream)).toHaveLength(1);
  expect(target.backend.lookupOperationClaim(rejected.operationId)).toEqual(claim);
});
