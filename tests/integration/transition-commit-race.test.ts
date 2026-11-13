/**
 * These tests check that a transition commits its move once, when the stream changes between the read and the commit.
 * The transition handler decides on its read of the rows, and the closure of its commit decides again on the snapshot rows.
 * A store wrapper changes the stream or the snapshot at a fixed point of the call.
 * Two calls that read the same rows share one operation, so the second call gets the stored claim of the first call.
 *
 * @oracle-sources: ../../src/workflow/handlers/set.ts, the store wrapper that commits the foreign move
 */
import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import type { DecideOnceContext, DecideOnceDecision } from '../../src/events/atomic-appender.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { SequenceConflictError, EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { configureCutoverAutoExport } from '../../src/workflow/admission/cutover-auto-export.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
import { configureCleanupSnapshotStore } from '../../src/workflow/cleanup.js';
import { configureStateStoreBackend, readStateFile, StateStoreError } from '../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface RaceStore {
  readonly stateDir: string;
  readonly eventStore: EventStore;
  readonly backend: SqliteBackend;
}

/** The feature id of each case. Each case has its own store. */
const FEATURE_ID = 'transition-race';

/** The row types of the trail of a move. */
const TRAIL_TYPES: readonly string[] = ['workflow.transition', 'workflow.compound-entry', 'phase.exited', 'phase.entered'];

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
  configureCleanupSnapshotStore(null);
  configureCutoverAutoExport(undefined);
});

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<RaceStore> {
  const stateDir = makeTempDir('transition-race-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  releases.push(() => eventStore.close());
  configureStateStoreBackend(backend);
  return { stateDir, eventStore, backend };
}

/** Throws when a seed call does not succeed. */
function requireSuccess(step: string, result: ToolResult): void {
  if (result.success) return;
  throw new Error(`the seed step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Moves a feature to `plan-review` with the plan review approved, through the handlers. */
async function featureAtPlanReview(store: RaceStore): Promise<void> {
  requireSuccess('init', await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, store.stateDir, store.eventStore));
  requireSuccess('plan', await handleSet({ featureId: FEATURE_ID, updates: { 'artifacts.plan': 'plans/plan.md' } }, store.stateDir, store.eventStore));
  requireSuccess('plan-review', await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore));
  requireSuccess('approval', await handleSet({ featureId: FEATURE_ID, updates: { planReview: { approved: true } } }, store.stateDir, store.eventStore));
}

/** Replaces a method of an object for one case. The teardown restores the method. */
function replaceMethod<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]): void {
  const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { value: replacement, configurable: true, writable: true });
  releases.push(() => {
    if (ownDescriptor === undefined) Reflect.deleteProperty(target, key);
    else Object.defineProperty(target, key, ownDescriptor);
  });
}

/** Returns the trail rows of a list of rows: the transition, exit and entry rows. */
function trailOf(rows: readonly WorkflowEvent[]): readonly WorkflowEvent[] {
  return rows.filter((row) => TRAIL_TYPES.includes(row.type));
}

/** Returns the transition rows to one target. */
function transitionsTo(rows: readonly WorkflowEvent[], target: string): readonly WorkflowEvent[] {
  return rows.filter((row) => row.type === 'workflow.transition' && row.data?.to === target);
}

/** The value of one field of the reply data, or undefined when the data is not an object. */
function dataField(result: ToolResult | undefined, field: string): unknown {
  const data: unknown = result?.data;
  if (typeof data !== 'object' || data === null) return undefined;
  return Reflect.get(data, field);
}

/**
 * Runs one call inside the first full read of the stream of the feature, after the read returns its rows.
 * So the outer call decides on rows that do not hold the rows of the inner call.
 */
function runInsideTheFirstRead(eventStore: EventStore, call: () => Promise<ToolResult>): { readonly result: () => ToolResult | undefined } {
  const originalQuery = eventStore.query.bind(eventStore);
  let inner: ToolResult | undefined;
  let fired = false;
  replaceMethod(eventStore, 'query', async (streamId: string, filters?: Parameters<EventStore['query']>[1]) => {
    const rows = await originalQuery(streamId, filters);
    if (!fired && streamId === FEATURE_ID && filters === undefined) {
      fired = true;
      inner = await call();
    }
    return rows;
  });
  return { result: () => inner };
}

/** Opens a dispatch context with the shipped defaults over a SQLite backend in a new temporary directory. */
async function openDispatchContext(): Promise<DispatchContext> {
  const stateDir = makeTempDir('transition-race-dispatch-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const base = await initializeContext(stateDir, { backend });
  releases.push(() => base.eventStore.close());
  return { ...base, enableTelemetry: true, callerIdentity: deriveMcpCallerIdentity({ sessionId: 'transition-race-dispatch' }) };
}

describe('the commit of a transition move', () => {
  /** A foreign commit of the same move after the first read of the handler leaves one trail, and the call replies `idempotent: true`. */
  it('HandleSet_ACommitBetweenReadAndCommit_GivesOneTrail', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    const appender = store.eventStore.getAppender();
    const originalQuery = store.eventStore.query.bind(store.eventStore);
    const before = (await originalQuery(FEATURE_ID)).length;
    let foreignCommitted = false;
    replaceMethod(store.eventStore, 'query', async (streamId: string, filters?: Parameters<EventStore['query']>[1]) => {
      const rows = await originalQuery(streamId, filters);
      if (!foreignCommitted && streamId === FEATURE_ID && filters === undefined) {
        foreignCommitted = true;
        await appender.decideOnce<number>('a-foreign-operation', 'a-foreign-digest', () => ({
          streamId: FEATURE_ID,
          events: [
            { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate', trigger: 'foreign', featureId: FEATURE_ID, phaseAttemptId: 'foreign-attempt' } },
            { type: 'workflow.compound-entry', data: { compoundStateId: 'implementation', featureId: FEATURE_ID } },
            { type: 'phase.exited', data: { phase: 'plan-review', allRequiredGatesPassed: true } },
            { type: 'phase.entered', data: { phase: 'delegate', kind: 'IMPLEMENT', resolver: 'verification-ladder', resolvedGates: [], riskTier: 'unknown', boundaryTouching: true, posture: 'task-isolated', policySource: 'builtin', mode: 'enforce' } },
          ],
          result: 4,
        }));
      }
      return rows;
    });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    expect(foreignCommitted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ phase: 'delegate', idempotent: true });
    const trail = trailOf((await originalQuery(FEATURE_ID)).slice(before));
    expect(trail.map((row) => ({ type: row.type, data: row.data }))).toEqual([
      { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate', trigger: 'foreign', featureId: FEATURE_ID, phaseAttemptId: 'foreign-attempt' } },
      { type: 'workflow.compound-entry', data: { compoundStateId: 'implementation', featureId: FEATURE_ID } },
      { type: 'phase.exited', data: { phase: 'plan-review', allRequiredGatesPassed: true } },
      { type: 'phase.entered', data: { phase: 'delegate', kind: 'IMPLEMENT', resolver: 'verification-ladder', resolvedGates: [], riskTier: 'unknown', boundaryTouching: true, posture: 'task-isolated', policySource: 'builtin', mode: 'enforce' } },
    ]);
    expect(dataField(result, 'phaseAttemptId')).toBe('foreign-attempt');
  });

  /**
   * Two calls read the same rows, so they share one phase attempt id and one operation. The inner call commits the move.
   * The outer call gets the stored claim of the inner call, and its closure does not run. It wrote no row, so it replies `idempotent: true`.
   */
  it('HandleSet_TwoCallsThatReadTheSameRows_TheSecondRepliesIdempotent', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    const originalQuery = store.eventStore.query.bind(store.eventStore);
    const inner = runInsideTheFirstRead(store.eventStore, () =>
      handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore),
    );

    const outer = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    expect(inner.result()?.success).toBe(true);
    expect(dataField(inner.result(), 'idempotent')).toBeUndefined();
    expect(outer.success).toBe(true);
    expect(outer.data).toMatchObject({ phase: 'delegate', idempotent: true });
    expect(dataField(outer, 'phaseAttemptId')).toBe(dataField(inner.result(), 'phaseAttemptId'));
    expect(transitionsTo(await originalQuery(FEATURE_ID), 'delegate')).toHaveLength(1);
  });

  /**
   * The same race through the dispatcher with the shipped defaults. The outer call wrote no row and replies `idempotent: true`,
   * so it owes no emission. Both calls succeed, the stream holds one transition row and no `emission.violated` row.
   */
  it('Dispatch_TwoCallsThatReadTheSameRows_BothSucceedWithOneRow', async () => {
    const context = await openDispatchContext();
    const workflow = (action: string, fields: Readonly<Record<string, unknown>> = {}): Promise<ToolResult> =>
      dispatch('exarchos_workflow', { action, featureId: FEATURE_ID, ...fields }, context);
    requireSuccess('init', await workflow('init', { workflowType: 'feature' }));
    requireSuccess('plan', await workflow('update', { updates: { 'artifacts.plan': 'plans/plan.md' } }));
    const originalQuery = context.eventStore.query.bind(context.eventStore);
    const inner = runInsideTheFirstRead(context.eventStore, () => workflow('transition', { target: 'plan-review' }));

    const outer = await workflow('transition', { target: 'plan-review' });

    expect(inner.result()?.success).toBe(true);
    expect(outer.error?.code).toBeUndefined();
    expect(outer.success).toBe(true);
    expect(dataField(outer, 'idempotent')).toBe(true);
    const rows = await originalQuery(FEATURE_ID);
    expect(transitionsTo(rows, 'plan-review')).toHaveLength(1);
    expect(rows.filter((row) => row.type === 'emission.violated')).toEqual([]);
  });

  /** Reads that change before each commit throw the version conflict after the retry bound, and the store gains no trail row. */
  it('HandleSet_ReadsThatKeepChanging_ThrowTheConflictAndLeaveNoPartialTrail', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    const appender = store.eventStore.getAppender();
    const originalDecideOnce = appender.decideOnce.bind(appender);
    let commits = 0;
    replaceMethod(
      appender,
      'decideOnce',
      <TResult>(operationId: string, requestDigest: string, closure: (ctx: DecideOnceContext) => DecideOnceDecision<TResult>): Promise<TResult> => {
        commits += 1;
        return originalDecideOnce(operationId, requestDigest, (ctx) =>
          closure({
            readStream: (streamId) => {
              const snapshot = ctx.readStream(streamId);
              const foreign = {
                streamId,
                sequence: snapshot.version + 1,
                type: 'workflow.transition',
                timestamp: new Date().toISOString(),
                data: { from: 'plan-review', to: 'plan', trigger: 'foreign', featureId: FEATURE_ID },
              };
              return { events: [...snapshot.events, foreign], version: snapshot.version + 1 };
            },
          }),
        );
      },
    );
    const before = trailOf(await store.eventStore.query(FEATURE_ID)).length;

    const call = handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    await expect(call).rejects.toBeInstanceOf(StateStoreError);
    await expect(call).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(commits).toBe(4);
    expect(trailOf(await store.eventStore.query(FEATURE_ID))).toHaveLength(before);
    expect(transitionsTo(await store.eventStore.query(FEATURE_ID), 'delegate')).toEqual([]);
  });
});


/** A complete task used by the authoritative candidate races. */
const RACE_TASK = { id: 't1', title: 'old', status: 'pending' };

/** The identical combined request submitted by both contenders. */
const COMBINED_INPUT = { featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': 'plans/plan.md', 'tasks[0].title': 'renamed' } };

/** Initializes agreeing task sources and opens an independent writer on the same isolated database. */
async function taskRaceStore(): Promise<{ store: RaceStore; competitor: EventStore; raw: Database }> {
  const store = await openStore();
  requireSuccess('init', await handleInit({ featureId: FEATURE_ID, workflowType: 'feature' }, store.stateDir, store.eventStore));
  requireSuccess('tasks', await handleSet({ featureId: FEATURE_ID, updates: { tasks: [RACE_TASK] } }, store.stateDir, store.eventStore));
  const backend = new SqliteBackend(path.join(store.stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const competitor = new EventStore(store.stateDir, { backend });
  await competitor.initialize();
  releases.push(() => competitor.close());
  const raw = new Database(path.join(store.stateDir, 'exarchos.db'));
  releases.push(() => raw.close());
  return { store, competitor, raw };
}

/** Reads exact persisted document text and both kinds of immutable claims. */
function persistenceOf(raw: Database): { document: unknown; claims: unknown[] } {
  return {
    document: raw.prepare('SELECT state FROM workflow_state WHERE featureId = ?').get(FEATURE_ID),
    claims: raw.prepare('SELECT * FROM idempotency_claims WHERE streamId = ? OR idempotencyKey LIKE ? ORDER BY streamId, idempotencyKey').all(FEATURE_ID, `transition:${FEATURE_ID}:%`),
  };
}

/** Appends a legitimate task replacement through an independent event-store connection. */
async function replaceTasks(eventStore: EventStore, tasks: readonly unknown[]): Promise<void> {
  await eventStore.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: ['tasks'], patch: { tasks } } });
}

/** Waits for a child sentinel without holding a database lock or blocking its JavaScript thread. */
async function waitForFile(file: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Waits at a synchronous claim-read boundary while the independent child completes its commit. */
function waitForFileSync(file: string): void {
  const deadline = Date.now() + 10000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    Atomics.wait(signal, 0, 0, 10);
  }
}

describe('authoritative candidate commit races', () => {
  it('HandleSet_CombinedTaskRemovalAtTransactionEntry_RefusesBeforeCommit', async () => {
    const { store, competitor, raw } = await taskRaceStore();
    const before = persistenceOf(raw);
    const rows = await store.eventStore.query(FEATURE_ID);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let closures = 0;
    replaceMethod(appender, 'decideOnce', async <TResult>(id: string, digest: string, closure: (tx: DecideOnceContext) => DecideOnceDecision<TResult>): Promise<TResult> => {
      await replaceTasks(competitor, []);
      return original(id, digest, (tx) => { closures += 1; return closure(tx); });
    });
    const result = await handleSet(COMBINED_INPUT, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(closures).toBe(1);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(0, rows.length)).toEqual(rows);
    expect(after.slice(rows.length).map((row) => ({ type: row.type, patch: row.data?.patch }))).toEqual([{ type: 'state.patched', patch: { tasks: [] } }]);
    expect(persistenceOf(raw)).toEqual(before);
  });

  it('HandleSet_FieldTaskRemovalBeforeAppend_RevalidatesAndRefuses', async () => {
    const { store, competitor, raw } = await taskRaceStore();
    const before = persistenceOf(raw);
    const rows = await store.eventStore.query(FEATURE_ID);
    const original = store.eventStore.appendValidated.bind(store.eventStore);
    let calls = 0;
    let conflicts = 0;
    replaceMethod(store.eventStore, 'appendValidated', async (...args) => {
      calls += 1;
      expect(args[2]?.expectedSequence).toBe(rows.at(-1)?.sequence);
      await replaceTasks(competitor, []);
      try { return await original(...args); } catch (err) { if (err instanceof SequenceConflictError) conflicts += 1; throw err; }
    });
    const result = await handleSet({ featureId: FEATURE_ID, updates: { 'tasks[0].title': 'renamed' } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(calls).toBe(1);
    expect(conflicts).toBe(1);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(0, rows.length)).toEqual(rows);
    expect(after.slice(rows.length).map((row) => row.data?.patch)).toEqual([{ tasks: [] }]);
    expect(persistenceOf(raw)).toEqual(before);
  });

  it('HandleSet_FieldUnrelatedAppend_RetriesAgainstFreshTail', async () => {
    const { store, competitor } = await taskRaceStore();
    const rows = await store.eventStore.query(FEATURE_ID);
    const tail = rows.at(-1)?.sequence ?? 0;
    const original = store.eventStore.appendValidated.bind(store.eventStore);
    const expectedTails: (number | undefined)[] = [];
    let conflicts = 0;
    replaceMethod(store.eventStore, 'appendValidated', async (...args) => {
      expectedTails.push(args[2]?.expectedSequence);
      if (expectedTails.length === 1) await competitor.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: ['artifacts.design'], patch: { 'artifacts.design': 'design.md' } } });
      try { return await original(...args); } catch (err) { if (err instanceof SequenceConflictError) conflicts += 1; throw err; }
    });
    const result = await handleSet({ featureId: FEATURE_ID, updates: { 'tasks[0].title': 'renamed' } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(conflicts).toBe(1);
    expect(expectedTails).toEqual([tail, tail + 1]);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(rows.length).map((row) => row.data?.patch)).toEqual([{ 'artifacts.design': 'design.md' }, { 'tasks[0].title': 'renamed' }]);
    expect(await readStateFile(path.join(store.stateDir, `${FEATURE_ID}.state.json`))).toMatchObject({ tasks: [{ id: 't1', title: 'renamed', status: 'pending' }], artifacts: { design: 'design.md' }, _eventSequence: tail + 2 });
  });

  it('HandleSet_FieldSequenceConflicts_ExhaustWithoutPublishing', async () => {
    const { store, competitor, raw } = await taskRaceStore();
    const before = persistenceOf(raw);
    const rows = await store.eventStore.query(FEATURE_ID);
    const tail = rows.at(-1)?.sequence ?? 0;
    const original = store.eventStore.appendValidated.bind(store.eventStore);
    const expectedTails: (number | undefined)[] = [];
    let conflicts = 0;
    replaceMethod(store.eventStore, 'appendValidated', async (...args) => {
      expectedTails.push(args[2]?.expectedSequence);
      await competitor.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: ['artifacts.design'], patch: { 'artifacts.design': `design-${expectedTails.length}.md` } } });
      try { return await original(...args); } catch (err) { if (err instanceof SequenceConflictError) conflicts += 1; throw err; }
    });
    await expect(handleSet({ featureId: FEATURE_ID, updates: { 'tasks[0].title': 'renamed' } }, store.stateDir, store.eventStore)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(conflicts).toBe(4);
    expect(expectedTails).toEqual([tail, tail + 1, tail + 2, tail + 3]);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(0, rows.length)).toEqual(rows);
    expect(after.slice(rows.length).map((row) => row.data?.patch)).toEqual([1, 2, 3, 4].map((index) => ({ 'artifacts.design': `design-${index}.md` })));
    expect(persistenceOf(raw)).toEqual(before);
  });

  it('HandleSet_CombinedClaimAfterTaskRemoval_DoesNotReapplyPatch', async () => {
    const { store, competitor, raw } = await taskRaceStore();
    const rows = await store.eventStore.query(FEATURE_ID);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let fired = false;
    let loserClosures = 0;
    let winningClaims: unknown[] = [];
    replaceMethod(appender, 'decideOnce', async <TResult>(id: string, digest: string, closure: (tx: DecideOnceContext) => DecideOnceDecision<TResult>): Promise<TResult> => {
      if (fired) return original(id, digest, closure);
      fired = true;
      requireSuccess('winner', await handleSet(COMBINED_INPUT, store.stateDir, store.eventStore));
      winningClaims = persistenceOf(raw).claims;
      await replaceTasks(competitor, []);
      return original(id, digest, (tx) => { loserClosures += 1; return closure(tx); });
    });
    const result = await handleSet(COMBINED_INPUT, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: true, data: { idempotent: true, phase: 'plan-review' } });
    expect(fired).toBe(true);
    expect(loserClosures).toBe(0);
    expect(persistenceOf(raw).claims).toEqual(winningClaims);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(rows.length).map((row) => row.type)).toEqual(['state.patched', 'workflow.transition', 'phase.exited', 'phase.entered', 'state.patched']);
    expect(await readStateFile(path.join(store.stateDir, `${FEATURE_ID}.state.json`))).toMatchObject({ tasks: [], _eventSequence: after.at(-1)?.sequence });
  });

  it('HandleSet_CombinedInvalidPreflightWinner_RechecksClaimBeforeRefusal', async () => {
    const { store, competitor, raw } = await taskRaceStore();
    const initial = await readStateFile(path.join(store.stateDir, `${FEATURE_ID}.state.json`));
    expect(initial.phaseAttemptId).toEqual(expect.any(String));
    const before = await store.eventStore.query(FEATURE_ID);
    const ready = path.join(store.stateDir, 'claim-ready.json');
    const go = path.join(store.stateDir, 'claim-go');
    const done = path.join(store.stateDir, 'claim-done.json');
    const child = spawn('bun', [path.resolve('tests/helpers/decide/combined-claim-race.driver.mjs'), store.stateDir, FEATURE_ID], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    releases.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await exited; });
    await waitForFile(ready);
    expect(JSON.parse(readFileSync(ready, 'utf8'))).toMatchObject({ predecessor: initial.phaseAttemptId, phase: 'plan' });
    await replaceTasks(competitor, []);
    const backend = store.eventStore.getAppender().ensureSqliteBackendSync();
    const lookup = backend.lookupOperationClaim.bind(backend);
    const appender = store.eventStore.getAppender();
    const decideOnce = appender.decideOnce.bind(appender);
    let first = true;
    let initialMiss = false;
    let reads = 0;
    let operationId = '';
    let requestDigest = '';
    let loserClosures = 0;
    let winningClaims: unknown[] = [];
    replaceMethod(backend, 'lookupOperationClaim', <TResult>(id: string) => {
      const found = lookup<TResult>(id);
      reads += 1;
      if (first) {
        first = false;
        initialMiss = found === undefined;
        expect(found).toBeUndefined();
        operationId = id;
        writeFileSync(go, 'go');
        waitForFileSync(done);
        winningClaims = persistenceOf(raw).claims;
      }
      return found;
    });
    replaceMethod(appender, 'decideOnce', <TResult>(id: string, digest: string, closure: (tx: DecideOnceContext) => DecideOnceDecision<TResult>): Promise<TResult> => {
      expect(id).toBe(operationId);
      requestDigest = digest;
      return decideOnce(id, digest, (tx) => { loserClosures += 1; return closure(tx); });
    });
    const result = await handleSet(COMBINED_INPUT, store.stateDir, store.eventStore);
    expect(await exited, stderr).toBe(0);
    const winner: unknown = JSON.parse(readFileSync(done, 'utf8'));
    expect(winner).toMatchObject({ result: { success: true }, operationId, requestDigest });
    expect(initialMiss).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(loserClosures).toBe(0);
    expect(result).toMatchObject({ success: true, data: { idempotent: true, phase: 'plan-review' } });
    expect(persistenceOf(raw).claims).toEqual(winningClaims);
    const after = await store.eventStore.query(FEATURE_ID);
    expect(after.slice(before.length).map((row) => row.type)).toEqual(['state.patched', 'state.patched', 'state.patched', 'workflow.transition', 'phase.exited', 'phase.entered']);
    expect(after.slice(before.length, before.length + 3).map((row) => row.data?.patch)).toEqual([{ tasks: [] }, { tasks: [RACE_TASK] }, COMBINED_INPUT.updates]);
    expect(await readStateFile(path.join(store.stateDir, `${FEATURE_ID}.state.json`))).toMatchObject({ tasks: [{ id: 't1', title: 'renamed', status: 'pending' }], _eventSequence: after.at(-1)?.sequence });
  });
});
