/**
 * These tests check that the transition handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers, and a forge then changes the document only.
 * The fold decides each move, a move commits its rows once, and a denial appends one `workflow.guard-failed` row.
 *
 * @oracle-sources: ../../../src/workflow/phase-attempt-id.ts, hand-seeded stream rows
 */
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';
import { hsmTransitionGuard } from '../../../src/workflow/hsm-transition-guard.js';
import { decide } from '../../../src/workflow/decide/decide.js';
import { compileDecideDefinition } from '../../../src/workflow/decide/edges.js';
import { kernelOf, builtInDefinition } from '../../../src/workflow/definitions/built-in.js';
import { contentDigest } from '../../../src/contract/capsule/capsule-digest.js';
import { fixture, prepared, task, textOf } from '../../helpers/capsule/prepared-authority.js';
import { encodePreparedBundle } from '../../../src/contract/capsule/prepared-bundle.js';
import type { PreparedBundleV1 } from '../../../src/contract/capsule/prepared-bundle.js';
import { OperationDigestMismatchError, type DecideOnceContext, type DecideOnceDecision } from '../../../src/events/atomic-appender.js';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import * as stateStore from '../../../src/workflow/state-store.js';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { EventStore } from '../../../src/events/store.js';
import { handleEventAppend } from '../../../src/events/tools.js';
import type { ToolResult } from '../../../src/format.js';
import { VersionConflictError as BackendVersionConflictError } from '../../../src/storage/memory-backend.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { handleFinalizeOneshot } from '../../../src/verbs/tasks/finalize-oneshot.js';
import { handleRequestSynthesize } from '../../../src/verbs/team/request-synthesize.js';
import { flushLiveShadowEvidence, liveShadowEvidenceStreamId } from '../../../src/workflow/admission/live-shadow-observer.js';
import { allocatePhaseAttemptId } from '../../../src/workflow/phase-attempt-id.js';
import { getPlaybook } from '../../../src/workflow/playbooks.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../../../src/workflow/schemas.js';
import { registerWorkflowType, unregisterWorkflowType } from '../../../src/workflow/state-machine.js';
import { configureStateStoreBackend, readStateFile, writeStateFile } from '../../../src/workflow/state-store.js';
import { handleInit, handleSet, handleTransition } from '../../../src/workflow/tools.js';
import { transitionAdmissionCorpus } from './__fixtures__/transition-admission-corpus.js';
import { makeTempDir, rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/** One store of a case: the state directory, the SQLite backend of the state store and the event store. */
interface DecideStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
}

/** The feature id of most cases. Each case has its own store. */
const FEATURE_ID = 'set-decide';

/** The plan artifact of the seeds. */
const PLAN_ARTIFACT = 'plans/plan.md';

/** The prefix of the warning of a transition that the state document decided. */
const DOCUMENT_FALLBACK = 'GUARD_INPUT_DOCUMENT_FALLBACK: ';

/** The name of the custom type of one case. */
const CUSTOM_TYPE = 'set-decide-custom';

/** The six corpus fixtures where the legacy guard admits a fail-shaped state and the edge conditions deny it. */
const THE_SIX: readonly string[] = [
  'bypass-always-pass-implementation-ignores-fail-shaped-state',
  'bypass-empty-task-collection-is-complete',
  'debug-debug-implement-to-debug-validate-fail',
  'debug-hotfix-implement-to-hotfix-validate-fail',
  'debug-investigate-to-cancelled-fail',
  'refactor-polish-implement-to-polish-validate-fail',
];

/** The initial phase of each workflow type of the six. */
const INITIAL_PHASE: Readonly<Record<string, string>> = { feature: 'plan', debug: 'triage', refactor: 'explore' };

/** The row types of a committed move. */
const MOVE_ROW_TYPES: readonly string[] = ['workflow.transition', 'phase.exited', 'phase.entered'];

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await flushLiveShadowEvidence();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** Returns the value as a record, or an empty record when it is no plain object. */
function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

/** Opens a store on a new temporary directory and makes it the backend of the state store. */
async function openStore(): Promise<DecideStore> {
  const stateDir = makeTempDir('set-decide-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  releases.push(() => eventStore.close());
  configureStateStoreBackend(backend);
  return { stateDir, backend, eventStore };
}

/** Throws when a seed call does not succeed. */
function requireSuccess(step: string, result: ToolResult): void {
  if (result.success) return;
  throw new Error(`the seed step '${step}' failed with ${result.error?.code ?? 'no code'}: ${result.error?.message ?? 'no message'}`);
}

/** Starts a workflow. With `withStore` false, init gets no event store, so the stream holds no start row. */
async function init(store: DecideStore, featureId: string, workflowType = 'feature', withStore = true): Promise<void> {
  requireSuccess('init', await handleInit({ featureId, workflowType }, store.stateDir, withStore ? store.eventStore : null));
}

/** Updates fields through the handler, so the stream gets a `state.patched` row and the document gets the fields. */
async function update(store: DecideStore, featureId: string, updates: Record<string, unknown>): Promise<void> {
  requireSuccess(`update ${Object.keys(updates).join(', ')}`, await handleSet({ featureId, updates }, store.stateDir, store.eventStore));
}

/** Transitions through the handler and requires success. */
async function transition(store: DecideStore, featureId: string, phase: string): Promise<void> {
  requireSuccess(`transition ${phase}`, await handleSet({ featureId, phase }, store.stateDir, store.eventStore));
}

/** Appends one row with no document write. */
async function appendRow(store: DecideStore, featureId: string, type: string, data: Record<string, unknown>): Promise<void> {
  await store.eventStore.append(featureId, { type, data });
}

/** Returns the path of the state document of a feature. */
function stateFileOf(store: DecideStore, featureId: string): string {
  return path.join(store.stateDir, `${featureId}.state.json`);
}

/** Returns the state document of a feature as a record. */
async function documentOf(store: DecideStore, featureId: string): Promise<Record<string, unknown>> {
  return { ...(await readStateFile(stateFileOf(store, featureId))) };
}

/** Changes the state document only, with no row. */
async function forgeDocument(
  store: DecideStore,
  featureId: string,
  change: (document: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await writeStateFile(stateFileOf(store, featureId), change(await documentOf(store, featureId)));
}

/** Returns the rows of the stream of a feature. */
function rowsOf(store: DecideStore, featureId: string): Promise<WorkflowEvent[]> {
  return store.eventStore.query(featureId);
}

/** Returns the rows of one type of a list of rows. */
function rowsOfType(rows: readonly WorkflowEvent[], type: string): readonly WorkflowEvent[] {
  return rows.filter((row) => row.type === type);
}

/** Returns the phase of a result, or `undefined` when the result holds no phase. */
function phaseOf(result: ToolResult): unknown {
  return recordOf(result.data).phase;
}

/** Returns the data field of the last row of a type. */
function lastDataOf(rows: readonly WorkflowEvent[], type: string): Record<string, unknown> {
  return recordOf(rowsOfType(rows, type).at(-1)?.data);
}

/** Moves a feature to `plan-review` through the handlers, with the plan review approved. */
async function featureAtPlanReview(store: DecideStore, featureId = FEATURE_ID): Promise<void> {
  await init(store, featureId);
  await update(store, featureId, { 'artifacts.plan': PLAN_ARTIFACT });
  await transition(store, featureId, 'plan-review');
  await update(store, featureId, { planReview: { approved: true } });
}

/**
 * Moves a feature to `delegate`. Each completed id gets a `task.completed` row, and each other task stays pending.
 * Then the document marks each completed task complete, so the rows and the document agree.
 */
async function featureAtDelegate(
  store: DecideStore,
  tasks: readonly string[],
  completed: readonly string[],
  featureId = FEATURE_ID,
): Promise<void> {
  await featureAtPlanReview(store, featureId);
  await transition(store, featureId, 'delegate');
  await update(store, featureId, { tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: 'pending' })) });
  for (const taskId of completed) await appendRow(store, featureId, 'task.completed', { taskId });
  if (completed.length > 0) {
    const statusOf = (id: string): string => (completed.includes(id) ? 'complete' : 'pending');
    await update(store, featureId, { tasks: tasks.map((id) => ({ id, title: `task ${id}`, status: statusOf(id) })) });
  }
}

/** Makes the `setState` of the backend throw a version conflict on its first `failures` calls. Each later call runs the original. */
function failSetState(store: DecideStore, failures: number): void {
  const original = store.backend.setState.bind(store.backend);
  let calls = 0;
  const ownDescriptor = Object.getOwnPropertyDescriptor(store.backend, 'setState');
  Object.defineProperty(store.backend, 'setState', {
    configurable: true,
    writable: true,
    value: (featureId: string, state: Parameters<SqliteBackend['setState']>[1], expectedVersion?: number): void => {
      calls += 1;
      if (calls <= failures) throw new BackendVersionConflictError(featureId, expectedVersion ?? 0, (expectedVersion ?? 0) + 1);
      original(featureId, state, expectedVersion);
    },
  });
  releases.push(() => {
    if (ownDescriptor === undefined) Reflect.deleteProperty(store.backend, 'setState');
    else Object.defineProperty(store.backend, 'setState', ownDescriptor);
  });
}

/** Returns the gate names of the last `phase.entered` row of a phase. */
function enteredGatesOf(rows: readonly WorkflowEvent[], phase: string): readonly string[] {
  const entered = rowsOfType(rows, 'phase.entered').filter((row) => recordOf(row.data).phase === phase);
  const gates: unknown = recordOf(entered.at(-1)?.data).resolvedGates;
  if (!Array.isArray(gates)) return [];
  const list: readonly unknown[] = gates;
  return list.map((gate) => recordOf(gate).gate).filter((gate): gate is string => typeof gate === 'string');
}

/** Returns the rows that the admission live shadow wrote for a feature. */
function shadowRowsOf(store: DecideStore, featureId: string): Promise<WorkflowEvent[]> {
  return store.eventStore.query(liveShadowEvidenceStreamId(featureId));
}

