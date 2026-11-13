/**
 * These tests check that a transition commits its move once, when the stream changes between the read and the commit.
 * The transition handler decides on its read of the rows, and the closure of its commit decides again on the snapshot rows.
 * A store wrapper changes the stream or the snapshot at a fixed point of the call.
 * Two calls that read the same rows share one operation, so the second call gets the stored claim of the first call.
 *
 * @oracle-sources: ../../src/workflow/handlers/set.ts, the store wrapper that commits the foreign move
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { initializeContext } from '../../src/dispatch/core/context.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import type { DecideOnceContext, DecideOnceDecision } from '../../src/events/atomic-appender.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { configureCutoverAutoExport } from '../../src/workflow/admission/cutover-auto-export.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
import { configureCleanupSnapshotStore } from '../../src/workflow/cleanup.js';
import { configureStateStoreBackend, StateStoreError } from '../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface RaceStore {
  readonly stateDir: string;
  readonly eventStore: EventStore;
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
  return { stateDir, eventStore };
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
