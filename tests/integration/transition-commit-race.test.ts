/**
 * These tests check that a transition commits its move once, when the stream changes between the read and the commit.
 * The transition handler decides on its read of the rows, and the closure of its commit decides again on the snapshot rows.
 * A store wrapper changes the stream or the snapshot at a fixed point of the call.
 *
 * @oracle-sources: ../../src/workflow/handlers/set.ts, the store wrapper that commits the foreign move
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { DecideOnceContext, DecideOnceDecision } from '../../src/events/atomic-appender.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';
import { flushLiveShadowEvidence } from '../../src/workflow/admission/live-shadow-observer.js';
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
const TRAIL_TYPES: readonly string[] = ['workflow.transition', 'phase.exited', 'phase.entered'];

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
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

describe('the commit of a transition move', () => {
  /** A foreign commit of the same move after the first read of the handler leaves one trail, and the call replies `idempotent: true`. */
  it('HandleSet_ACommitBetweenReadAndCommit_GivesOneTrail', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    const appender = store.eventStore.getAppender();
    const originalQuery = store.eventStore.query.bind(store.eventStore);
    let foreignCommitted = false;
    replaceMethod(store.eventStore, 'query', async (streamId: string, filters?: Parameters<EventStore['query']>[1]) => {
      const rows = await originalQuery(streamId, filters);
      if (!foreignCommitted && streamId === FEATURE_ID && filters === undefined) {
        foreignCommitted = true;
        await appender.decideOnce<number>('a-foreign-operation', 'a-foreign-digest', () => ({
          streamId: FEATURE_ID,
          events: [
            { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate', trigger: 'foreign', featureId: FEATURE_ID } },
            { type: 'phase.exited', data: { phase: 'plan-review', allRequiredGatesPassed: true } },
          ],
          result: 2,
        }));
      }
      return rows;
    });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    expect(foreignCommitted).toBe(true);
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ phase: 'delegate', idempotent: true });
    expect(transitionsTo(await originalQuery(FEATURE_ID), 'delegate')).toHaveLength(1);
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