describe('the transition handler decides on the ledger fold', () => {
  /** An `update` that writes a complete status for a task with no completion row does not admit the move. */
  it('HandleSet_AForgedTaskStatus_DoesNotAdmitDelegateToReview', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], []);
    await update(store, FEATURE_ID, { tasks: [{ id: 't1', title: 'task t1', status: 'complete' }] });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('delegate');
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rowsOfType(rows, 'workflow.transition').filter((row) => recordOf(row.data).to === 'review')).toEqual([]);
    expect(rowsOfType(rows, 'workflow.guard-failed')).toHaveLength(1);
  });

  /** A complete status inside the updates of the transition call is ignored, because the task rows give each status. */
  it('HandleSet_AStatusInsideTheSameUpdate_IsIgnored', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], []);

    const result = await handleSet(
      { featureId: FEATURE_ID, phase: 'review', updates: { tasks: [{ id: 't1', title: 'task t1', status: 'complete' }] } },
      store.stateDir,
      store.eventStore,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('delegate');
  });

  /** Each of the six corpus defects, with its state written as rows, denies on the live path and appends one guard-failed row. */
  it.each(
    transitionAdmissionCorpus.filter((fixture) => THE_SIX.includes(fixture.id)).map((fixture): [string, typeof fixture] => [fixture.id, fixture]),
  )('HandleSet_TheSixCorpusDefects_DenyOnTheLivePath %s', async (_id, fixture) => {
    const store = await openStore();
    await init(store, FEATURE_ID, fixture.workflowType);
    await appendRow(store, FEATURE_ID, 'workflow.transition', {
      from: INITIAL_PHASE[fixture.workflowType] ?? 'plan',
      to: fixture.from,
      trigger: 'test',
      featureId: FEATURE_ID,
    });
    const fields = Object.fromEntries(Object.entries(fixture.state).filter(([key]) => !key.startsWith('_')));
    if (Object.keys(fields).length > 0) {
      await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: Object.keys(fields), patch: fields });
    }
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, ...fields, phase: fixture.from }));
    const before = (await rowsOf(store, FEATURE_ID)).length;

    const result = await handleSet({ featureId: FEATURE_ID, phase: fixture.to }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe(fixture.from);
    const added = (await rowsOf(store, FEATURE_ID)).slice(before);
    expect(added.map((row) => row.type)).toEqual(['workflow.guard-failed']);
  });

  /** An honest `delegate -> review` with a completion row for each task admits, and commits the three rows of the move. */
  it('HandleSet_AnHonestDelegateToReview_Admits', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('review');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('review');
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rowsOfType(rows, 'workflow.transition').filter((row) => recordOf(row.data).to === 'review')).toHaveLength(1);
  });

  /** A target equal to the fold phase is idempotent. It levels the phase, the attempt id and the event sequence of a lagging document. */
  it('HandleSet_ATargetEqualToTheFoldPhase_IsIdempotent_AndLevelsTheDocument', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, phase: 'plan', phaseAttemptId: 'an-older-attempt', _eventSequence: 1 }));
    const rows = await rowsOf(store, FEATURE_ID);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).idempotent).toBe(true);
    expect(await rowsOf(store, FEATURE_ID)).toHaveLength(rows.length);
    const document = await documentOf(store, FEATURE_ID);
    expect(document.phase).toBe('plan-review');
    expect(document.phaseAttemptId).toBe(lastDataOf(rows, 'workflow.transition').phaseAttemptId);
    expect(document._eventSequence).toBe(rows.at(-1)?.sequence);
  });

  /** The source phase of a move is the fold phase. A document that lags at `plan` does not stop `plan-review -> delegate`. */
  it('HandleSet_ALaggingDocument_TakesTheSourcePhaseFromTheFold', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, phase: 'plan' }));

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('delegate');
    expect(lastDataOf(await rowsOf(store, FEATURE_ID), 'workflow.transition')).toMatchObject({ from: 'plan-review', to: 'delegate' });
  });

  /** The attempt id of a move comes from the fold phase, the fold attempt id and the stream version, not from a lagging document. */
  it('HandleSet_ALaggingDocument_TakesThePhaseAttemptIdFromTheFold', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, phase: 'plan', phaseAttemptId: 'an-older-attempt' }));
    const rows = await rowsOf(store, FEATURE_ID);
    const expected = allocatePhaseAttemptId(
      FEATURE_ID,
      'plan-review',
      'delegate',
      lastDataOf(rows, 'workflow.transition').phaseAttemptId,
      Math.max(...rows.map((row) => row.sequence)),
    );

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(recordOf(result.data).phaseAttemptId).toBe(expected);
    const after = await rowsOf(store, FEATURE_ID);
    expect(lastDataOf(after, 'workflow.transition').phaseAttemptId).toBe(expected);
    expect(lastDataOf(after, 'phase.entered')).not.toHaveProperty('phaseAttemptId');
  });

  /** The rows set the high tier and the document holds the low tier. The reviews pass only the low-tier gates, so the move denies. */
  it('HandleSet_ARiskTierThatOnlyTheDocumentHolds_GatesNothing', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await transition(store, FEATURE_ID, 'review');
    await update(store, FEATURE_ID, { riskTier: 'high', reviews: { review: { status: 'pass' } } });
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, riskTier: 'low' }));

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'synthesize' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('review');
  });

  /** Each fallback case decides with the legacy guard on the document, so a plan artifact in the document only admits, with one warning. */
  it.each([
    {
      name: 'no store',
      seed: async (store: DecideStore): Promise<void> => {
        await init(store, FEATURE_ID);
      },
      withStore: false,
    },
    {
      name: 'a document off the ledger',
      seed: async (store: DecideStore): Promise<void> => {
        await init(store, FEATURE_ID);
        await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, _esVersion: 1 }));
      },
      withStore: true,
    },
    {
      name: 'no start row',
      seed: async (store: DecideStore): Promise<void> => {
        await init(store, FEATURE_ID, 'feature', false);
      },
      withStore: true,
    },
  ].map((row): [string, typeof row] => [row.name, row]))('HandleSet_AFallbackCase_UsesTheLegacyPathWithAWarning %s', async (_name, row) => {
    const store = await openStore();
    await row.seed(store);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, artifacts: { ...recordOf(document.artifacts), plan: PLAN_ARTIFACT } }));

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, row.withStore ? store.eventStore : null);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]?.startsWith(DOCUMENT_FALLBACK)).toBe(true);
  });

  /** A row that the fold cannot apply refuses the call with `PROJECTION_REPLAY_FAILED`. The handler appends no row and writes no document. */
  it('HandleSet_AFoldError_RefusesProjectionReplayFailed', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await appendRow(store, FEATURE_ID, 'state.patched', {
      featureId: FEATURE_ID,
      fields: ['artifacts[0].x'],
      patch: { 'artifacts[0].x': 1 },
    });
    const before = (await rowsOf(store, FEATURE_ID)).length;

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('PROJECTION_REPLAY_FAILED');
    expect(await rowsOf(store, FEATURE_ID)).toHaveLength(before);
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('plan');
  });

  /** A denial of one of the six that the legacy guard admits takes the decide shape: the nest of each false agent fact. */
  it('HandleSet_ADenialOfTheSix_GivesTheDecideShape', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'debug');
    await appendRow(store, FEATURE_ID, 'workflow.transition', { from: 'triage', to: 'hotfix-implement', trigger: 'test', featureId: FEATURE_ID });
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, phase: 'hotfix-implement' }));

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'hotfix-validate' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.expectedShape).toEqual({ implementation: { complete: true } });
    expect(result.error?.suggestedFix).toBeUndefined();
  });

  /** A denial that the legacy guard shares keeps the legacy message, the legacy shape and the legacy fix. */
  it('HandleSet_ADenialThatTheLegacyGuardShares_KeepsTheLegacyShape', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], []);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.message).toContain('all-tasks-complete not satisfied');
    expect(result.error?.expectedShape).toEqual({ tasks: [{ id: '<task-id>', status: 'complete' }] });
    expect(result.error?.suggestedFix).toEqual({
      tool: 'exarchos_orchestrate',
      params: { action: 'task_complete', featureId: FEATURE_ID, taskId: 't1' },
    });
  });

  /** The rows set the high tier and the document holds the low tier. The move enters `review` with the gates of the high tier. */
  it('HandleSet_AMoveUnderALowerDocumentTier_EntersWithTheGatesOfTheFoldTier', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await update(store, FEATURE_ID, { riskTier: 'high', boundaryTouching: true });
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, riskTier: 'low', boundaryTouching: false }));

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    const rows = await rowsOf(store, FEATURE_ID);
    expect(enteredGatesOf(rows, 'review')).toContain('mutation-adequacy');
    expect(lastDataOf(rows, 'phase.entered').riskTier).toBe('high');
  });

  /** A guard failure of `handleTransition` carries the valid targets of the fold phase, not of a lagging document. */
  it('HandleTransition_ALaggingDocument_GivesTheValidTargetsOfTheFoldPhase', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], []);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, phase: 'plan-review' }));

    const result = await handleTransition({ featureId: FEATURE_ID, target: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(result.error?.validTargets).toEqual(['review', 'merge-pending', 'cancelled', 'completed']);
  });

  /** A live oneshot `synthesize -> completed` reads no cleanup evidence on the fold, so the explicit edge denies and no cleanup row lands. */
  it('HandleSet_OneshotSynthesizeToCompleted_DeniesOnTheFold', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'oneshot');
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await transition(store, FEATURE_ID, 'implementing');
    requireSuccess('request synthesize', await handleRequestSynthesize({ featureId: FEATURE_ID, stateDir: store.stateDir, eventStore: store.eventStore }));
    await transition(store, FEATURE_ID, 'synthesize');
    const before = (await rowsOf(store, FEATURE_ID)).length;

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'completed' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    const added = (await rowsOf(store, FEATURE_ID)).slice(before);
    expect(added.map((row) => row.type)).toEqual(['workflow.guard-failed']);
  });

  /** A document conflict after the own commit retries only the document write. The reply names the move, and the stream holds one trail. */
  it('HandleSet_ADocumentConflictAfterAnOwnCommit_RepliesWithTheMove', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    failSetState(store, 1);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
    expect(recordOf(result.data)).not.toHaveProperty('idempotent');
    expect((await documentOf(store, FEATURE_ID)).phase).toBe('plan-review');
    const rows = await rowsOf(store, FEATURE_ID);
    for (const type of MOVE_ROW_TYPES) expect(rowsOfType(rows, type), type).toHaveLength(1);
  });

  /** An admitted move still records one admission live-shadow attempt, which the legacy attempt writes to the real store. */
  it('HandleSet_AnAdmittedMove_StillFeedsTheAdmissionLiveShadow', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await flushLiveShadowEvidence();
    const before = (await shadowRowsOf(store, FEATURE_ID)).length;

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);
    await flushLiveShadowEvidence();

    expect(result.success).toBe(true);
    const added = (await shadowRowsOf(store, FEATURE_ID)).slice(before);
    expect(rowsOfType(added, 'admission.shadow-attempt')).toHaveLength(1);
  });

  /** An idempotent call reaches no guard verdict, so it records no admission live-shadow attempt. */
  it('HandleSet_AnIdempotentCall_RecordsNoLiveShadowAttempt', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    await flushLiveShadowEvidence();
    const before = (await shadowRowsOf(store, FEATURE_ID)).length;

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);
    await flushLiveShadowEvidence();

    expect(recordOf(result.data).idempotent).toBe(true);
    expect(await shadowRowsOf(store, FEATURE_ID)).toHaveLength(before);
  });

  /** A custom type of the config keeps the legacy append path with no warning. Its transition row holds the legacy idempotency key. */
  it('HandleSet_ACustomConfigType_KeepsTheLegacyPath', async () => {
    registerWorkflowType(CUSTOM_TYPE, {
      phases: ['plan', 'plan-review'],
      initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'plan-review', event: 'review' }],
    });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => {
      unextendWorkflowTypeEnum(CUSTOM_TYPE);
      unregisterWorkflowType(CUSTOM_TYPE);
    });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE);

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
    const moved = rowsOfType(await rowsOf(store, FEATURE_ID), 'workflow.transition');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.idempotencyKey).toBe(`${FEATURE_ID}:transition:plan:plan-review:1`);
  });

  /** `finalize_oneshot` picks its target on the fold. The document alone claims the `always` policy, so the rows pick `completed`. */
  it('FinalizeOneshot_ReadsTheFold_NotTheDocument', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'oneshot');
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await transition(store, FEATURE_ID, 'implementing');
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, oneshot: { ...recordOf(document.oneshot), synthesisPolicy: 'always' } }));

    const result = await handleFinalizeOneshot({ featureId: FEATURE_ID, stateDir: store.stateDir, eventStore: store.eventStore });

    expect(result.success).toBe(true);
    expect(recordOf(result.data).newPhase).toBe('completed');
  });

  /** Each playbook step whose edge needs the implementation fact tells the agent to write `implementation.complete`. */
  it('Playbooks_EachImplementationCompleteStep_NamesTheField', () => {
    const steps: readonly (readonly [string, string])[] = [
      ['debug', 'debug-implement'],
      ['debug', 'hotfix-implement'],
      ['refactor', 'polish-implement'],
    ];
    for (const [workflowType, phase] of steps) {
      expect(getPlaybook(workflowType, phase)?.compactGuidance, phase).toContain('set implementation.complete to true');
    }
  });

  /** A re-entry into `review` after a fix cycle and an update to a lower tier keeps each gate that the first entry froze. */
  it('HandleSet_AReEntryAfterAFixCycle_KeepsTheFrozenGates', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await update(store, FEATURE_ID, { riskTier: 'high', boundaryTouching: true });
    await transition(store, FEATURE_ID, 'review');
    const frozen = enteredGatesOf(await rowsOf(store, FEATURE_ID), 'review');
    await update(store, FEATURE_ID, { reviews: { review: { status: 'needs_fixes' } } });
    await transition(store, FEATURE_ID, 'delegate');
    await update(store, FEATURE_ID, { riskTier: 'low', boundaryTouching: false });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(frozen).toContain('mutation-adequacy');
    const reentered = enteredGatesOf(await rowsOf(store, FEATURE_ID), 'review');
    for (const gate of frozen) expect(reentered, gate).toContain(gate);
  });

  /** Forge route A stays open: an `update` that drops the pending task leaves only completed tasks, so the move admits. */
  it('HandleSet_AnUpdateThatDropsAPendingTask_AdmitsDelegateToReview', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1', 't2'], ['t1']);
    await update(store, FEATURE_ID, { tasks: [{ id: 't1', title: 'task t1', status: 'complete' }] });

    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('review');
  });

  /** Forge route B stays open: a generic append of a phase row sets the fold phase, and a transition to it levels the document. */
  it.each(['workflow.transition', 'workflow.cancel', 'workflow.cleanup'].map((type): [string] => [type]))(
    'HandleSet_AGenericPhaseRowAppend_SetsTheFoldPhase %s',
    async (type) => {
      const store = await openStore();
      await featureAtDelegate(store, ['t1'], []);
      requireSuccess(
        `append ${type}`,
        await handleEventAppend(
          { stream: FEATURE_ID, event: { type, data: { from: 'delegate', to: 'review', trigger: 'test', featureId: FEATURE_ID } } },
          store.stateDir,
          store.eventStore,
        ),
      );

      const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);

      expect(result.success).toBe(true);
      expect(recordOf(result.data).idempotent).toBe(true);
      expect((await documentOf(store, FEATURE_ID)).phase).toBe('review');
    },
  );
});


