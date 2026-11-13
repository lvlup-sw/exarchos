/**
 * Tests for the phase move of the settle commit.
 *
 * Each case seeds a stream as rows of a SQLite store, commits a capsule by hand and settles one batch through `handleSettle`.
 * The state store uses the same SQLite backend, so the state document is the `workflow_state` row.
 * A case that reads or writes the document uses `getState` and `setState` of that backend.
 * The commit decides on the ledger fold of its own rows under the pinned definition. It moves the phase only when
 * exactly one plain explicit edge out of the batch step admits. It appends the rows of the move before its record.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the persisted operation claim
 */

import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema, type WorkflowDefinitionV1 } from '@lvlup-sw/strategos-contracts';

import { contentDigest } from '../../../../src/contract/capsule/capsule-digest.js';
import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { resolveConfig, type ResolvedProjectConfig } from '../../../../src/config/resolve.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { ToolResult } from '../../../../src/format.js';
import { foldWorkflowState } from '../../../../src/projections/guard-input/fold.js';
import { contractEmissionsOf } from '../../../../src/registry/action-contract.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { VersionConflictError as BackendVersionConflictError } from '../../../../src/storage/memory-backend.js';
import { SqliteBackend } from '../../../../src/storage/sqlite-backend.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import type { ExecuteIntentDeps, LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { lowerDefinition } from '../../../../src/verbs/prepare/lower-definition.js';
import { pinDefinition } from '../../../../src/verbs/prepare/pin-definition.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { summarizeSettlementReceipt } from '../../../../src/verbs/settle/economy.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { builtInDefinition } from '../../../../src/workflow/definitions/built-in.js';
import { readPhaseAttemptId } from '../../../../src/workflow/phase-attempt-id.js';
import { configureStateStoreBackend, levelPhaseInStateDocument, reconcileFromEvents } from '../../../../src/workflow/state-store.js';
import { handleInit, handleSet } from '../../../../src/workflow/tools.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { releaseCheckDefinition } from '../../../helpers/definitions/user-definition.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

/** The stream of most cases. Each case has its own store. */
const STREAM = 'settle-phase-move';

/** The row types of a plain move, in the order of the commit. */
const MOVE_ROW_TYPES: readonly string[] = ['workflow.transition', 'phase.exited', 'phase.entered'];

/** The row type of the settlement record. */
const RECORD_TYPE = 'execution.settled';

/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];

/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];

/** Where the claims say the work is. The path does not exist, so the one gate that runs passes advisory. */
const WORKTREE_ROOT = '/nonexistent-settle-phase-move-worktree';

/** The guard of the feature edge `delegate -> review`. */
const FEATURE_REVIEW_GUARD = 'all-tasks-complete+team-disbanded';

/** One store of a case: the state directory, the SQLite backend of the state store, the event store and the pinned scope. */
interface MoveStore {
  readonly stateDir: string;
  readonly backend: SqliteBackend;
  readonly eventStore: EventStore;
  readonly scope: CapsuleScope;
}

/** One planned task, as the planner stamps it. */
interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
}

/** Each release of the current case, in the order of creation. The teardown runs them in reverse order. */
const releases: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0).reverse()) await release();
  configureStateStoreBackend(undefined);
});

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the value as a record, or an empty record when it is no plain object. */
function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Opens a store on a new temporary directory and makes its backend the backend of the state store. */
async function openStore(): Promise<MoveStore> {
  const stateDir = makeTempDir('settle-phase-move-');
  releases.push(() => rmrfAsync(stateDir));
  const backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  releases.push(() => backend.close());
  const eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
  releases.push(() => eventStore.close());
  configureStateStoreBackend(backend);
  const scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
  return { stateDir, backend, eventStore, scope };
}

/** The worktree of one task. Each task has a path of its own. */
function worktreeOf(taskId: string): string {
  return `${WORKTREE_ROOT}/${taskId}`;
}

/** One pending task with no dependency. */
function pending(id: string, blockedBy: readonly string[] = []): PlannedTask {
  return { id, title: `task ${id}`, status: 'pending', blockedBy };
}

/** The wiring of one call. The observer of a claimed worktree finds each claimed path in the pinned scope. */
function wiring(store: MoveStore, projectConfig?: ResolvedProjectConfig): DispatchContext {
  return {
    stateDir: store.stateDir,
    eventStore: store.eventStore,
    enableTelemetry: true,
    treeObserver: inScopeObserver(store.scope),
    ...(projectConfig === undefined ? {} : { projectConfig }),
  };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-phase-move-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

/** The live handler of one leaf of the orchestrate table. */
function liveHandler(action: string): LeafHandler {
  const handler = ACTION_HANDLERS[action];
  if (handler === undefined) throw new Error(`the orchestrate table has no ${action}`);
  return handler;
}

/** The task-completion runbook, cut to the mock-boundary step and the completion step. */
function noShellTaskCompletion(): RunbookDefinition {
  const shipped = ALL_RUNBOOKS.find((entry) => entry.id === 'task-completion');
  if (shipped === undefined) throw new Error('the task-completion runbook is missing');
  const steps = shipped.steps
    .filter((step) => NO_SHELL_LEAVES.includes(step.action))
    .map((step): RunbookStep => (step.action === 'check_mock_boundary' ? { ...step, onFail: 'stop' } : step));
  return { ...shipped, steps };
}

/** The collaborators of the executor, with the live leaves of the cut runbook. */
function executeDeps(): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: (tool, action) => findActionInRegistry(tool, action),
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: liveHandler('check_mock_boundary') },
    handlerTool: 'exarchos_orchestrate',
  };
}

/** The pinned full definition of a built-in type, as a compiler of this build pins it. */
function pinnedBuiltIn(workflowType: 'feature' | 'refactor'): WorkflowDefinitionV1 {
  return pinDefinition(workflowType, builtInDefinition(workflowType)).definition;
}

/** Returns the value at a key of a record as a record, or throws with the key. */
function recordAt(value: unknown, key: string): Record<string, unknown> {
  const entry = recordOf(value)[key];
  if (!isRecord(entry)) throw new Error(`the key '${key}' holds no object`);
  return entry;
}

/**
 * Seeds a stream in a phase. The start row names the type and a phase attempt. One transition row sets the phase,
 * one patch row writes the plan and the risk claim, and each completed id gets a completion row.
 * With `document`, `init` starts the workflow, so the store also holds the state document of the stream.
 */
