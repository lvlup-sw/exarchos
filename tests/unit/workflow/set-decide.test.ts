/**
 * These tests check that the transition handler decides on the ledger fold of the rows, not on the state document.
 * Each case seeds a SQLite store with `configureStateStoreBackend`, so the state document is the `workflow_state` row.
 * A seed writes the rows and the document through the handlers, and a forge then changes the document only.
 * The fold decides each move, a move commits its rows once, and a denial appends one `workflow.guard-failed` row.
 *
 * @oracle-sources: ../../../src/workflow/phase-attempt-id.ts, hand-seeded stream rows
 */
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

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