describe('complete document projection', () => {
  it('HandleSet_CombinedUpdates_CommitBeforeThePhaseInOneTransaction', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const before = (await rowsOf(store, FEATURE_ID)).length;
    failSetState(store, 1);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    const added = (await rowsOf(store, FEATURE_ID)).slice(before);
    expect(added.map((row) => row.type)).toEqual(['state.patched', 'workflow.transition', 'phase.exited', 'phase.entered']);
    expect(added[0]?.data).toMatchObject({ patch: { 'artifacts.plan': PLAN_ARTIFACT } });
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phase: 'plan-review', artifacts: { plan: PLAN_ARTIFACT }, _eventSequence: added.at(-1)?.sequence });
  });

  it('HandleSet_InvalidCombinedUpdates_CommitNothing', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const rows = await rowsOf(store, FEATURE_ID);
    const document = await documentOf(store, FEATURE_ID);
    await expect(handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT, 'integration.passed': 'invalid' } }, store.stateDir, store.eventStore)).resolves.toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(rows);
    expect(await documentOf(store, FEATURE_ID)).toEqual(document);
  });

  it('HandleSet_AFieldUpdateAfterAnUnlevelledMove_PreservesTheMove', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const old = await documentOf(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await transition(store, FEATURE_ID, 'plan-review');
    const current = await documentOf(store, FEATURE_ID);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...old, _version: document._version }));
    const before = (await rowsOf(store, FEATURE_ID)).length;
    await update(store, FEATURE_ID, { 'planReview.approved': true });
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rows.slice(before).map((row) => row.type)).toEqual(['state.patched']);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phase: 'plan-review', phaseAttemptId: current.phaseAttemptId,
      phaseObligation: current.phaseObligation, _eventSequence: rows.at(-1)?.sequence, artifacts: { plan: PLAN_ARTIFACT }, planReview: { approved: true } });
  });
});


describe('document synchronization races', () => {
  it('HandleSet_ARealSecondMoveDuringDocumentRetry_KeepsLatestProjection', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT, 'planReview.approved': true });
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    let later: Record<string, unknown> | undefined;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (...args) => {
      const rows = await query(...args);
      if (!fired && args[0] === FEATURE_ID && rows.some((row) => row.type === 'workflow.transition' && row.data?.to === 'plan-review')) {
        fired = true;
        await transition(store, FEATURE_ID, 'delegate');
        later = await documentOf(store, FEATURE_ID);
      }
      return rows;
    });
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(recordOf(result.data)).toMatchObject({ phase: 'plan-review' });
    expect(recordOf(result.data)).not.toHaveProperty('idempotent');
    const document = await documentOf(store, FEATURE_ID);
    expect(document).toMatchObject({ phase: 'delegate', phaseAttemptId: later?.phaseAttemptId, phaseObligation: later?.phaseObligation });
    expect(recordOf(document._checkpoint).phase).toBe('delegate');
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rows.filter((row) => MOVE_ROW_TYPES.includes(row.type)).map((row) => [row.type, row.data?.to ?? row.data?.phase])).toEqual([
      ['workflow.transition', 'plan-review'], ['phase.exited', 'plan'], ['phase.entered', 'plan-review'],
      ['workflow.transition', 'delegate'], ['phase.exited', 'plan-review'], ['phase.entered', 'delegate'],
    ]);
    expect(document._eventSequence).toBe(rows.at(-1)?.sequence);
  });

  it('HandleSet_ASamePhaseWithANewerAttempt_RepairsTheIdentity', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await transition(store, FEATURE_ID, 'review');
    const old = await documentOf(store, FEATURE_ID);
    await update(store, FEATURE_ID, { reviews: { bugbot: { passed: false } } });
    await transition(store, FEATURE_ID, 'delegate');
    await transition(store, FEATURE_ID, 'review');
    const current = await documentOf(store, FEATURE_ID);
    expect(current.phaseAttemptId).not.toBe(old.phaseAttemptId);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...old, _version: document._version }));
    const rows = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);
    expect(recordOf(result.data)).toMatchObject({ phase: 'review', phaseAttemptId: current.phaseAttemptId, idempotent: true });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(rows);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phaseAttemptId: current.phaseAttemptId, _eventSequence: rows.at(-1)?.sequence });
  });

  it('HandleSet_CombinedUpdates_AClaimHitDoesNotAppendAgain', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const query = store.eventStore.query.bind(store.eventStore);
    const input = { featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } };
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (...args) => {
      const rows = await query(...args);
      if (!fired && args[0] === FEATURE_ID) {
        fired = true;
        requireSuccess('inner combined', await handleSet(input, store.stateDir, store.eventStore));
      }
      return rows;
    });
    const result = await handleSet(input, store.stateDir, store.eventStore);
    expect(recordOf(result.data)).toMatchObject({ idempotent: true, phase: 'plan-review' });
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rows.filter((row) => row.type === 'state.patched')).toHaveLength(1);
    expect(rows.filter((row) => MOVE_ROW_TYPES.includes(row.type)).map((row) => row.type)).toEqual(MOVE_ROW_TYPES);
  });
});


describe('combined patch atomicity', () => {
  it('HandleSet_CombinedUpdates_ATransactionFailureCommitsNothing', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const before = await rowsOf(store, FEATURE_ID);
    const document = await documentOf(store, FEATURE_ID);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let attemptedTypes: readonly string[] = [];
    vi.spyOn(appender, 'decideOnce').mockImplementation(<TResult>(operationId: string, digest: string, closure: (tx: DecideOnceContext) => DecideOnceDecision<TResult>): Promise<TResult> =>
      original(operationId, digest, (tx) => {
        const decision = closure(tx);
        attemptedTypes = decision.events.map((row) => row.type);
        throw new Error('transaction fault');
      }));
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(attemptedTypes).toEqual(['state.patched', 'workflow.transition', 'phase.exited', 'phase.entered']);
    expect(result).toMatchObject({ success: false, error: { code: 'EVENT_APPEND_FAILED', message: expect.stringContaining('transaction fault') } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(await documentOf(store, FEATURE_ID)).toEqual(document);
  });

  it('HandleSet_CombinedUpdates_ADifferentPatchCannotReplayTheClaim', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (...args) => {
      const rows = await query(...args);
      if (!fired && args[0] === FEATURE_ID) {
        fired = true;
        requireSuccess('other patch', await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': 'other-plan.md' } }, store.stateDir, store.eventStore));
      }
      return rows;
    });
    await expect(handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore)).rejects.toBeInstanceOf(OperationDigestMismatchError);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ artifacts: { plan: 'other-plan.md' } });
    expect((await rowsOf(store, FEATURE_ID)).filter((row) => row.type === 'state.patched')).toHaveLength(1);
  });
});