async function seedStream(
  store: MoveStore,
  options: {
    readonly workflowType?: string;
    readonly from?: string;
    readonly phase: string;
    readonly tasks: readonly PlannedTask[];
    readonly completed?: readonly string[];
    readonly riskTier?: string;
    readonly document?: boolean;
    readonly featureId?: string;
  },
): Promise<void> {
  const featureId = options.featureId ?? STREAM;
  const workflowType = options.workflowType ?? 'feature';
  if (options.document === true) {
    const init = await handleInit({ featureId, workflowType }, store.stateDir, store.eventStore);
    if (!init.success) throw new Error(`init failed: ${JSON.stringify(init.error)}`);
  } else {
    await store.eventStore.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType, phaseAttemptId: `phase-attempt:${featureId}` },
    });
  }
  await store.eventStore.append(featureId, { type: 'workflow.transition', data: { from: options.from ?? 'plan-review', to: options.phase } });
  const patch = { tasks: options.tasks.map((task) => ({ ...task })), riskTier: options.riskTier ?? 'low', boundaryTouching: false };
  await store.eventStore.append(featureId, {
    type: 'state.patched',
    data: { featureId, fields: Object.keys(patch), patch },
  });
  for (const taskId of options.completed ?? []) {
    await store.eventStore.append(featureId, { type: 'task.completed', data: { taskId } });
  }
}

/** A capsule of the batch on the pinned definition. Each task names the step, and each task is required and has terms. */
function capsuleOf(
  store: MoveStore,
  definition: WorkflowDefinitionV1,
  taskIds: readonly string[],
  stepId: string,
  capsuleVersion: number,
  materialKinds: readonly string[] = [],
): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return withScope(
    {
      ...base,
      identity: { ...base.identity, definitionVersion: contentDigest(definition), capsuleVersion },
      graph: {
        ...base.graph,
        tasks: taskIds.map((taskId) => ({ taskId, title: `task ${taskId}`, stepId })),
        dependencies: [],
        joins: [],
      },
      contracts: {
        ...base.contracts,
        taskInputs: {},
        taskResults: Object.fromEntries(taskIds.map((taskId) => [taskId, [{ name: 'worktreePath', type: 'string', required: false }]])),
        deviationEnvelope: {
          ...base.contracts.deviationEnvelope,
          ...(materialKinds.length > 0 ? { materialDeviationKinds: [...materialKinds] } : {}),
        },
      },
      settlementContract: {
        requiredResults: [...taskIds],
        taskVerification: Object.fromEntries(
          taskIds.map((taskId) => [taskId, { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/settle-phase-move' }]),
        ),
      },
    },
    store.scope,
  );
}

/** The phase attempt of the fold of the stream. The static-analysis seed binds to it. */
async function foldAttemptOf(store: MoveStore, featureId: string): Promise<string> {
  const attempt = readPhaseAttemptId(foldWorkflowState(await store.eventStore.query(featureId)));
  if (attempt === undefined) throw new Error('the fold holds no phase attempt');
  return attempt;
}

/**
 * Commits the capsule of a batch on the pinned definition, as prepare records it. Then it seeds a passing static-analysis
 * verdict for each task of the batch in the phase attempt of the fold.
 */
async function prepareBatch(
  store: MoveStore,
  options: {
    readonly definition: WorkflowDefinitionV1;
    readonly taskIds: readonly string[];
    readonly stepId: string;
    readonly capsuleVersion?: number;
    readonly workflowType?: string;
    readonly materialKinds?: readonly string[];
    readonly featureId?: string;
  },
): Promise<number> {
  const featureId = options.featureId ?? STREAM;
  const capsuleVersion = options.capsuleVersion ?? 1;
  const batch = capsuleOf(store, options.definition, options.taskIds, options.stepId, capsuleVersion, options.materialKinds);
  const capsule = { ...batch, identity: { ...batch.identity, workflowId: featureId } };
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(store), {
      streamId: featureId,
      operationId: `seed:${featureId}:${capsuleVersion}`,
      requestDigest: `sha256:seed-${featureId}-${capsuleVersion}`,
      workflowType: options.workflowType ?? 'feature',
      capsule,
      definition: options.definition,
    }),
  );
  const phaseAttemptId = await foldAttemptOf(store, featureId);
  for (const taskId of options.taskIds) {
    await seedStaticAnalysisVerdict(store.eventStore, {
      streamId: featureId,
      taskId,
      stateDir: store.stateDir,
      phaseAttemptId,
      worktreePath: worktreeOf(taskId),
    });
  }
  return capsuleVersion;
}

/** The live completion leaf completes one task on its worktree, outside any settle call. */
async function completeTask(store: MoveStore, taskId: string): Promise<void> {
  const completed = await runWithDispatchContext(correlation(), () =>
    liveHandler('task_complete')({ taskId, featureId: STREAM, result: { worktreePath: worktreeOf(taskId) } }, store.stateDir, wiring(store)),
  );
  expect(completed.success, JSON.stringify(completed)).toBe(true);
}

/** A claim that its task is complete in its own worktree. */
function completedClaim(taskId: string): Record<string, unknown> {
  return { taskId, fields: { worktreePath: worktreeOf(taskId) }, evidence: [] };
}

/** One settle call for a batch on a prepared capsule. */
async function settle(
  store: MoveStore,
  args: Record<string, unknown>,
  projectConfig?: ResolvedProjectConfig,
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, ...args }, store.stateDir, wiring(store, projectConfig), { execute: executeDeps() }),
  );
}

/** True when the value has the fields of a receipt that the cases read. */
function isReceipt(value: unknown): value is SettlementReceipt {
  return isRecord(value) && typeof value.operationId === 'string' && typeof value.outcome === 'string' && typeof value.tailSequence === 'number';
}

/** The receipt of a call that returned one. */
function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isReceipt(result.data)) throw new Error(`the call returned no receipt: ${JSON.stringify(result)}`);
  return result.data;
}

/** The sequence of the last row of the stream, or 0 for an empty stream. */
async function tailOf(store: MoveStore, featureId = STREAM): Promise<number> {
  return (await store.eventStore.query(featureId)).at(-1)?.sequence ?? 0;
}

/** The rows of the stream after a sequence. */
async function rowsAfter(store: MoveStore, sequence: number, featureId = STREAM): Promise<WorkflowEvent[]> {
  return (await store.eventStore.query(featureId)).filter((row) => row.sequence > sequence);
}