describe('field patch ownership on retry', () => {
  it('HandleSet_AnIdenticalPatchClaim_ReplaysWithoutDuplicate', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const state = await documentOf(store, FEATURE_ID);
    const patch = { 'artifacts.plan': 'same.md' };
    await store.eventStore.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: ['artifacts.plan'], patch } },
      { idempotencyKey: `${FEATURE_ID}:patch:${state._version}:artifacts.plan` });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, updates: patch }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ artifacts: { plan: 'same.md' }, _eventSequence: before.at(-1)?.sequence });
  });

  it('HandleSet_ConcurrentSameFieldWithDifferentValues_PersistsBothPatches', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const append = store.eventStore.appendValidated.bind(store.eventStore);
    let fired = false;
    let inner: ToolResult | undefined;
    vi.spyOn(store.eventStore, 'appendValidated').mockImplementation(async (...args) => {
      if (!fired && args[1].type === 'state.patched') {
        fired = true;
        inner = await handleSet({ featureId: FEATURE_ID, updates: { 'artifacts.plan': 'inner.md' } }, store.stateDir, store.eventStore);
      }
      return append(...args);
    });
    const outer = await handleSet({ featureId: FEATURE_ID, updates: { 'artifacts.plan': 'outer.md' } }, store.stateDir, store.eventStore);
    expect(inner?.success).toBe(true);
    expect(outer.success).toBe(true);
    const patches = (await rowsOf(store, FEATURE_ID)).filter((row) => row.type === 'state.patched');
    expect(patches.map((row) => row.data?.patch)).toEqual([{ 'artifacts.plan': 'inner.md' }, { 'artifacts.plan': 'outer.md' }]);
    expect(patches[1]?.sequence).toBeGreaterThan(patches[0]?.sequence ?? 0);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ artifacts: { plan: 'outer.md' }, _eventSequence: patches[1]?.sequence });
  });

  it('HandleSet_AnOwnPatchBeforeALaterWriter_RetriesWithoutReplacingTheLaterValue', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    const append = store.eventStore.appendValidated.bind(store.eventStore);
    let ownPatch: WorkflowEvent | undefined;
    let later: ToolResult | undefined;
    let synchronized: ToolResult | undefined;
    let fired = false;
    vi.spyOn(store.eventStore, 'appendValidated').mockImplementation(async (...args) => {
      const event = await append(...args);
      if (!fired && args[1].type === 'state.patched') {
        fired = true;
        ownPatch = structuredClone((await rowsOf(store, FEATURE_ID)).find((row) => row.sequence === event.sequence));
        synchronized = await handleSet({ featureId: FEATURE_ID, phase: 'plan' }, store.stateDir, store.eventStore);
        later = await handleSet({ featureId: FEATURE_ID, updates: { 'artifacts.plan': 'later.md' } }, store.stateDir, store.eventStore);
      }
      return event;
    });
    const outer = await handleSet({ featureId: FEATURE_ID, updates: { 'artifacts.plan': 'own.md' } }, store.stateDir, store.eventStore);
    expect(synchronized?.success).toBe(true);
    expect(later?.success).toBe(true);
    expect(outer.success).toBe(true);
    const patches = (await rowsOf(store, FEATURE_ID)).filter((row) => row.type === 'state.patched');
    expect(patches.map((row) => row.data?.patch)).toEqual([{ 'artifacts.plan': 'own.md' }, { 'artifacts.plan': 'later.md' }]);
    expect(patches[0]).toEqual(ownPatch);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ artifacts: { plan: 'later.md' }, _eventSequence: patches[1]?.sequence });
  });
});

/** Captures exact persisted document text and every durable claim in this isolated database. */
function persistenceOf(store: DecideStore): { document: unknown; claims: unknown } {
  const db = new Database(path.join(store.stateDir, 'exarchos.db'));
  try {
    return {
      document: db.prepare('SELECT state FROM workflow_state WHERE featureId = ?').get(FEATURE_ID),
      claims: db.prepare('SELECT * FROM idempotency_claims ORDER BY streamId, idempotencyKey').all(),
    };
  } finally {
    db.close();
  }
}

/** Seeds agreeing valid tasks, then optionally clears only the ledger container. */
async function taskCandidateStore(clear = true): Promise<DecideStore> {
  const store = await openStore();
  await init(store, FEATURE_ID);
  await update(store, FEATURE_ID, { tasks: [{ id: 't1', title: 'old', status: 'pending' }] });
  if (clear) await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['tasks'], patch: { tasks: [] } });
  return store;
}

/** Resolves the existing patch key from the document version and raw field names. */
async function candidatePatchKey(store: DecideStore, patch: Record<string, unknown>): Promise<string> {
  return `${FEATURE_ID}:patch:${(await documentOf(store, FEATURE_ID))._version}:${Object.keys(patch).sort().join(',')}`;
}

describe('authoritative patch candidates', () => {
  it.each([
    ['HandleSet_CombinedDocumentValidLedgerInvalid_RefusesBeforeCommit', 'plan-review', true],
    ['HandleSet_InvalidCandidateBeforeDeniedMove_WritesNoDiagnostic', 'plan-review', false],
    ['HandleSet_FieldDocumentValidLedgerInvalid_RefusesBeforeAppend', undefined, false],
    ['HandleSet_SamePhaseInvalidPatch_RefusesBeforeAppend', 'plan', false],
  ])('HandleSet_AuthoritativeCandidateRefusal_WritesNothing %s', async (_name, phase, plan) => {
    const store = await taskCandidateStore();
    const before = await rowsOf(store, FEATURE_ID);
    const raw = persistenceOf(store);
    const result = await handleSet({ featureId: FEATURE_ID, ...(typeof phase === 'string' ? { phase } : {}),
      updates: { 'tasks[0].title': 'renamed', ...(plan ? { 'artifacts.plan': PLAN_ARTIFACT } : {}) } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(persistenceOf(store)).toEqual(raw);
  });

  it.each([undefined, 'plan-review'])('HandleSet_ARepairPatch_ValidatesAfterApplyingRawUpdates %s', async (phase) => {
    const store = await taskCandidateStore();
    await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['tasks[0].title'], patch: { 'tasks[0].title': 'partial' } });
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, customOperational: { retained: true },
      _compensationCheckpoint: { cancellationId: 'keep', completedActions: [], pendingActions: [], startedAt: '2026-01-01T00:00:00.000Z' } }));
    const before = await rowsOf(store, FEATURE_ID);
    const document = await documentOf(store, FEATURE_ID);
    const tasks = [{ id: 't2', title: 'repaired', status: 'pending' }];
    const result = await handleSet({ featureId: FEATURE_ID, phase, updates: { tasks, 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    const added = (await rowsOf(store, FEATURE_ID)).slice(before.length);
    expect(added.map((row) => row.type)).toEqual(phase ? ['state.patched', ...MOVE_ROW_TYPES] : ['state.patched']);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ tasks, customOperational: { retained: true }, _esVersion: document._esVersion,
      _version: Number(document._version) + 1, _compensationCheckpoint: document._compensationCheckpoint, _eventSequence: added.at(-1)?.sequence });
    expect(recordOf((await documentOf(store, FEATURE_ID))._checkpoint).summary).toEqual(recordOf(document._checkpoint).summary);
  });

  it.each([undefined, 'plan-review'])('HandleSet_AuthoritativeValidPatch_DoesNotUseStaleDocumentChildren %s', async (phase) => {
    const store = await taskCandidateStore(false);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, tasks: [] }));
    const result = await handleSet({ featureId: FEATURE_ID, phase, updates: { 'tasks[0].title': 'renamed', 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ tasks: [{ id: 't1', title: 'renamed', status: 'pending' }] });
  });

  it.each([undefined, 'plan-review'])('HandleSet_RawCandidateValidation_DoesNotUseGuardStatusOverlay %s', async (phase) => {
    const store = await taskCandidateStore(false);
    await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['tasks[0].status'], patch: { 'tasks[0].status': 'invalid' } });
    const before = await rowsOf(store, FEATURE_ID);
    const raw = persistenceOf(store);
    const result = await handleSet({ featureId: FEATURE_ID, phase, updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(persistenceOf(store)).toEqual(raw);
  });

  it('HandleSet_FieldCachedPatchWithChangedTail_ReplaysWithoutAppend', async () => {
    const store = await taskCandidateStore(false);
    const patch = { 'tasks[0].title': 'renamed' };
    const append = store.eventStore.appendValidated.bind(store.eventStore);
    let fired = false;
    let expected: number | undefined;
    vi.spyOn(store.eventStore, 'appendValidated').mockImplementation(async (...args) => {
      if (!fired && args[1].type === 'state.patched') {
        fired = true;
        expected = args[2]?.expectedSequence;
        await append(args[0], args[1], { idempotencyKey: args[2]?.idempotencyKey });
        await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['artifacts.plan'], patch: { 'artifacts.plan': 'later.md' } });
      }
      return append(...args);
    });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, updates: patch }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(expected).toBe(before.at(-1)?.sequence);
    const after = await rowsOf(store, FEATURE_ID);
    expect(after.slice(before.length)).toHaveLength(2);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ tasks: [{ id: 't1', title: 'renamed', status: 'pending' }], artifacts: { plan: 'later.md' }, _eventSequence: after.at(-1)?.sequence });
  });

  it.each([true, false])('HandleSet_FieldCachedPatchAfterTaskRemoval_DoesNotReapplyIt %s', async (claim) => {
    const store = await taskCandidateStore(false);
    const patch = { 'tasks[0].title': 'renamed' };
    const key = await candidatePatchKey(store, patch);
    await store.eventStore.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: Object.keys(patch), patch } }, { idempotencyKey: key });
    if (!claim) {
      const db = new Database(path.join(store.stateDir, 'exarchos.db'));
      db.prepare('DELETE FROM idempotency_claims WHERE streamId = ? AND idempotencyKey = ?').run(FEATURE_ID, key);
      db.close();
    }
    await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['tasks'], patch: { tasks: [] } });
    const before = await rowsOf(store, FEATURE_ID);
    const raw = persistenceOf(store);
    const result = await handleSet({ featureId: FEATURE_ID, updates: patch }, store.stateDir, store.eventStore);
    expect(result.success).toBe(claim);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    if (claim) expect(await documentOf(store, FEATURE_ID)).toMatchObject({ tasks: [], _eventSequence: before.at(-1)?.sequence });
    else {
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(persistenceOf(store)).toEqual(raw);
    }
  });

  it('HandleSet_FieldClaimArrivesDuringInvalidPreflight_ReplaysStoredPatch', async () => {
    const store = await taskCandidateStore(false);
    const patch = { 'tasks[0].title': 'renamed' };
    const key = await candidatePatchKey(store, patch);
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (...args) => {
      if (!fired && args[0] === FEATURE_ID) {
        fired = true;
        await store.eventStore.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: Object.keys(patch), patch } }, { idempotencyKey: key });
        await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['tasks'], patch: { tasks: [] } });
      }
      return query(...args);
    });
    const lookup = vi.spyOn(store.eventStore.getAppender().ensureSqliteBackendSync(), 'lookupIdempotencyClaim');
    const before = (await query(FEATURE_ID)).length;
    const result = await handleSet({ featureId: FEATURE_ID, updates: patch }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(lookup.mock.results[0]?.value).toBeUndefined();
    expect(lookup.mock.results.some((entry) => entry.value !== undefined)).toBe(true);
    const after = await query(FEATURE_ID);
    expect(after.slice(before)).toHaveLength(2);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ tasks: [], _eventSequence: after.at(-1)?.sequence });
  });

  it.each([[undefined, undefined], [undefined, {}], ['plan', undefined], ['plan', {}]])('HandleSet_EmptyUpdates_PreserveNoPatchBehavior %s %s', async (phase, updates) => {
    const store = await taskCandidateStore(false);
    const before = await rowsOf(store, FEATURE_ID);
    const raw = persistenceOf(store);
    const result = await handleSet({ featureId: FEATURE_ID, ...(typeof phase === 'string' ? { phase } : {}), ...(typeof updates === 'object' ? { updates } : {}) }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(persistenceOf(store).claims).toEqual(raw.claims);
    if (phase === 'plan' && updates === undefined) expect(persistenceOf(store)).toEqual(raw);
  });

  it.each([
    ['HandleSet_FieldInitialClaimReadFault_ReturnsAppendFailureWithoutWrites', 'initial', 'EVENT_APPEND_FAILED'],
    ['HandleSet_FieldRefusalClaimReadFault_ReturnsAppendFailureWithoutWrites', 'recheck', 'EVENT_APPEND_FAILED'],
    ['HandleSet_FieldStreamReadFault_ReturnsProjectionFailureWithoutWrites', 'query', 'PROJECTION_REPLAY_FAILED'],
    ['HandleSet_FieldReplayFault_ReturnsProjectionFailureWithoutWrites', 'fold', 'PROJECTION_REPLAY_FAILED'],
  ])('HandleSet_AuthoritativeCandidateFault_WritesNothing %s', async (_name, fault, code) => {
    const store = await taskCandidateStore(fault === 'recheck');
    const before = await rowsOf(store, FEATURE_ID);
    const raw = persistenceOf(store);
    const claimBackend = store.eventStore.getAppender().ensureSqliteBackendSync();
    const lookup = claimBackend.lookupIdempotencyClaim.bind(claimBackend);
    let calls = 0;
    const claimSpy = vi.spyOn(store.eventStore.getAppender().ensureSqliteBackendSync(), 'lookupIdempotencyClaim').mockImplementation((...args) => {
      calls++;
      if ((fault === 'initial' && calls === 1) || (fault === 'recheck' && calls === 2)) throw new Error('claim read fault');
      return lookup(...args);
    });
    if (fault === 'query') vi.spyOn(store.eventStore, 'query').mockRejectedValueOnce(new Error('query fault'));
    if (fault === 'fold') vi.spyOn(stateStore, 'projectStateDocument').mockImplementationOnce(() => { throw new Error('projection fault'); });
    const result = await handleSet({ featureId: FEATURE_ID, updates: { 'tasks[0].title': 'renamed' } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code } });
    expect(calls).toBe(fault === 'recheck' ? 2 : 1);
    claimSpy.mockRestore();
    vi.restoreAllMocks();
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(persistenceOf(store)).toEqual(raw);
  });

  it('HandleSet_NoStartHeldPatchClaim_PreservesLegacyDocumentRoute', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await forgeDocument(store, FEATURE_ID, (document) => ({ ...document, _esVersion: 2 }));
    const patch = { 'artifacts.plan': PLAN_ARTIFACT };
    await store.eventStore.append(FEATURE_ID, { type: 'state.patched', data: { featureId: FEATURE_ID, fields: Object.keys(patch), patch } }, { idempotencyKey: await candidatePatchKey(store, patch) });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, updates: patch }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ artifacts: { plan: PLAN_ARTIFACT } });
  });
});

/** Stores immutable custody and a complete prepared envelope in the real ledger. */
async function pinPlan(store: DecideStore, ids: string[], changes?: (bundle: PreparedBundleV1) => PreparedBundleV1): Promise<void> {
  const original = fixture(textOf(ids.map(id => task(id))));
  let bundle = { ...original, capsule: { ...original.capsule, identity: { ...original.capsule.identity, workflowId: FEATURE_ID } } };
  if (changes) bundle = changes(bundle);
  const digest = await store.eventStore.bundleStore.put(encodePreparedBundle(bundle));
  const event = prepared(bundle);
  await store.eventStore.append(FEATURE_ID, { ...event, streamId: FEATURE_ID,
    operationId: 'prepare-operation-1', correlationId: 'prepare-correlation-1', causationId: 'prepare-parent-1',
    data: { ...event.data, workflowType: bundle.definition.name.replace(/^exarchos\./, ''), bundleRefs: [{ artifactId: 'run-bundle:fixture', digest }] } });
}

describe('prepared transition authority', () => {
  it.each([false, true])('PinnedWholePlan_DroppedPendingTaskDenies_Combined_%s', async combined => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1', 't2'], ['t1']);
    await pinPlan(store, ['t1', 't2']);
    const updates = { tasks: [{ id: 't1', title: 'task t1', status: 'complete' }] };
    if (!combined) await update(store, FEATURE_ID, updates);
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', ...(combined ? { updates } : {}) }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    const added = (await rowsOf(store, FEATURE_ID)).slice(before.length);
    expect(added.filter(row => ['workflow.transition', 'state.patched'].includes(row.type))).toEqual([]);
    await appendRow(store, FEATURE_ID, 'task.completed', { taskId: 't2' });
    expect((await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore)).success).toBe(true);
  });

  it('PinnedMetadata_UnchangedAuthorityLoadsOnce_AndCommitsOnce', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    let inside = false;
    const resolver = store.eventStore.bundleStore.resolve.bind(store.eventStore.bundleStore);
    const resolve = vi.spyOn(store.eventStore.bundleStore, 'resolve').mockImplementation((...args) => {
      expect(inside).toBe(false);
      return resolver(...args);
    });
    const appender = store.eventStore.getAppender();
    const commit = appender.decideOnce.bind(appender);
    const decideOnce = vi.spyOn(appender, 'decideOnce').mockImplementation((id, digest, closure) => commit(id, digest, tx => {
      inside = true;
      try { return closure(tx); } finally { inside = false; }
    }));
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(decideOnce).toHaveBeenCalledTimes(1);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition' && row.data?.to === 'review')).toHaveLength(1);
  });

  it('PinnedAuthority_NewerSameEdgeWithPendingTask_ReloadsAndDenies', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let fired = false;
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (!fired) {
        fired = true;
        await pinPlan(store, ['t1', 't2']);
      }
      return original(id, digest, closure);
    });
    const resolve = vi.spyOn(store.eventStore.bundleStore, 'resolve');
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { tasks: [] } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('GUARD_FAILED');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition' && row.data?.to === 'review')).toHaveLength(0);
  });

  it.each(['task.failed', 'task.completed'])('PinnedAuthority_FreshCompletionRows_%s', async type => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let fired = false;
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (!fired) { fired = true; await appendRow(store, FEATURE_ID, type, { taskId: 't1' }); }
      return original(id, digest, closure);
    });
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);
    expect(result.success).toBe(type === 'task.completed');
  });

  it('PinnedAuthority_CustodyFailureRefusesWithoutPatch', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('missing custody'));
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { tasks: [] } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
  });
});

describe('prepared transition policy and retries', () => {
  it('PinnedPolicy_EmptySkipsIgnoreNewConfig', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT });
    await pinPlan(store, ['t1']);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore, { skipPhases: ['plan-review'] });
    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('plan-review');
  });

  it('PinnedUserDefinition_PrecedesBuiltInTypeDiscriminator', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1'], bundle => {
      const definition = { ...bundle.definition, name: 'local-pinned' };
      return { ...bundle, definition, capsule: { ...bundle.capsule, identity: { ...bundle.capsule.identity,
        definitionVersion: contentDigest(definition) } } };
    });
    const rows = await rowsOf(store, FEATURE_ID);
    const preparedRow = rows.at(-1)!;
    await store.eventStore.append(FEATURE_ID, { ...preparedRow, data: { ...preparedRow.data, workflowType: 'local-pinned' } });
    extendWorkflowTypeEnum('local-pinned');
    releases.push(() => unextendWorkflowTypeEnum('local-pinned'));
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, workflowType: 'local-pinned' }));
    expect((await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore)).success).toBe(true);
  });

  it.each([false, true])('PinnedClaim_WinnerBeforeCustodyFailure_Replays_%s', late => {
    return (async () => {
      const store = await openStore();
      await featureAtDelegate(store, ['t1'], ['t1']);
      await pinPlan(store, ['t1']);
      const input = { featureId: FEATURE_ID, phase: 'review', updates: { 'artifacts.plan': 'accepted.md' } };
      const originalQuery = store.eventStore.query.bind(store.eventStore);
      const appender = store.eventStore.getAppender();
      const original = appender.decideOnce.bind(appender);
      let fired = false;
      let loserClosures = 0;
      const winner = async () => {
        fired = true;
        requireSuccess('winner', await handleSet(input, store.stateDir, store.eventStore));
        await update(store, FEATURE_ID, { tasks: [] });
        vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('removed after winner'));
      };
      if (!late) vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
        const rows = await originalQuery(id, filters);
        if (!fired && id === FEATURE_ID) await winner();
        return rows;
      });
      else vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
        if (!fired) { await winner(); return original(id, digest, tx => { loserClosures++; return closure(tx); }); }
        return original(id, digest, closure);
      });
      const result = await handleSet(input, store.stateDir, store.eventStore);
      expect(result).toMatchObject({ success: true, data: { idempotent: true } });
      expect(loserClosures).toBe(0);
      expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition' && row.data?.to === 'review')).toHaveLength(1);
      expect((await documentOf(store, FEATURE_ID)).tasks).toEqual([]);
    })();
  });

  it('PinnedOwnMove_DocumentRepairDoesNotReloadMissingCustody', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const original = store.backend.setState.bind(store.backend);
    let failed = false;
    vi.spyOn(store.backend, 'setState').mockImplementation((id, state, version) => {
      if (!failed) {
        failed = true;
        vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('removed after commit'));
        throw new BackendVersionConflictError(id, version ?? 0, (version ?? 0) + 1);
      }
      return original(id, state, version);
    });
    expect((await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore)).success).toBe(true);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition' && row.data?.to === 'review')).toHaveLength(1);
  });

  it('PinnedCompletionProperty_DocumentMembershipAndForgedStatusCannotCompleteMissingIds', async () => {
    for (const documents of [[], ['t1'], ['t2'], ['t2', 't1'], ['unknown']]) {
      for (const trace of [[], ['task.completed'], ['task.completed', 'task.failed'], ['task.completed', 'task.failed', 'task.completed']]) {
        const store = await openStore();
        await featureAtDelegate(store, ['t1', 't2'], ['t1']);
        await pinPlan(store, ['t1', 't2']);
        for (const type of trace) await appendRow(store, FEATURE_ID, type, { taskId: 't2' });
        const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: {
          tasks: documents.map(id => ({ id, title: id, status: 'complete' })),
        } }, store.stateDir, store.eventStore);
        expect(result.success, JSON.stringify({ documents, trace })).toBe(trace.at(-1) === 'task.completed');
      }
    }
  });
});