/** The phase rows and the record after a sequence, by type, in commit order. */
async function moveAndRecordTypesAfter(store: MoveStore, sequence: number): Promise<string[]> {
  return (await rowsAfter(store, sequence))
    .map((row) => row.type)
    .filter((type) => MOVE_ROW_TYPES.includes(type) || type === RECORD_TYPE);
}

/** The phase rows of the stream, by type, in commit order. */
async function phaseRowTypes(store: MoveStore, featureId = STREAM): Promise<string[]> {
  return (await store.eventStore.query(featureId)).map((row) => row.type).filter((type) => MOVE_ROW_TYPES.includes(type));
}

/** The state document of a stream, read through the SQLite backend. */
function documentOf(store: MoveStore, featureId = STREAM): Record<string, unknown> {
  const state = store.backend.getState(featureId);
  if (state === null) throw new Error(`the store holds no document for '${featureId}'`);
  return { ...state };
}

/**
 * Changes the state document only, through the SQLite backend, with no row. The write bumps `_version` as a document
 * write does, so the version of the document and the version of the row stay equal.
 */
function forgeDocument(store: MoveStore, change: (document: Record<string, unknown>) => Record<string, unknown>): void {
  const state = store.backend.getState(STREAM);
  if (state === null) throw new Error(`the store holds no document for '${STREAM}'`);
  store.backend.setState(STREAM, { ...state, ...change({ ...state }), _version: (state._version ?? 1) + 1 });
}

/** A copy of a value with no `phaseMove` key at any depth, as a build before the phase move wrote it. */
function withoutPhaseMove<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (key: string, entry: unknown) => (key === 'phaseMove' ? undefined : entry));
}

/** Copies an older receipt and corrects its tail after removal of the phase rows. */
function earlierResult<T>(value: T, tailSequence: number): T {
  const result = withoutPhaseMove(value);
  if (typeof result !== 'object' || result === null || !('tailSequence' in result)) return result;
  return { ...result, tailSequence };
}

/**
 * Makes each settle commit write what a build before the phase move wrote: no phase row and no `phaseMove`.
 * The tail of the stored receipt drops the phase rows too, so the record stays at the tail.
 */
function commitAsAnEarlierBuild(store: MoveStore): void {
  const appender = store.eventStore.getAppender();
  const commit = appender.decideOnce.bind(appender);
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (operationId, requestDigest, closure) => {
    if (!operationId.startsWith('settle:')) return commit(operationId, requestDigest, closure);
    return commit(operationId, requestDigest, (tx) => {
      const decision = closure(tx);
      const events = decision.events.filter((event) => !MOVE_ROW_TYPES.includes(event.type));
      const tail = tx.readStream(decision.streamId).version + events.length;
      return {
        ...decision,
        events,
        result: earlierResult(decision.result, tail),
      };
    });
  });
}

/** Seeds a feature stream at `delegate` with one pending task, and commits the batch of that task. */
async function featureBatchAtDelegate(store: MoveStore, options: { readonly document?: boolean } = {}): Promise<number> {
  await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')], ...options });
  return prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });
}

/** The user definition `release-check` with a second edge out of `build` that admits on the same condition. */
function releaseCheckWithTwoExits(): Record<string, unknown> {
  const document = releaseCheckDefinition();
  const steps = document.steps;
  const transitions = document.transitions;
  if (!Array.isArray(steps) || !Array.isArray(transitions)) throw new Error('the fixture holds no steps or transitions');
  const audit = { kind: 'skill', stepId: 'audit', stepName: 'audit', isTerminal: false, runtime: 'exarchos', stepType: 'REVIEW' };
  const edges = recordAt(document.exarchos, 'edges');
  return {
    ...document,
    steps: [...steps.slice(0, 3), audit, ...steps.slice(3)],
    transitions: [...transitions, { transitionId: 'build->audit', fromStepId: 'build', toStepId: 'audit', isDefault: false }],
    exarchos: { ...recordOf(document.exarchos), edges: { ...edges, 'build->audit': edges['build->verify'] } },
  };
}

/** The feature definition whose `delegate` step leaves the group `implementation`. The group keeps `review` as its initial member. */
function featureWithDelegateOutsideItsGroup(): WorkflowDefinitionV1 {
  const document: Record<string, unknown> = structuredClone({ ...builtInDefinition('feature') });
  const extension = recordOf(document.exarchos);
  const groups = Array.isArray(extension.groups) ? extension.groups : [];
  const regrouped = groups.map((group: unknown) => {
    const entry = recordOf(group);
    if (entry.groupId !== 'implementation') return entry;
    const members = Array.isArray(entry.members) ? entry.members : [];
    return { ...entry, members: members.filter((member: unknown) => member !== 'delegate'), initial: 'review' };
  });
  return WorkflowDefinitionV1Schema.parse({ ...document, exarchos: { ...extension, groups: regrouped } });
}