describe('prepared transition failure boundaries', () => {
  it('PinnedType_DocumentTypeCannotChangeEntryPolicy', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    extendWorkflowTypeEnum('forged-type');
    releases.push(() => unextendWorkflowTypeEnum('forged-type'));
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, workflowType: 'forged-type' }));
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review' }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    expect(enteredGatesOf(await rowsOf(store, FEATURE_ID), 'review')).toEqual(['review']);
  });

  it('PinnedAuthority_ChangedEveryPass_ExhaustsWithoutMoveOrPatch', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      await pinPlan(store, ['t1']);
      return original(id, digest, closure);
    });
    const before = await rowsOf(store, FEATURE_ID);
    await expect(handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { tasks: [] } }, store.stateDir, store.eventStore)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await rowsOf(store, FEATURE_ID)).slice(before.length).map(row => row.type)).toEqual(Array(4).fill('workflow.prepared'));
  });

  it('PinnedClaim_WinnerDuringFailedCustody_RechecksActualClaim', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const input = { featureId: FEATURE_ID, phase: 'review', updates: { 'artifacts.plan': 'accepted.md' } };
    const resolve = store.eventStore.bundleStore.resolve.bind(store.eventStore.bundleStore);
    let fired = false;
    vi.spyOn(store.eventStore.bundleStore, 'resolve').mockImplementation(async (...args) => {
      if (fired) return resolve(...args);
      fired = true;
      requireSuccess('winner', await handleSet(input, store.stateDir, store.eventStore));
      await update(store, FEATURE_ID, { tasks: [] });
      throw new Error('custody disappeared during preflight');
    });
    expect(await handleSet(input, store.stateDir, store.eventStore)).toMatchObject({ success: true, data: { idempotent: true } });
  });

  it('PinnedRawCandidate_InvalidIndexCannotBeSanitizedByMembership', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { 'tasks[2].status': 'complete' } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
  });
});

/** Historical kernel pins retain the built-in operator policy without typed membership authority. */
describe('kernel operator compatibility', () => {
  it.each([false, true])('LegacyKernel_BuiltInOperatorUsesCurrentSkips_%s', skip => {
    return (async () => {
      const store = await openStore();
      await init(store, FEATURE_ID);
      await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT, planReview: { approved: true } });
      await pinPlan(store, ['t1'], bundle => {
        const definition = WorkflowDefinitionV1Schema.parse(kernelOf(builtInDefinition('feature')));
        const { designRecord: _record, ...legacy } = bundle;
        return { ...legacy, definition, capsule: { ...legacy.capsule,
          identity: { ...legacy.capsule.identity, definitionVersion: contentDigest(definition) },
          provenance: { ...legacy.capsule.provenance, compilerVersion: 'exarchos-prepare-5' } } };
      });
      const result = await handleSet({ featureId: FEATURE_ID, phase: skip ? 'delegate' : 'plan-review' }, store.stateDir, store.eventStore,
        { skipPhases: skip ? ['plan-review'] : [] });
      expect(result.success).toBe(true);
      expect(phaseOf(result)).toBe(skip ? 'delegate' : 'plan-review');
    })();
  });
});

/** Frozen policy controls both edge selection and final-target behavior. */
describe('frozen transition policy', () => {
  it('PinnedOrderedSkips_OverrideCurrentConfig', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID);
    await update(store, FEATURE_ID, { 'artifacts.plan': PLAN_ARTIFACT, planReview: { approved: true } });
    await pinPlan(store, ['t1'], bundle => ({ ...bundle, capsule: { ...bundle.capsule,
      settlementContract: { ...bundle.capsule.settlementContract, skipPhases: ['unknown', 'plan-review', 'plan-review', 'unknown'] } } }));
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore, { skipPhases: [] });
    expect(result.success).toBe(true);
    expect(phaseOf(result)).toBe('delegate');
  });

  it('PinnedPendingTasks_DoNotBlockUniversalCancel', () => {
    const definition = compileDecideDefinition('feature', builtInDefinition('feature'));
    expect(decide(definition, { phase: 'delegate', tasks: [{ id: 't1', status: 'pending' }] }, { kind: 'cancel' }).kind).toBe('admit');
  });
});

/** Kernel fixtures use the historical registry and document route. */
async function pinKernel(store: DecideStore, workflowType = 'feature'): Promise<void> {
  await pinPlan(store, ['t1'], bundle => {
    const definition = { ...WorkflowDefinitionV1Schema.parse(kernelOf(builtInDefinition('feature'))), name: workflowType };
    const { designRecord: _record, ...legacy } = bundle;
    return { ...legacy, definition, capsule: { ...legacy.capsule,
      identity: { ...legacy.capsule.identity, definitionVersion: contentDigest(definition) },
      provenance: { ...legacy.capsule.provenance, compilerVersion: 'exarchos-prepare-5' } } };
  });
}

describe('historical document kernel commits', () => {
  it('KernelCustom_CombinedPatchAndTrailCommitOnce', async () => {
    registerWorkflowType(CUSTOM_TYPE, { phases: ['plan', 'plan-review'], initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'plan-review', event: 'review' }] });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE);
    await pinKernel(store, CUSTOM_TYPE);
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': 'custom.md' } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    const added = (await rowsOf(store, FEATURE_ID)).slice(before.length);
    expect(added.filter(row => row.type === 'state.patched')).toHaveLength(1);
    expect(added.filter(row => row.type === 'workflow.transition')).toHaveLength(1);
    expect(lastDataOf(added, 'workflow.transition').phaseAttemptId).toEqual(expect.any(String));
    expect((await documentOf(store, FEATURE_ID))._eventSequence).toBe((await rowsOf(store, FEATURE_ID)).at(-1)?.sequence);
  });

  it('KernelNoStart_CombinedCommitAndCASRepairUseIncrementalRows', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    failSetState(store, 1);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(true);
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rows.some(row => row.type === 'workflow.started')).toBe(false);
    expect(rows.filter(row => row.type === 'state.patched')).toHaveLength(1);
    expect(rows.filter(row => row.type === 'workflow.transition')).toHaveLength(1);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phase: 'plan-review', _eventSequence: rows.at(-1)?.sequence });
  });

  it('KernelNoStart_AheadCursorRefusesBeforeCommit', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, _eventSequence: 999 }));
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition')).toHaveLength(0);
  });
});

describe('legacy kernel transaction fences', () => {
  it('LegacyKernelPin_StaleDocument_RefusesObsoleteSourceAndContinuesFromLedger', async () => {
    registerWorkflowType(CUSTOM_TYPE, {
      phases: ['plan', 'plan-review', 'delegate', 'review'], initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'plan-review', event: 'obsolete' },
        { from: 'plan', to: 'delegate', event: 'delegate' },
        { from: 'delegate', to: 'review', event: 'review' }],
    });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE, false);
    await pinKernel(store, CUSTOM_TYPE);
    await forgeDocument(store, FEATURE_ID, document => ({
      ...document, phase: 'plan', phaseAttemptId: 'stale-plan', notes: { items: {} },
    }));
    const raw = await documentOf(store, FEATURE_ID);
    failSetState(store, 4);
    await expect(handleSet({ featureId: FEATURE_ID, phase: 'delegate', updates: { 'notes.items': [] } },
      store.stateDir, store.eventStore)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const before = await rowsOf(store, FEATURE_ID);
    const predecessor = allocatePhaseAttemptId(FEATURE_ID, 'plan', 'delegate', 'stale-plan', 0);
    expect(lastDataOf(before, 'workflow.transition')).toMatchObject({
      from: 'plan', to: 'delegate', phaseAttemptId: predecessor,
    });
    expect(await documentOf(store, FEATURE_ID)).toEqual(raw);
    expect(before.some(row => row.type === 'workflow.started')).toBe(false);
    const obsolete = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'notes.obsolete': true } },
      store.stateDir, store.eventStore);
    expect(obsolete).toMatchObject({ success: false, error: {
      code: 'INVALID_TRANSITION', message: "No transition from 'delegate' to 'plan-review'", validTargets: expect.arrayContaining([{ phase: 'review' }]),
    } });
    expect(await documentOf(store, FEATURE_ID)).toEqual(raw);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);

    const appender = store.eventStore.getAppender();
    const commit = appender.decideOnce.bind(appender);
    const operationIds: string[] = [];
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      operationIds.push(id);
      if (operationIds.length === 1) {
        await appendRow(store, FEATURE_ID, 'workflow.transition', {
          featureId: FEATURE_ID, from: 'delegate', to: 'delegate', trigger: 'concurrent-cycle', phaseAttemptId: 'later-delegate',
        });
      }
      return commit(id, digest, closure);
    });
    const patch = { 'notes.items[0].value': 'accepted' };
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: patch },
      store.stateDir, store.eventStore);
    const staleAttempt = allocatePhaseAttemptId(FEATURE_ID, 'delegate', 'review', predecessor, 0);
    const attempt = allocatePhaseAttemptId(FEATURE_ID, 'delegate', 'review', 'later-delegate', 0);
    expect(result).toMatchObject({ success: true, data: { phase: 'review', phaseAttemptId: attempt } });
    expect(operationIds).toEqual([staleAttempt, attempt].map(id => `transition:${FEATURE_ID}:${id}`));
    expect(store.backend.lookupOperationClaim(operationIds[0]!)).toBeUndefined();
    expect(store.backend.lookupOperationClaim(operationIds[1]!)).toBeDefined();
    const rows = await rowsOf(store, FEATURE_ID);
    const added = rows.slice(before.length);
    expect(rowsOfType(added, 'state.patched').map(row => row.data?.patch)).toEqual([patch]);
    expect(rowsOfType(added, 'workflow.transition').map(row => row.data)).toEqual([
      expect.objectContaining({ from: 'delegate', to: 'delegate', phaseAttemptId: 'later-delegate' }),
      expect.objectContaining({ from: 'delegate', to: 'review', phaseAttemptId: attempt }),
    ]);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({
      phase: 'review', phaseAttemptId: attempt, notes: { items: [{ value: 'accepted' }] }, _eventSequence: rows.at(-1)?.sequence,
    });
  });
  it('LegacyKernelPin_ProjectedKeyWinner_ReplaysBeforeGuard', async () => {
    registerWorkflowType(CUSTOM_TYPE, {
      phases: ['plan', 'delegate', 'review'], initialPhase: 'plan',
      transitions: [{ from: 'delegate', to: 'review', event: 'review' }],
    });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE, false);
    await pinKernel(store, CUSTOM_TYPE);
    await appendRow(store, FEATURE_ID, 'workflow.transition', {
      featureId: FEATURE_ID, from: 'plan', to: 'delegate', trigger: 'seed', phaseAttemptId: 'delegate-source',
    });
    const input = { featureId: FEATURE_ID, phase: 'review', updates: { 'notes.winner': true } };
    const bundles = store.eventStore.bundleStore;
    const resolve = bundles.resolve.bind(bundles);
    const guard = vi.spyOn(hsmTransitionGuard, 'attempt');
    let won = false;
    vi.spyOn(bundles, 'resolve').mockImplementationOnce(async (...args) => {
      const custody = await resolve(...args);
      requireSuccess('winner at projected key', await handleSet(input, store.stateDir, store.eventStore));
      won = true;
      await appendRow(store, FEATURE_ID, 'state.patched', {
        featureId: FEATURE_ID, fields: ['notes.later'], patch: { 'notes.later': true },
      });
      return custody;
    });
    const result = await handleSet(input, store.stateDir, store.eventStore);
    const attempt = allocatePhaseAttemptId(FEATURE_ID, 'delegate', 'review', 'delegate-source', 0);
    expect(won).toBe(true);
    expect(result).toMatchObject({ success: true, data: { phase: 'review', phaseAttemptId: attempt, idempotent: true } });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(store.backend.lookupOperationClaim(`transition:${FEATURE_ID}:${attempt}`)).toBeDefined();
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rowsOfType(rows, 'state.patched').map(row => row.data?.patch)).toEqual([input.updates, { 'notes.later': true }]);
    expect(rowsOfType(rows, 'workflow.transition')).toHaveLength(2);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({
      phase: 'review', phaseAttemptId: attempt, notes: { winner: true, later: true }, _eventSequence: rows.at(-1)?.sequence,
    });
  });

  it('LegacyKernelPin_PatchCommittedBeforeCasRetry_IsNotAppendedAgain', async () => {
    registerWorkflowType(CUSTOM_TYPE, {
      phases: ['plan', 'delegate'], initialPhase: 'plan',
      transitions: [{ from: 'delegate', to: 'plan', event: 'return' }],
    });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE, false);
    await pinKernel(store, CUSTOM_TYPE);
    const set = store.backend.setState.bind(store.backend);
    vi.spyOn(store.backend, 'setState').mockImplementationOnce((id, state, version) => {
      const next = store.backend.getSequence(FEATURE_ID) + 1;
      store.backend.appendEvent(FEATURE_ID, {
        streamId: FEATURE_ID, sequence: next, type: 'workflow.transition', schemaVersion: '1.0',
        timestamp: '2026-11-13T12:00:00.000Z',
        data: { from: 'plan', to: 'delegate', trigger: 'concurrent', phaseAttemptId: 'delegate-source' },
      });
      store.backend.appendEvent(FEATURE_ID, {
        streamId: FEATURE_ID, sequence: next + 1, type: 'state.patched', schemaVersion: '1.0',
        timestamp: '2026-11-13T12:00:01.000Z', data: { patch: { 'notes.status': 'later' } },
      });
      set(id, { ...state, _version: (version ?? 0) + 1 }, version);
      return set(id, state, version);
    });

    const patch = { 'notes.status': 'accepted' };
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan', updates: patch }, store.stateDir, store.eventStore);
    const attempt = allocatePhaseAttemptId(FEATURE_ID, 'delegate', 'plan', 'delegate-source', 0);
    expect(result).toMatchObject({ success: true, data: { phase: 'plan', phaseAttemptId: attempt } });
    const rows = await rowsOf(store, FEATURE_ID);
    expect(rowsOfType(rows, 'state.patched').map(row => row.data?.patch)).toEqual([patch, { 'notes.status': 'later' }]);
    expect(rowsOfType(rows, 'workflow.transition').map(row => row.data)).toEqual([
      expect.objectContaining({ from: 'plan', to: 'delegate', phaseAttemptId: 'delegate-source' }),
      expect.objectContaining({ from: 'delegate', to: 'plan', phaseAttemptId: attempt }),
    ]);
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({
      phase: 'plan', phaseAttemptId: attempt, notes: { status: 'later' }, _eventSequence: rows.at(-1)?.sequence,
    });
  });

  it('KernelCustom_NewerTypedPinAtCommit_DeniesWithoutOldTrail', async () => {
    registerWorkflowType(CUSTOM_TYPE, { phases: ['delegate', 'review'], initialPhase: 'delegate',
      transitions: [{ from: 'delegate', to: 'review', event: 'review' }] });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE);
    await appendRow(store, FEATURE_ID, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan', to: 'delegate', trigger: 'seed', phaseAttemptId: 'delegate-source' });
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, phase: 'delegate', phaseAttemptId: 'delegate-source' }));
    await pinKernel(store, CUSTOM_TYPE);
    const appender = store.eventStore.getAppender();
    const commit = appender.decideOnce.bind(appender);
    let fired = false;
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (!fired) {
        fired = true;
        await pinPlan(store, ['t1'], bundle => {
          const definition = { ...bundle.definition, name: CUSTOM_TYPE };
          return { ...bundle, definition, capsule: { ...bundle.capsule,
            identity: { ...bundle.capsule.identity, definitionVersion: contentDigest(definition) } } };
        });
      }
      return commit(id, digest, closure);
    });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { 'artifacts.plan': 'loser.md' } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'GUARD_FAILED' } });
    expect((await rowsOf(store, FEATURE_ID)).slice(before.length).filter(row => row.type === 'state.patched' || row.type === 'workflow.transition')).toEqual([]);
  });

  it('KernelNoStart_IncrementalRepairDoesNotRepeatRevisionCounts', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    await appendRow(store, FEATURE_ID, 'workflow.plan-revision', { featureId: FEATURE_ID, count: 1 });
    const cursor = (await rowsOf(store, FEATURE_ID)).at(-1)!.sequence;
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, planReview: { revisionCount: 1 }, _eventSequence: cursor,
      _checkpoint: { ...recordOf(document._checkpoint), summary: 'keep summary', staleAfterMinutes: 77 },
      _compensationCheckpoint: { completedActions: ['keep-action'] } }));
    await appendRow(store, FEATURE_ID, 'workflow.plan-revision', { featureId: FEATURE_ID, count: 2 });
    let priorVersion: unknown;
    let priorUpdatedAt: unknown;
    for (let pass = 0; pass < 2; pass++) {
      expect((await handleSet({ featureId: FEATURE_ID, phase: 'plan' }, store.stateDir, store.eventStore)).success).toBe(true);
      const repaired = await documentOf(store, FEATURE_ID);
      expect(repaired.planReview).toMatchObject({ revisionCount: 2 });
      expect(repaired._checkpoint).toMatchObject({ summary: 'keep summary', staleAfterMinutes: 77 });
      expect(repaired._compensationCheckpoint).toEqual({ completedActions: ['keep-action'] });
      if (pass === 1) { expect(repaired._version).toBe(priorVersion); expect(repaired.updatedAt).toBe(priorUpdatedAt); }
      priorVersion = repaired._version;
      priorUpdatedAt = repaired.updatedAt;
    }
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition')).toEqual([]);
  });

  it('KernelNoStart_AfterCASLoss_LaterMoveWinsRepair', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
      const rows = await query(id, filters);
      if (!fired && filters === undefined && rows.some(row => row.type === 'workflow.transition')) {
        fired = true;
        await appendRow(store, FEATURE_ID, 'workflow.transition', { featureId: FEATURE_ID, from: 'plan-review', to: 'delegate', trigger: 'later', phaseAttemptId: 'later-attempt' });
        await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['artifacts.plan'], patch: { 'artifacts.plan': 'later.md' } });
      }
      return rows;
    });
    failSetState(store, 1);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: true, data: { phase: 'plan-review' } });
    expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phase: 'delegate', phaseAttemptId: 'later-attempt', artifacts: { plan: 'later.md' } });
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'state.patched')).toHaveLength(2);
    expect((await documentOf(store, FEATURE_ID))._eventSequence).toBe((await rowsOf(store, FEATURE_ID)).at(-1)?.sequence);
  });

  it('KernelNoStart_SamePhasePatchRechecksNewAuthority', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    const query = store.eventStore.query.bind(store.eventStore);
    let reads = 0;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
      if (id === FEATURE_ID && filters === undefined && ++reads === 2) await pinPlan(store, ['pending']);
      return query(id, filters);
    });
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan', updates: { 'artifacts.plan': 'same.md' } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'state.patched')).toHaveLength(0);
  });
});

describe('legacy kernel replay boundaries', () => {
  it.each([false, true])('KernelClaim_ActualWinnerPrecedesCustodyAndGuard_DifferentPatch_%s', async different => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    const guard = vi.spyOn(hsmTransitionGuard, 'attempt');
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
      const rows = await query(id, filters);
      if (!fired && id === FEATURE_ID && filters === undefined) {
        fired = true;
        requireSuccess('kernel winner', await handleSet({ featureId: FEATURE_ID, phase: 'plan-review',
          updates: { 'artifacts.plan': different ? 'other.md' : PLAN_ARTIFACT } }, store.stateDir, store.eventStore));
        vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('removed after winner'));
      }
      return rows;
    });
    const call = handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    if (different) await expect(call).rejects.toBeInstanceOf(OperationDigestMismatchError);
    else expect(await call).toMatchObject({ success: true, data: { idempotent: true } });
    expect(guard).toHaveBeenCalledTimes(1);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition')).toHaveLength(1);
  });

  it('KernelNoStart_MalformedPresentStartNeverUsesLegacyRepair', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    store.backend.appendEvent(FEATURE_ID, { streamId: FEATURE_ID, sequence: 2, type: 'workflow.started',
      schemaVersion: '1.1', timestamp: new Date().toISOString(), data: { featureId: FEATURE_ID, workflowType: 'feature', initialPhase: 7 } });
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition')).toHaveLength(0);
  });
});

describe('scratch patch replay precedence', () => {
  it.each([false, true])('Claim_IndexedContainerChangedBeforePreflight_DifferentPayload_%s', async different => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    await update(store, FEATURE_ID, { notes: { items: {} } });
    const input = { featureId: FEATURE_ID, phase: 'review', updates: { 'notes.items[0].value': 'accepted' } };
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
      const rows = await query(id, filters);
      if (!fired && id === FEATURE_ID && filters === undefined) {
        fired = true;
        await update(store, FEATURE_ID, { 'notes.items': [] });
        requireSuccess('indexed winner', await handleSet({ ...input,
          updates: { 'notes.items[0].value': different ? 'other' : 'accepted' } }, store.stateDir, store.eventStore));
        await update(store, FEATURE_ID, { 'notes.items': {} });
        vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('missing after indexed winner'));
      }
      return rows;
    });
    const call = handleSet(input, store.stateDir, store.eventStore);
    if (different) await expect(call).rejects.toBeInstanceOf(OperationDigestMismatchError);
    else expect(await call).toMatchObject({ success: true, data: { idempotent: true } });
    expect(fired).toBe(true);
    expect((await documentOf(store, FEATURE_ID)).notes).toEqual({ items: {} });
    expect((await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition' && row.data?.to === 'review')).toHaveLength(1);
  });

  it('Claim_IndexedContainerErrorWithoutClaim_RefusesNoWrites', async () => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    await update(store, FEATURE_ID, { notes: { items: {} } });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { 'notes.items[0].value': 'invalid' } }, store.stateDir, store.eventStore);
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_INPUT' } });
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
  });
});