describe('settle moves the phase on one plain edge', () => {
  /** The rows of the move come after the segment rows and before the record, and `phase.entered` freezes the review gates of the low tier. */
  it('Settle_OneAdmittedEdge_AppendsThePhaseRowsBeforeTheRecord', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);
    const before = await tailOf(store);

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.outcome).toBe('settled');
    expect(await moveAndRecordTypesAfter(store, before)).toEqual([...MOVE_ROW_TYPES, RECORD_TYPE]);
    const rows = await rowsAfter(store, before);
    expect(rows.at(-1)?.type).toBe(RECORD_TYPE);
    expect(rows.at(-1)?.sequence).toBe(receipt.tailSequence);
    const transition = rows.find((row) => row.type === 'workflow.transition');
    expect(transition?.data).toMatchObject({ from: 'delegate', to: 'review', trigger: 'settle' });
    const entered = rows.find((row) => row.type === 'phase.entered');
    expect(entered?.data).toMatchObject({ phase: 'review', kind: 'REVIEW', resolvedGates: [{ family: 'review', gate: 'review' }] });
  });

  /** The receipt names the edge, its guard and the phase attempt that the transition row carries. */
  it('Settle_TheReceipt_NamesTheEdge', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    const transition = (await store.eventStore.query(STREAM, { type: 'workflow.transition' })).at(-1);
    const phaseAttemptId = recordOf(transition?.data).phaseAttemptId;
    expect(typeof phaseAttemptId).toBe('string');
    expect(receipt.phaseMove).toEqual({
      kind: 'moved',
      from: 'delegate',
      to: 'review',
      transitionId: 'delegate->review',
      guardId: FEATURE_REVIEW_GUARD,
      phaseAttemptId,
    });
  });

  /** Each task-batch step of the built-ins gives exactly the three rows of a plain edge. */
  it.each([
    { workflowType: 'feature' as const, from: 'plan-review', step: 'delegate', target: 'review' },
    { workflowType: 'refactor' as const, from: 'overhaul-plan-review', step: 'overhaul-delegate', target: 'overhaul-review' },
  ])('Settle_TaskBatchSteps_EachGivesExactlyThreeRows ($workflowType $step)', async ({ workflowType, from, step, target }) => {
    const store = await openStore();
    await seedStream(store, { workflowType, from, phase: step, tasks: [pending('task-a')] });
    const capsuleVersion = await prepareBatch(store, { definition: pinnedBuiltIn(workflowType), taskIds: ['task-a'], stepId: step, workflowType });
    const before = await tailOf(store);

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove).toMatchObject({ kind: 'moved', from: step, to: target });
    expect((await rowsAfter(store, before)).map((row) => row.type).filter((type) => MOVE_ROW_TYPES.includes(type))).toEqual([...MOVE_ROW_TYPES]);
  });

  /** A registered user definition moves under the definition that its capsule pins, as a built-in does. */
  it('Settle_AUserDefinition_MovesUnderItsPinnedDefinition', async () => {
    const store = await openStore();
    await seedStream(store, { workflowType: 'release-check', from: 'scope', phase: 'build', tasks: [pending('task-a')] });
    const capsuleVersion = await prepareBatch(store, {
      definition: WorkflowDefinitionV1Schema.parse(releaseCheckDefinition()),
      taskIds: ['task-a'],
      stepId: 'build',
      workflowType: 'release-check',
    });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove).toMatchObject({ kind: 'moved', from: 'build', to: 'verify', transitionId: 'build->verify' });
    expect(foldWorkflowState(await store.eventStore.query(STREAM)).phase).toBe('verify');
  });

  /** A skip that names no step of the pinned definition has no effect, so the phase moves. */
  it('Settle_ASkipThatNamesNoStepOfThePin_StillMoves', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);

    const receipt = receiptOf(
      await settle(
        store,
        { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] },
        resolveConfig({ workflow: { 'skip-phases': ['overhaul-review'] } }),
      ),
    );

    expect(receipt.phaseMove).toMatchObject({ kind: 'moved', from: 'delegate', to: 'review' });
  });

  /** The settle action declares each row of a move, as a conditional primary emission of the `workflow` owner. */
  it('Settle_TheDeclaredEmissions_CoverEachRowOfAMove', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);
    const before = await tailOf(store);
    receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));
    const action = findActionInRegistry('exarchos_orchestrate', 'settle');
    if (action === undefined) throw new Error('the registry holds no settle action');
    const declared = contractEmissionsOf(action);

    const moveTypes = (await rowsAfter(store, before)).map((row) => row.type).filter((type) => MOVE_ROW_TYPES.includes(type));

    expect(moveTypes).toEqual([...MOVE_ROW_TYPES]);
    for (const type of moveTypes) {
      expect(declared.filter((emission) => emission.event === type).map(({ condition, owner, role }) => ({ condition, owner, role })), type).toEqual([
        { condition: 'conditional', owner: 'workflow', role: 'primary' },
      ]);
    }
  });
});

describe('settle keeps the phase when the decide does not admit one plain edge', () => {
  /** Two edges out of the batch step admit, so the commit keeps the phase and lists the verdict of each edge. */
  it('Settle_TwoAdmittedEdges_KeepsThePhase_AndListsTheEdges', async () => {
    const store = await openStore();
    await seedStream(store, { workflowType: 'release-check', from: 'scope', phase: 'build', tasks: [pending('task-a')] });
    const capsuleVersion = await prepareBatch(store, {
      definition: WorkflowDefinitionV1Schema.parse(releaseCheckWithTwoExits()),
      taskIds: ['task-a'],
      stepId: 'build',
      workflowType: 'release-check',
    });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove).toEqual({
      kind: 'stayed',
      phase: 'build',
      reason: 'edges-admit',
      edges: [
        { transitionId: 'build->verify', to: 'verify', verdict: 'allow', falseFacts: [] },
        { transitionId: 'build->audit', to: 'audit', verdict: 'allow', falseFacts: [] },
      ],
    });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /** A spawned team that did not disband makes `team.disbandedOk` false, so no edge admits. The receipt names the false facts. */
  it('Settle_NoAdmittedEdge_KeepsThePhase_AndListsTheFalseFacts', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    await store.eventStore.append(STREAM, {
      type: 'team.spawned',
      data: { teamSize: 1, teammateNames: ['worker-1'], taskCount: 1, dispatchMode: 'agent-team' },
    });
    const capsuleVersion = await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.outcome).toBe('settled');
    expect(receipt.phaseMove).toEqual({
      kind: 'stayed',
      phase: 'delegate',
      reason: 'no-edge-admits',
      edges: [
        { transitionId: 'delegate->review', to: 'review', verdict: 'deny', falseFacts: ['team.disbandedOk'] },
        { transitionId: 'delegate->merge-pending', to: 'merge-pending', verdict: 'deny', falseFacts: ['mergePending.entryReady'] },
      ],
    });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /**
   * The pin is a copy of the feature definition whose `delegate` step leaves the group `implementation`. The group keeps `review`
   * as its initial member, so the pin keeps the group rule. The only admitted edge leaves no group and enters one, so it is not plain.
   */
  it('Settle_ANotPlainEdge_KeepsThePhase', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    const capsuleVersion = await prepareBatch(store, {
      definition: featureWithDelegateOutsideItsGroup(),
      taskIds: ['task-a'],
      stepId: 'delegate',
    });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove).toMatchObject({ kind: 'stayed', phase: 'delegate', reason: 'edge-not-plain' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /**
   * The case commits a capsule whose pinned definition is the kernel of the feature definition, as a compiler of the earlier form pinned it.
   * The claims verify and the fold admits `delegate -> review`, and the commit still keeps the phase.
   */
  it('Settle_ACompilerFiveCapsule_KeepsThePhase', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    const kernel = lowerDefinition('feature', builtInDefinition('feature')).definition;
    expect(Object.keys(kernel)).not.toContain('exarchos');
    const capsuleVersion = await prepareBatch(store, { definition: kernel, taskIds: ['task-a'], stepId: 'delegate' });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.outcome).toBe('settled');
    expect(receipt.phaseMove).toEqual({ kind: 'not-decided', reason: 'unpinned-definition' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /** A corrective outcome and a held outcome each keep the phase, because neither completes the batch. */
  it.each([
    {
      name: 'corrective',
      outcome: 'corrective-capsule',
      args: { claims: [completedClaim('task-a'), { taskId: 'task-b', status: 'blocked', reason: 'waits on a review' }] },
    },
    {
      name: 'held',
      outcome: 'deviation-pending',
      args: {
        claims: [completedClaim('task-a'), completedClaim('task-b')],
        deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the endpoint reads a cache that the design did not name' }],
      },
    },
  ])('Settle_CorrectiveOrHeldOutcome_MovesNoPhase ($name)', async ({ outcome, args }) => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a'), pending('task-b')] });
    const capsuleVersion = await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a', 'task-b'], stepId: 'delegate' });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', ...args }));

    expect(receipt.outcome).toBe(outcome);
    expect(receipt.phaseMove).toEqual({ kind: 'not-decided', reason: 'outcome-does-not-move' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /** A decision round that accepts a material deviation commits a design revision, so the commit does not decide the phase. */
  it('Settle_ADesignRevision_MovesNoPhase', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    const capsuleVersion = await prepareBatch(store, {
      definition: pinnedBuiltIn('feature'),
      taskIds: ['task-a'],
      stepId: 'delegate',
      materialKinds: ['invalidated-assumption'],
    });
    const held = receiptOf(
      await settle(store, {
        capsuleVersion,
        batchId: 'batch-1',
        claims: [completedClaim('task-a')],
        deviations: [{ deviationKind: 'invalidated-assumption', statement: 'the endpoint reads a cache that the design did not name' }],
      }),
    );
    expect(held.outcome).toBe('deviation-pending');

    const decided = receiptOf(
      await settle(store, {
        capsuleVersion,
        batchId: 'batch-1',
        decisions: (held.pendingDeviations ?? []).map(({ deviationId }) => ({
          deviationId,
          decision: 'accepted',
          actor: 'human:reviewer',
          rationale: 'the design did not name the cache',
        })),
      }),
    );

    expect(decided.designRevision).toBeDefined();
    expect(decided.phaseMove).toEqual({ kind: 'not-decided', reason: 'design-revision' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /** The stream left the batch step before the settle, so a late settle of the capsule cannot move a later phase. */
  it('Settle_TheWorkflowLeftTheStep_MovesNoPhase', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);
    await store.eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'delegate', to: 'review' } });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.outcome).toBe('settled');
    expect(receipt.phaseMove).toEqual({ kind: 'not-decided', reason: 'off-batch-step' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition', 'workflow.transition']);
  });

  /** A config whose skip list names a step of the pinned definition stops the decide, so the phase stays at `delegate`. */
  it('Settle_AConfiguredSkipPhase_DoesNotDecide', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);

    const receipt = receiptOf(
      await settle(
        store,
        { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] },
        resolveConfig({ workflow: { 'skip-phases': ['review'] } }),
      ),
    );

    expect(receipt.outcome).toBe('settled');
    expect(receipt.phaseMove).toEqual({ kind: 'not-decided', reason: 'skip-phases-config' });
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });

  /**
   * After the static-analysis seed, the live completion leaf completes the task, and then one patch row names a path that the
   * fold refuses. The claim of the complete task runs no segment. The verdict and the record still land, and the commit
   * appends no phase row.
   */
  it('Settle_AFoldThatThrows_CommitsTheVerdictWithNoPhaseMove', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);
    await completeTask(store, 'task-a');
    const key = `artifacts[0].${'x'.repeat(200)}`;
    await store.eventStore.append(STREAM, { type: 'state.patched', data: { featureId: STREAM, fields: [key], patch: { [key]: 1 } } });
    const rows = await store.eventStore.query(STREAM);
    expect(() => foldWorkflowState(rows)).toThrow(/INVALID_INPUT/);

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.outcome).toBe('settled');
    expect(receipt.phaseMove).toEqual({ kind: 'not-decided', reason: 'fold-failed' });
    expect((await store.eventStore.query(STREAM, { type: RECORD_TYPE })).length).toBe(1);
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
  });
});

describe('settle decides on the fold of its rows', () => {
  /**
   * Row one: a second task waits on the batch task, and its rows leave it pending while the document forges it complete.
   * Row two: the document lags at `plan-review`, while the rows hold `delegate` with each task complete.
   */
  it.each([
    {
      name: 'a forged status',
      tasks: [pending('task-a'), pending('task-b', ['task-a'])],
      forge: (): Record<string, unknown> => ({
        phase: 'delegate',
        tasks: [
          { id: 'task-a', title: 'task task-a', status: 'complete' },
          { id: 'task-b', title: 'task task-b', status: 'complete' },
        ],
      }),
      expected: { kind: 'stayed', phase: 'delegate', reason: 'no-edge-admits' },
      phaseRows: ['workflow.transition'],
    },
    {
      name: 'a lagging phase',
      tasks: [pending('task-a')],
      forge: (): Record<string, unknown> => ({ phase: 'plan-review' }),
      expected: { kind: 'moved', from: 'delegate', to: 'review' },
      phaseRows: ['workflow.transition', ...MOVE_ROW_TYPES],
    },
  ])('Settle_ALaggingDocument_DecidesOnTheFold ($name)', async ({ tasks, forge, expected, phaseRows }) => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks, document: true });
    const capsuleVersion = await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });
    forgeDocument(store, forge);

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove).toMatchObject(expected);
    expect(await phaseRowTypes(store)).toEqual(phaseRows);
  });

  /**
   * The first batch moves the stream into `review` at the high tier, and the entry freezes the high-tier gates. A fix cycle takes the
   * stream back to `delegate`, an update lowers the tier to `low`, and the plan gains one pending task. The settle of that task moves
   * the stream into `review` again, and the entry keeps each gate that the first entry froze.
   */
  it('Settle_AReEntryAfterAFixCycle_KeepsTheFrozenGates', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')], riskTier: 'high' });
    const first = await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });
    receiptOf(await settle(store, { capsuleVersion: first, batchId: 'batch-1', claims: [completedClaim('task-a')] }));
    const firstEntry = (await store.eventStore.query(STREAM, { type: 'phase.entered' })).at(-1);
    const frozen = recordOf(firstEntry?.data).resolvedGates;
    expect(frozen).toEqual([
      { family: 'review', gate: 'review' },
      { family: 'review', gate: 'mutation-adequacy' },
    ]);

    await store.eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'review', to: 'delegate' } });
    await store.eventStore.append(STREAM, { type: 'workflow.fix-cycle', data: { compoundStateId: 'implementation', count: 1, featureId: STREAM } });
    const lowered = { riskTier: 'low', tasks: [{ ...pending('task-a'), status: 'complete' }, pending('task-c')] };
    await store.eventStore.append(STREAM, { type: 'state.patched', data: { featureId: STREAM, fields: Object.keys(lowered), patch: lowered } });
    const second = await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-c'], stepId: 'delegate', capsuleVersion: 2 });
    const before = await tailOf(store);

    const receipt = receiptOf(await settle(store, { capsuleVersion: second, batchId: 'batch-2', claims: [completedClaim('task-c')] }));

    expect(receipt.phaseMove).toMatchObject({ kind: 'moved', from: 'delegate', to: 'review' });
    const reEntry = (await rowsAfter(store, before)).find((row) => row.type === 'phase.entered');
    expect(recordOf(reEntry?.data).resolvedGates).toEqual(frozen);
  });
});