describe('commit coordinate and cursor fences', () => {
  it.each(['plan', 'plan-review'])('KernelNoStart_OneAheadCursorCannotHidePendingPatch_%s', async phase => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    const before = await rowsOf(store, FEATURE_ID);
    await forgeDocument(store, FEATURE_ID, document => ({ ...document, _eventSequence: before.at(-1)!.sequence + 1 }));
    const result = await handleSet({ featureId: FEATURE_ID, phase, updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    expect(result.success).toBe(false);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(before);
    const raw = new Database(path.join(store.stateDir, 'exarchos.db'));
    try { expect(raw.prepare('SELECT * FROM idempotency_claims WHERE idempotencyKey LIKE ?').all(`transition:${FEATURE_ID}:%`)).toHaveLength(0); }
    finally { raw.close(); }
  });

  it.each(['pending', 'compatible', 'skips', 'definition'])('PinnedAuthority_IndependentConnectionReplacement_%s', async mode => {
    const store = await openStore();
    await featureAtDelegate(store, ['t1'], ['t1']);
    await pinPlan(store, ['t1']);
    const backend = new SqliteBackend(path.join(store.stateDir, 'exarchos.db'));
    backend.initialize();
    releases.push(() => backend.close());
    const eventStore = new EventStore(store.stateDir, { backend });
    await eventStore.initialize();
    releases.push(() => eventStore.close());
    const appender = store.eventStore.getAppender();
    const commit = appender.decideOnce.bind(appender);
    let oldOperation = '';
    let inside = false;
    let closures = 0;
    const resolver = store.eventStore.bundleStore.resolve.bind(store.eventStore.bundleStore);
    const resolve = vi.spyOn(store.eventStore.bundleStore, 'resolve').mockImplementation((...args) => {
      expect(inside).toBe(false);
      return resolver(...args);
    });
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (!oldOperation) {
        oldOperation = id;
        await pinPlan({ ...store, eventStore, backend }, mode === 'pending' ? ['t1', 't2'] : ['t1'], bundle => {
          if (mode === 'skips') return { ...bundle, capsule: { ...bundle.capsule,
            settlementContract: { ...bundle.capsule.settlementContract, skipPhases: ['review'] } } };
          if (mode !== 'definition') return bundle;
          const original = builtInDefinition('feature');
          const definition = { ...original, exarchos: { ...original.exarchos, edges: { ...original.exarchos.edges,
            'delegate->review': { ...original.exarchos.edges['delegate->review']!,
              route: { kind: 'factEquals' as const, field: 'tasks.allComplete' as const, value: false } } } } };
          return { ...bundle, definition, capsule: { ...bundle.capsule,
            identity: { ...bundle.capsule.identity, definitionVersion: contentDigest(definition) } } };
        });
      }
      return commit(id, digest, tx => { closures++; inside = true; try { return closure(tx); } finally { inside = false; } });
    });
    const before = await rowsOf(store, FEATURE_ID);
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'review', updates: { tasks: [] } }, store.stateDir, store.eventStore);
    expect(result.success, JSON.stringify(result)).toBe(mode === 'compatible');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(closures).toBe(mode === 'compatible' ? 2 : 1);
    const added = (await rowsOf(store, FEATURE_ID)).slice(before.length);
    expect(added.filter(row => row.type === 'state.patched')).toHaveLength(mode === 'compatible' ? 1 : 0);
    expect(added.filter(row => row.type === 'workflow.transition')).toHaveLength(mode === 'compatible' ? 1 : 0);
    const claim = appender.ensureSqliteBackendSync().lookupOperationClaim(oldOperation);
    if (mode === 'compatible') expect(claim).toBeDefined();
    else expect(claim).toBeUndefined();
  });

  it('PinnedAuthority_SamePhaseAfterRealCycleUsesNewPredecessor', async () => {
    const store = await openStore();
    await featureAtPlanReview(store);
    await pinPlan(store, ['t1']);
    const appender = store.eventStore.getAppender();
    const commit = appender.decideOnce.bind(appender);
    let oldOperation = '';
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (!oldOperation) {
        oldOperation = id;
        await update(store, FEATURE_ID, { planReview: { approved: false, gapsFound: true, revisionCount: 0 } });
        await transition(store, FEATURE_ID, 'plan');
        await transition(store, FEATURE_ID, 'plan-review');
        await update(store, FEATURE_ID, { planReview: { approved: true } });
      }
      return commit(id, digest, closure);
    });
    const result = await handleSet({ featureId: FEATURE_ID, phase: 'delegate' }, store.stateDir, store.eventStore);
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(appender.ensureSqliteBackendSync().lookupOperationClaim(oldOperation)).toBeUndefined();
    const moves = (await rowsOf(store, FEATURE_ID)).filter(row => row.type === 'workflow.transition');
    const predecessor = moves.at(-2)!.data?.phaseAttemptId;
    expect(recordOf(result.data).phaseAttemptId).toBe(allocatePhaseAttemptId(FEATURE_ID, 'plan-review', 'delegate', String(predecessor), 0));
  });
});

describe('legacy custody await replay', () => {
  it.each([false, true])('KernelClaim_WinnerDuringSuccessfulCustody_DifferentPayload_%s', async different => {
    registerWorkflowType(CUSTOM_TYPE, { phases: ['plan', 'plan-review'], initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'plan-review', event: 'review' }] });
    extendWorkflowTypeEnum(CUSTOM_TYPE);
    releases.push(() => { unextendWorkflowTypeEnum(CUSTOM_TYPE); unregisterWorkflowType(CUSTOM_TYPE); });
    const store = await openStore();
    await init(store, FEATURE_ID, CUSTOM_TYPE);
    await pinKernel(store, CUSTOM_TYPE);
    const guard = vi.spyOn(hsmTransitionGuard, 'attempt');
    const resolve = store.eventStore.bundleStore.resolve.bind(store.eventStore.bundleStore);
    let fired = false;
    vi.spyOn(store.eventStore.bundleStore, 'resolve').mockImplementation(async (...args) => {
      const bytes = await resolve(...args);
      if (!fired) {
        fired = true;
        requireSuccess('custody winner', await handleSet({ featureId: FEATURE_ID, phase: 'plan-review',
          updates: { 'artifacts.plan': different ? 'other.md' : PLAN_ARTIFACT } }, store.stateDir, store.eventStore));
        guard.mockImplementation(async () => { throw new Error('The legacy guard must not repeat'); });
      }
      return bytes;
    });
    const call = handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    if (different) await expect(call).rejects.toBeInstanceOf(OperationDigestMismatchError);
    else expect(await call).toMatchObject({ success: true, data: { idempotent: true } });
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('KernelNoStart_LaterCountedRowKeepsSnapshotCursorAcrossRepair', async () => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (id, filters) => {
      const rows = await query(id, filters);
      if (!fired && filters === undefined && rows.some(row => row.type === 'workflow.transition')) {
        fired = true;
        await appendRow(store, FEATURE_ID, 'workflow.plan-revision', { featureId: FEATURE_ID, count: 1 });
        return query(id, filters);
      }
      return rows;
    });
    expect((await handleSet({ featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } }, store.stateDir, store.eventStore)).success).toBe(true);
    expect((await documentOf(store, FEATURE_ID)).planReview).toMatchObject({ revisionCount: 1 });
    expect((await documentOf(store, FEATURE_ID))._eventSequence).toBe((await rowsOf(store, FEATURE_ID)).at(-1)?.sequence);
    expect((await handleSet({ featureId: FEATURE_ID, phase: 'plan-review' }, store.stateDir, store.eventStore)).success).toBe(true);
    expect((await documentOf(store, FEATURE_ID)).planReview).toMatchObject({ revisionCount: 1 });
  });
});

/** A failed document publication keeps the original source version for a later claim lookup. */
describe('no-start claim recovery across calls', () => {
  it.each([false, true])('LegacyKernelPin_ExactRetry_ReplaysWithoutCustody differentPayload=%s', async different => {
    const store = await openStore();
    await init(store, FEATURE_ID, 'feature', false);
    await pinKernel(store);
    await forgeDocument(store, FEATURE_ID, document => {
      const { phaseAttemptId: _attempt, ...withoutAttempt } = document;
      return withoutAttempt;
    });
    const before = await documentOf(store, FEATURE_ID);
    expect(before).not.toHaveProperty('phaseAttemptId');
    const guard = vi.spyOn(hsmTransitionGuard, 'attempt');
    const input = { featureId: FEATURE_ID, phase: 'plan-review', updates: { 'artifacts.plan': PLAN_ARTIFACT } };
    failSetState(store, 4);
    await expect(handleSet(input, store.stateDir, store.eventStore)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect(await documentOf(store, FEATURE_ID)).toEqual(before);
    expect(guard).toHaveBeenCalledTimes(1);
    const committedRows = await rowsOf(store, FEATURE_ID);
    expect(committedRows.filter(row => row.type === 'workflow.transition')).toHaveLength(1);
    expect(committedRows.filter(row => row.type === 'state.patched')).toHaveLength(1);
    const raw = new Database(path.join(store.stateDir, 'exarchos.db'));
    releases.push(() => raw.close());
    const claims = () => raw.prepare('SELECT * FROM idempotency_claims WHERE idempotencyKey LIKE ? ORDER BY idempotencyKey').all(`transition:${FEATURE_ID}:%`);
    const heldClaims = claims();
    expect(heldClaims).toHaveLength(1);
    await appendRow(store, FEATURE_ID, 'state.patched', { featureId: FEATURE_ID, fields: ['notes.afterCommit'], patch: { 'notes.afterCommit': 'later row' } });
    const beforeRetry = await rowsOf(store, FEATURE_ID);
    const custody = vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('custody removed after accepted move'));
    guard.mockImplementation(async () => { throw new Error('The accepted guard must not repeat'); });
    const retry = handleSet({ ...input, updates: { 'artifacts.plan': different ? 'different.md' : PLAN_ARTIFACT } }, store.stateDir, store.eventStore);
    if (different) {
      await expect(retry).rejects.toBeInstanceOf(OperationDigestMismatchError);
      expect(await documentOf(store, FEATURE_ID)).toEqual(before);
    } else {
      expect(await retry).toMatchObject({ success: true, data: { phase: 'plan-review', idempotent: true } });
      expect(await documentOf(store, FEATURE_ID)).toMatchObject({ phase: 'plan-review', artifacts: { plan: PLAN_ARTIFACT },
        notes: { afterCommit: 'later row' }, _eventSequence: beforeRetry.at(-1)?.sequence });
    }
    expect(guard).toHaveBeenCalledTimes(1);
    expect(custody).not.toHaveBeenCalled();
    expect(claims()).toEqual(heldClaims);
    expect(await rowsOf(store, FEATURE_ID)).toEqual(beforeRetry);
  });
});