describe('settle replays the phase move of its claim', () => {
  /** A replay of the batch appends no row and returns the phase move that the claim holds. */
  it('Settle_AReplay_AppendsNoPhaseRow_AndReturnsThePersistedPhaseMove', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store);
    const args = { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] };
    const first = receiptOf(await settle(store, args));
    const tail = await tailOf(store);

    const replayed = receiptOf(await settle(store, args));

    expect(first.phaseMove?.kind).toBe('moved');
    expect(replayed.phaseMove).toEqual(first.phaseMove);
    expect(replayed).toEqual(first);
    expect(await tailOf(store)).toBe(tail);
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition', ...MOVE_ROW_TYPES]);
  });

  /** The claim holds the result of a build before the phase move. The replay returns no `phaseMove` and levels no phase. */
  it('Settle_AReplayOfAClaimWithNoPhaseMove_ReturnsNoPhaseMove', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const args = { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] };
    commitAsAnEarlierBuild(store);
    const first = receiptOf(await settle(store, args));
    const before = await store.eventStore.query(STREAM);
    expect(first.tailSequence).toBe(before.find((row) => row.type === 'execution.settled')?.sequence);
    vi.restoreAllMocks();

    const replayed = receiptOf(await settle(store, args));

    expect(replayed.outcome).toBe('settled');
    expect(replayed.tailSequence).toBe(first.tailSequence);
    expect(await store.eventStore.query(STREAM)).toHaveLength(before.length);
    expect(replayed).not.toHaveProperty('phaseMove');
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition']);
    expect(documentOf(store).phase).toBe('plan');
  });
});

describe('settle levels the state document after a move', () => {
  /** The level writes the phase, the attempt of the move and `_eventSequence` at the tail of the receipt. */
  it('Settle_AMovedPhase_LevelsTheDocument', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    const document = documentOf(store);
    expect(receipt.phaseMove?.kind).toBe('moved');
    expect(document.phase).toBe('review');
    expect(document.phaseObligation).toMatchObject({ phase: 'review', kind: 'REVIEW' });
    expect(document.phaseAttemptId).toBe(receipt.phaseMove?.kind === 'moved' ? receipt.phaseMove.phaseAttemptId : undefined);
    expect(document._eventSequence).toBe(receipt.tailSequence);
  });

  /**
   * The document goes back to `delegate` with the event sequence that it held before the move. A replay of the same settle
   * levels it again: the phase is `review`, and `_eventSequence` is the tail of the receipt.
   */
  it('Settle_AReplay_LevelsALaggingDocument', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const before = documentOf(store)._eventSequence;
    expect(before).toEqual(expect.any(Number));
    const args = { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] };
    const first = receiptOf(await settle(store, args));
    expect(documentOf(store).phase).toBe('review');
    forgeDocument(store, () => ({ phase: 'delegate', _eventSequence: before }));
    expect(documentOf(store)).toMatchObject({ phase: 'delegate', _eventSequence: before });

    const replayed = receiptOf(await settle(store, args));

    expect(replayed.tailSequence).toBe(first.tailSequence);
    expect(replayed.phaseMove?.kind).toBe('moved');
    const document = documentOf(store);
    expect(document.phase).toBe('review');
    expect(document.phaseObligation).toMatchObject({ phase: 'review', kind: 'REVIEW' });
    expect(document._eventSequence).toBe(replayed.tailSequence);
  });

  it('Settle_AFieldPatchAfterTheMove_RepairsTheOldDocumentPhase', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const query = store.eventStore.query.bind(store.eventStore);
    let fired = false;
    vi.spyOn(store.eventStore, 'query').mockImplementation(async (...args) => {
      const rows = await query(...args);
      if (!fired && args[0] === STREAM && rows.some((row) => row.type === RECORD_TYPE)) {
        fired = true;
        expect((await handleSet({ featureId: STREAM, updates: { 'artifacts.plan': 'later-plan.md' } }, store.stateDir, store.eventStore)).success).toBe(true);
      }
      return rows;
    });
    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));
    const document = documentOf(store);
    expect(fired).toBe(true);
    expect(document).toMatchObject({ phase: 'review', artifacts: { plan: 'later-plan.md' }, phaseObligation: { phase: 'review', kind: 'REVIEW' } });
    expect(document.phaseAttemptId).toBe(receipt.phaseMove?.kind === 'moved' ? receipt.phaseMove.phaseAttemptId : undefined);
    expect(document._eventSequence).toBeGreaterThan(receipt.tailSequence);
    expect(document._eventSequence).toBe(await tailOf(store));
  });

  it('LevelDocument_AStaleCursor_RepairsSkippedPatchAndObligation', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const first = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));
    const expected = documentOf(store);
    forgeDocument(store, () => ({ phase: 'delegate', artifacts: { design: null, plan: 'stale-plan.md', pr: null }, phaseObligation: null, _history: { stale: 'stale' }, _eventSequence: 500 }));
    const outcome = await levelPhaseInStateDocument(path.join(store.stateDir, STREAM), store.eventStore, STREAM);
    expect(outcome.kind).toBe('levelled');
    expect(documentOf(store)).toMatchObject({ phase: 'review', phaseObligation: expected.phaseObligation,
      artifacts: expected.artifacts, _history: expected._history, _eventSequence: first.tailSequence });
    await reconcileFromEvents(store.stateDir, STREAM, store.eventStore);
    expect(documentOf(store)).toMatchObject({ artifacts: expected.artifacts, phaseObligation: expected.phaseObligation, _history: expected._history });
  });

  it('LevelDocument_ASynchronizedSnapshot_WritesNothing', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));
    const before = documentOf(store);
    const write = vi.spyOn(store.backend, 'setState');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'));
    try {
      const outcome = await levelPhaseInStateDocument(path.join(store.stateDir, STREAM), store.eventStore, STREAM);
      expect(outcome.kind).toBe('current');
      expect(documentOf(store)).toEqual(before);
      expect(write).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['query', 'fold', 'validation'])('LevelDocument_AFoldFault_LeavesDocumentAndCursorUnchanged', async (fault) => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')], document: true });
    const before = documentOf(store);
    if (fault === 'query') vi.spyOn(store.eventStore, 'query').mockRejectedValue(new Error('ledger unavailable'));
    else await store.eventStore.append(STREAM, { type: 'state.patched', data: { patch: fault === 'fold' ? { 'tasks[id=invalid].title': 'invalid' } : { integration: { passed: 'invalid' } } } });
    expect(await levelPhaseInStateDocument(path.join(store.stateDir, STREAM), store.eventStore, STREAM)).toMatchObject({ kind: 'failed' });
    expect(documentOf(store)).toEqual(before);
  });

  it('LevelDocument_AMissingDocument_Skips', async () => {
    const store = await openStore();
    expect(await levelPhaseInStateDocument(path.join(store.stateDir, STREAM), store.eventStore, STREAM)).toEqual({ kind: 'skipped', reason: 'no-document' });
  });

  it('Settle_AReplayAfterALaterMove_KeepsTheNewerDocument', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const args = { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] };
    const first = receiptOf(await settle(store, args));
    expect((await handleSet({ featureId: STREAM, updates: { reviews: { bugbot: { passed: false } } } }, store.stateDir, store.eventStore)).success).toBe(true);
    const laterMove = await handleSet({ featureId: STREAM, phase: 'delegate' }, store.stateDir, store.eventStore);
    expect(laterMove.success, JSON.stringify(laterMove.error)).toBe(true);
    const later = documentOf(store);
    const tail = await tailOf(store);
    const replayed = receiptOf(await settle(store, args));
    expect(replayed).toEqual(first);
    expect(documentOf(store)).toMatchObject({ phase: 'delegate', phaseAttemptId: later.phaseAttemptId, _history: later._history, phaseObligation: later.phaseObligation, _eventSequence: tail });
    expect(await tailOf(store)).toBe(tail);
  });

  /** A document write that fails keeps the verdict and the rows, and the call returns one `PHASE_LEVEL_FAILED` warning. */
  it('Settle_ADocumentLevelFails_KeepsTheVerdictAndWarns', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    const original = store.backend.setState.bind(store.backend);
    const ownDescriptor = Object.getOwnPropertyDescriptor(store.backend, 'setState');
    Object.defineProperty(store.backend, 'setState', {
      configurable: true,
      writable: true,
      value: (featureId: string, state: Parameters<SqliteBackend['setState']>[1], expectedVersion?: number): void => {
        if (state.phase === 'review') throw new BackendVersionConflictError(featureId, expectedVersion ?? 0, (expectedVersion ?? 0) + 1);
        original(featureId, state, expectedVersion);
      },
    });
    releases.push(() => {
      if (ownDescriptor === undefined) Reflect.deleteProperty(store.backend, 'setState');
      else Object.defineProperty(store.backend, 'setState', ownDescriptor);
    });

    const result = await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] });

    const receipt = receiptOf(result);
    expect(receipt.phaseMove?.kind).toBe('moved');
    expect((result.warnings ?? []).filter((warning) => warning.startsWith('PHASE_LEVEL_FAILED'))).toHaveLength(1);
    expect((await store.eventStore.query(STREAM, { type: RECORD_TYPE })).length).toBe(1);
    expect(await phaseRowTypes(store)).toEqual(['workflow.transition', ...MOVE_ROW_TYPES]);
    expect(documentOf(store).phase).not.toBe('review');
  });

  /** A checkpoint counter at the threshold of the default config does not stop the move, and the level resets the counter. */
  it('Settle_ACheckpointCounterAtTheThreshold_StillMoves', async () => {
    const store = await openStore();
    const capsuleVersion = await featureBatchAtDelegate(store, { document: true });
    forgeDocument(store, (document) => ({ _checkpoint: { ...recordOf(document._checkpoint), operationsSince: 20 } }));

    const receipt = receiptOf(await settle(store, { capsuleVersion, batchId: 'batch-1', claims: [completedClaim('task-a')] }));

    expect(receipt.phaseMove?.kind).toBe('moved');
    expect(recordOf(documentOf(store)._checkpoint).operationsSince).toBe(0);
  });
});

describe('the summary of a settle receipt', () => {
  /** The summary keeps the phase move of the receipt, and it drops the list of edge verdicts. */
  it('SettleSummary_KeepsThePhaseMoveWithoutItsEdges', () => {
    const summary = summarizeSettlementReceipt({
      operationId: 'settle:summary',
      outcome: 'settled',
      capsule: { batchId: 'batch-1', capsuleVersion: 1 },
      acceptedTasks: ['task-a'],
      findings: [],
      tailSequence: 9,
      phaseMove: {
        kind: 'stayed',
        phase: 'delegate',
        reason: 'no-edge-admits',
        edges: [{ transitionId: 'delegate->review', to: 'review', verdict: 'deny', falseFacts: ['team.disbandedOk'] }],
      },
    });

    expect(summary.phaseMove).toEqual({ kind: 'stayed', phase: 'delegate', reason: 'no-edge-admits' });
  });
});


describe('settle authority races preserve executed segments', () => {
  it.each([1, 3])('Settle_PreparedRace_PreservesSegmentClaimsAcrossCalls: %s', async changes => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    const definition = pinnedBuiltIn('feature');
    await prepareBatch(store, { definition, taskIds: ['task-a'], stepId: 'delegate' });
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    let attempts = 0;
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      if (id.startsWith('settle:') && ++attempts <= changes) {
        await prepareBatch(store, { definition, taskIds: ['task-a'], stepId: 'delegate', capsuleVersion: attempts + 1 });
      }
      return original(id, digest, closure);
    });
    const args = { capsuleVersion: 1, batchId: 'race-batch', claims: [completedClaim('task-a')] };
    const first = await settle(store, args);
    const completions = await store.eventStore.query(STREAM, { type: 'task.completed' });
    const segments = await store.eventStore.query(STREAM, { type: 'orchestrate.intent_executed' });
    expect(completions).toHaveLength(1);
    expect(segments).toHaveLength(1);
    expect(store.backend.lookupOperationClaim(String(segments[0]?.data?.operationId))).toBeDefined();
    if (changes === 3) {
      expect(first.error?.code).toBe('CONCURRENCY_CONFLICT');
      expect(await store.eventStore.query(STREAM, { type: 'execution.settled' })).toHaveLength(0);
      vi.restoreAllMocks();
      expect(receiptOf(await settle(store, args)).phaseMove).toMatchObject({ kind: 'moved' });
    } else expect(receiptOf(first).phaseMove).toMatchObject({ kind: 'moved' });
    expect(await store.eventStore.query(STREAM, { type: 'task.completed' })).toEqual(completions);
    expect(await store.eventStore.query(STREAM, { type: 'orchestrate.intent_executed' })).toEqual(segments);
  });
  it('Settle_PersistentPublicationFailure_FreshRetryUsesReceiptWithoutCustody', async () => {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')], document: true });
    const current = store.backend.getState(STREAM);
    if (current === null) throw new Error('Missing document');
    store.backend.setState(STREAM, { ...current, phase: 'delegate', tasks: [pending('task-a')], _version: (current._version ?? 1) + 1 });
    await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });
    const appender = store.eventStore.getAppender();
    const original = appender.decideOnce.bind(appender);
    const write = store.backend.setState.bind(store.backend);
    let committed = false;
    vi.spyOn(store.backend, 'setState').mockImplementation((...args) => {
      if (committed) throw new BackendVersionConflictError(1, 2);
      return write(...args);
    });
    vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
      const result = await original(id, digest, closure);
      if (id.startsWith('settle:')) committed = true;
      return result;
    });
    const args = { capsuleVersion: 1, batchId: 'publication', claims: [completedClaim('task-a')] };
    const first = await settle(store, args);
    const accepted = receiptOf(first);
    expect(first).toMatchObject({ success: true });
    const rows = await store.eventStore.query(STREAM);
    const segmentCount = rows.filter(row => row.type === 'orchestrate.intent_executed').length;
    expect(segmentCount).toBe(1);
    await store.eventStore.append(STREAM, { type: 'state.patched', data: { patch: { revisionNote: 'later' } } });
    vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('custody unavailable'));
    const retry = await settle(store, args);
    expect(receiptOf(retry)).toEqual(accepted);
    expect((await settle(store, { ...args, claims: [{ ...completedClaim('task-a'), fields: { changed: true } }] })).error?.code).toBe('OPERATION_DIGEST_MISMATCH');
    expect((await store.eventStore.query(STREAM)).filter(row => row.type === 'orchestrate.intent_executed')).toHaveLength(segmentCount);
    expect(await store.eventStore.query(STREAM, { type: 'execution.settled' })).toHaveLength(1);
  });
});


it('Settle_LateMissingCustody_PreservesSegmentAndNoMove', async () => {
  const store = await openStore();
  await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
  const definition = pinnedBuiltIn('feature');
  await prepareBatch(store, { definition, taskIds: ['task-a'], stepId: 'delegate' });
  const appender = store.eventStore.getAppender();
  const original = appender.decideOnce.bind(appender);
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (id, digest, closure) => {
    if (id.startsWith('settle:')) {
      await prepareBatch(store, { definition, taskIds: ['task-a'], stepId: 'delegate', capsuleVersion: 2 });
      vi.spyOn(store.eventStore.bundleStore, 'resolve').mockRejectedValue(new Error('latest custody unavailable'));
    }
    return original(id, digest, closure);
  });
  const args = { capsuleVersion: 1, batchId: 'missing-latest', claims: [completedClaim('task-a')] };
  expect((await settle(store, args)).error?.code).toBe('CAPSULE_UNRESOLVED');
  expect(await store.eventStore.query(STREAM, { type: 'execution.settled' })).toHaveLength(0);
  const segments = await store.eventStore.query(STREAM, { type: 'orchestrate.intent_executed' });
  expect(segments).toHaveLength(1);
  expect(store.backend.lookupOperationClaim(String(segments[0]?.data?.operationId))).toBeDefined();
  const gates = await store.eventStore.query(STREAM, { type: 'gate.executed' });
  vi.restoreAllMocks();
  const accepted = receiptOf(await settle(store, args));
  expect(accepted.phaseMove).toMatchObject({ kind: 'moved' });
  expect(await store.eventStore.query(STREAM, { type: 'orchestrate.intent_executed' })).toEqual(segments);
  expect(await store.eventStore.query(STREAM, { type: 'gate.executed' })).toEqual(gates);
});

/** The measured fixture keeps its correctness assertions here. Elapsed-time evidence is recorded separately. */
it('Settle_BoundedExistingFixtureBenchmark_SeparatesGateRuntime', async () => {
  let gateRuns = 0;
  for (let iteration = 0; iteration < 5; iteration += 1) {
    const store = await openStore();
    await seedStream(store, { phase: 'delegate', tasks: [pending('task-a')] });
    await prepareBatch(store, { definition: pinnedBuiltIn('feature'), taskIds: ['task-a'], stepId: 'delegate' });
    const execute = executeDeps();
    const gate: LeafHandler = async (...args) => {
      gateRuns += 1;
      return liveHandler('check_mock_boundary')(...args);
    };
    const result = await runWithDispatchContext(correlation(), () => handleSettle(
      { featureId: STREAM, capsuleVersion: 1, batchId: 'benchmark', claims: [completedClaim('task-a')] },
      store.stateDir, wiring(store), { execute: { ...execute, handlers: { ...execute.handlers, check_mock_boundary: gate } } },
    ));
    expect(receiptOf(result).phaseMove).toMatchObject({ kind: 'moved' });
  }
  expect(gateRuns).toBe(5);
});
