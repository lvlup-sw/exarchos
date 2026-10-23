/**
 * Tests for the standing of the named tasks on the decision round of `settle`.
 *
 * A held batch carries a deviation that names a pending task. A second batch finishes that task
 * before the decision round, or another writer completes it before the commit of the round. The
 * round then refuses an accepted deviation that names the finished task, and it revises nothing
 * for that deviation. A rejected deviation keeps its own finding.
 *
 * Each case runs `handleSettle` on a real store. One pure case calls the selector of the revising
 * deviations directly.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows and the receipts that the real store holds after each round, worked out by hand in each case
 */

import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { DesignRevisedData, DeviationDecidedData, type DesignRevised, type DeviationDecided } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import type { ExecuteIntentDeps, LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { resolveWorkflowState } from '../../../../src/verbs/resolve-state.js';
import {
  acceptedMaterialDeviations,
  type ProposedDeviation,
  type TaskStanding,
} from '../../../../src/verbs/settle/adjudicate.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const STREAM = 'feat-settle-decision-standing';
const VERIFY = 'task-verify';
const SECOND = 'task-second';
/** The task that the deviations of the held batches name. No held batch claims it. */
const NAMED = 'task-named';
/** A second pending task that a deviation can name. Nothing finishes it. */
const OTHER = 'task-other';
/** The capsule of the held batches. It lists `invalidated-assumption` as a material kind. */
const HELD_VERSION = 7;
/** The capsule of the second batch, which requires the named task and finishes it. */
const FINISHING_VERSION = 8;
/** Where the claims say the work is. Bare, so the one gate that runs passes advisory. */
const WORKTREE = '/nonexistent-settle-decision-standing-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];
const MATERIAL: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite' };
const OTHER_MATERIAL: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the branch was not main' };
const ACTOR = 'human:reviewer';
const RATIONALE = 'the assumption was wrong and the change is sound';

/**
 * The capsule of the held batches. It requires `task-verify`, and it can verify `task-second` too.
 * Its envelope admits two kinds, requires approval, and lists `invalidated-assumption` as material.
 */
function heldCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    graph: { ...base.graph, tasks: [...base.graph.tasks, { taskId: SECOND, title: 'the second task' }] },
    contracts: {
      ...base.contracts,
      taskResults: {
        ...base.contracts.taskResults,
        [SECOND]: [
          { name: 'passed', type: 'boolean', required: true },
          { name: 'worktreePath', type: 'string', required: false },
        ],
      },
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption', 'missing-context'],
        materialDeviationKinds: ['invalidated-assumption'],
        requiresApproval: true,
      },
    },
    settlementContract: {
      requiredResults: [VERIFY],
      taskVerification: {
        [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        [SECOND]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

/** The capsule of the second batch. It requires the named task only. */
function finishingCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    identity: { ...base.identity, capsuleVersion: FINISHING_VERSION },
    graph: { ...base.graph, tasks: [...base.graph.tasks, { taskId: NAMED, title: 'the named task' }] },
    contracts: {
      ...base.contracts,
      taskResults: {
        ...base.contracts.taskResults,
        [NAMED]: [
          { name: 'passed', type: 'boolean', required: true },
          { name: 'worktreePath', type: 'string', required: false },
        ],
      },
    },
    settlementContract: {
      requiredResults: [NAMED],
      taskVerification: {
        [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        [NAMED]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

const WORKFLOW_ID = heldCapsule().identity.workflowId;

let stateDir: string;
let store: EventStore;

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-decision-standing-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/** The mock-boundary leaf of one call, and the task of each run of it in order. */
interface GateLeaf {
  readonly runs: string[];
  readonly handler: LeafHandler;
}

/** The live mock-boundary leaf, which records each task that it runs for. */
function gateLeaf(): GateLeaf {
  const runs: string[] = [];
  const handler: LeafHandler = async (args, leafStateDir, leafCtx) => {
    runs.push(typeof args.taskId === 'string' ? args.taskId : '');
    return liveHandler('check_mock_boundary')(args, leafStateDir, leafCtx);
  };
  return { runs, handler };
}

/** The collaborators of the executor, with the mock-boundary leaf of the case. */
function executeDeps(gate: LeafHandler): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: gate },
    handlerTool: 'exarchos_orchestrate',
  };
}

/** A claim that its task is complete, with the result fields of the task. */
function completedClaim(taskId: string): Record<string, unknown> {
  return { taskId, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
}

/** A claim that its task waits for a change outside the task. */
function blockedClaim(taskId: string): Record<string, unknown> {
  return { taskId, status: 'blocked', reason: 'waits on a review' };
}

/** One settle call with the given request, under the given mock-boundary leaf. */
async function settle(raw: Record<string, unknown>, gate: GateLeaf = gateLeaf()): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, ...raw }, stateDir, wiring(), { execute: executeDeps(gate.handler) }),
  );
}

function isReceipt(value: unknown): value is SettlementReceipt {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.outcome === 'string' &&
    Array.isArray(value.acceptedTasks)
  );
}

function receiptOf(result: ToolResult): SettlementReceipt {
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isReceipt(result.data)) throw new Error(`the call returned no receipt: ${JSON.stringify(result)}`);
  return result.data;
}

/** Each finding of a receipt as its kind, its subject and its place. */
function findingsOf(receipt: SettlementReceipt): string[][] {
  return receipt.findings.map((finding) => [finding.kind, finding.subject, finding.at]);
}

/** Submits a batch on the held capsule, and returns its receipt. The batch is held for its deviations. */
async function hold(
  batchId: string,
  claims: readonly Record<string, unknown>[],
  deviations: readonly ProposedDeviation[],
): Promise<SettlementReceipt> {
  const held = receiptOf(
    await settle({ capsuleVersion: HELD_VERSION, batchId, claims: [...claims], deviations: [...deviations] }),
  );
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** The decision round of a held batch. `answer` gives the decision for the pending deviation at each position. */
async function decide(
  batchId: string,
  held: SettlementReceipt,
  answer: (position: number) => 'accepted' | 'rejected' = () => 'accepted',
  gate: GateLeaf = gateLeaf(),
): Promise<ToolResult> {
  const decisions = (held.pendingDeviations ?? []).map((pending, position) => ({
    deviationId: pending.deviationId,
    decision: answer(position),
    actor: ACTOR,
    rationale: RATIONALE,
  }));
  return settle({ capsuleVersion: HELD_VERSION, batchId, decisions }, gate);
}

/** A second batch on the finishing capsule verifies the named task and completes it. */
async function finishByASecondBatch(): Promise<void> {
  const finished = receiptOf(
    await settle({ capsuleVersion: FINISHING_VERSION, batchId: 'batch-finishes-the-named-task', claims: [completedClaim(NAMED)] }),
  );
  expect(finished).toMatchObject({ outcome: 'settled', acceptedTasks: [NAMED] });
}

/** Another writer completes a task through the live completion leaf, outside any settle call. */
async function completeTask(taskId: string): Promise<void> {
  const completed = await runWithDispatchContext(correlation(), () =>
    liveHandler('task_complete')({ taskId, featureId: STREAM }, stateDir, wiring()),
  );
  expect(completed.success, JSON.stringify(completed)).toBe(true);
}

/** The settle commits that the spy saw. */
interface SettleCommits {
  readonly count: () => number;
}

/**
 * A spy on `decideOnce` of the real appender. It counts each settle commit, and before each of the
 * first `times` of them it runs `race`. A segment commit has an operation id that starts with
 * `settle-task:`, so the spy lets it through and does not count it.
 */
function raceSettleCommits(times: number, race: () => Promise<void>): SettleCommits {
  const appender = store.getAppender();
  const commit = appender.decideOnce.bind(appender);
  let commits = 0;
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (operationId, requestDigest, closure) => {
    if (operationId.startsWith('settle:')) {
      commits += 1;
      if (commits <= times) await race();
    }
    return commit(operationId, requestDigest, closure);
  });
  return { count: () => commits };
}

/** The operation of the segment of one task, from the settle operation and the task. */
function segmentOperationOf(settleOperation: string, taskId: string): string {
  const key = `${settleOperation}${String.fromCharCode(0)}${taskId}`;
  return `settle-task:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** The task of each completion row of the stream, in commit order. */
async function completionRows(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The design revisions of the stream, in commit order. */
async function revisionRows(): Promise<DesignRevised[]> {
  return (await store.query(STREAM, { type: 'design.revised' })).map((row) => DesignRevisedData.parse(row.data));
}

/** The decision rows of the stream, in commit order. */
async function decisionRows(): Promise<DeviationDecided[]> {
  return (await store.query(STREAM, { type: 'deviation.decided' })).map((row) => DeviationDecidedData.parse(row.data));
}

/** Records one capsule as prepared, through the production commit. */
async function seedPrepared(capsule: ExarchosCapsuleV1): Promise<void> {
  await runWithDispatchContext(correlation(), () =>
    commitPreparedCapsule(wiring(), {
      streamId: STREAM,
      operationId: `seed:${capsule.identity.capsuleVersion}`,
      requestDigest: `sha256:seed-${capsule.identity.capsuleVersion}`,
      workflowType: 'feature',
      capsule,
      definition: WorkflowDefinitionV1Schema.parse(baseValidDefinition()),
    }),
  );
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-decision-standing-');
  store = new EventStore(stateDir);
  await store.initialize();
  const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  for (const taskId of [VERIFY, SECOND, NAMED, OTHER]) {
    await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId, stateDir, phaseAttemptId });
  }
  await store.append(STREAM, {
    type: 'state.patched',
    data: {
      patch: {
        tasks: [VERIFY, SECOND, NAMED, OTHER].map((id) => ({ id, title: `the work of ${id}`, status: 'pending' })),
      },
    },
  });
  await seedPrepared(heldCapsule());
  await seedPrepared(finishingCapsule());
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await rmrfAsync(stateDir);
});

describe('settle — the decision round reads the standing of the named tasks', () => {
  /**
   * The held batch claims `task-verify`, and its material deviation names the pending `task-named`.
   * A second batch finishes `task-named` before the round. The round accepts the deviation and is
   * rejected for the finished task. It runs no gate, completes no task and records no revision.
   * It still records its decision.
   */
  it('Settle_ADecisionWhoseDeviationNamesAFinishedTask_IsRejectedVerifiesNothingAndRevisesNothing', async () => {
    const held = await hold('batch-held', [completedClaim(VERIFY)], [{ ...MATERIAL, affectedTasks: [NAMED] }]);
    await finishByASecondBatch();
    const gate = gateLeaf();

    const decided = receiptOf(await decide('batch-held', held, () => 'accepted', gate));

    expect(decided.outcome).toBe('rejected');
    expect(decided.round).toBe(1);
    expect(findingsOf(decided)).toEqual([['deviation-names-finished-task', NAMED, 'deviations[0].affectedTasks[0]']]);
    expect(decided.findings[0]?.message).toContain('plan the rework as a new task');
    expect(decided.adjudicated.decisions).toBe(1);
    expect(decided.verification).toEqual([]);
    expect(decided).not.toHaveProperty('designRevision');
    expect(gate.runs).toEqual([]);
    expect(await completionRows()).toEqual([NAMED]);
    expect(await revisionRows()).toEqual([]);
    expect((await decisionRows()).map((row) => [row.batchId, row.deviationId, row.decision])).toEqual([
      ['batch-held', held.pendingDeviations?.[0]?.deviationId, 'accepted'],
    ]);
  });

  /**
   * The round accepts two material deviations. The second batch finished the task that the first names,
   * and nothing finished the task of the other. The one revision row names only the other deviation and its task.
   */
  it('Settle_TwoAcceptedMaterialDeviations_RevisesOnlyForTheOneThatNamesNoFinishedTask', async () => {
    const held = await hold(
      'batch-two-deviations',
      [completedClaim(VERIFY)],
      [
        { ...MATERIAL, affectedTasks: [NAMED] },
        { ...OTHER_MATERIAL, affectedTasks: [OTHER] },
      ],
    );
    const otherId = held.pendingDeviations?.[1]?.deviationId;
    await finishByASecondBatch();

    const decided = receiptOf(await decide('batch-two-deviations', held));

    expect(decided.outcome).toBe('rejected');
    expect(findingsOf(decided)).toEqual([['deviation-names-finished-task', NAMED, 'deviations[0].affectedTasks[0]']]);
    expect(decided.adjudicated.decisions).toBe(2);
    expect(await decisionRows()).toHaveLength(2);
    const revisions = await revisionRows();
    expect(revisions.map((row) => [row.batchId, row.deviationIds, row.affectedTasks])).toEqual([
      ['batch-two-deviations', [otherId], [OTHER]],
    ]);
    expect(decided.designRevision).toStrictEqual({ priorDesignVersion: 1, nextDesignVersion: 2, deviationIds: [otherId] });
  });

  /**
   * Both deviations name the finished task. The decision rejects the first and accepts the second.
   * The first gets `deviation-rejected` only, and the second shows that the round read the standing.
   * The census counts both decisions.
   */
  it('Settle_ARejectedDeviationNamingAFinishedTask_KeepsDeviationRejected', async () => {
    const held = await hold(
      'batch-rejected-deviation',
      [completedClaim(VERIFY)],
      [
        { ...MATERIAL, affectedTasks: [NAMED] },
        { ...OTHER_MATERIAL, affectedTasks: [NAMED] },
      ],
    );
    await finishByASecondBatch();

    const decided = receiptOf(
      await decide('batch-rejected-deviation', held, (position) => (position === 0 ? 'rejected' : 'accepted')),
    );

    expect(decided.outcome).toBe('rejected');
    expect(findingsOf(decided)).toEqual([
      ['deviation-rejected', 'invalidated-assumption', 'deviations[0].deviationKind'],
      ['deviation-names-finished-task', NAMED, 'deviations[1].affectedTasks[0]'],
    ]);
    expect(decided.adjudicated.decisions).toBe(2);
    expect(await revisionRows()).toEqual([]);
    expect((await decisionRows()).map((row) => row.decision)).toEqual(['rejected', 'accepted']);
  });

  /**
   * A keyed patch makes the fold of the plan throw, so the workflow state does not resolve on the decision round.
   * The completion row of `task-named` still refuses the deviation that names it, and the call does not fail.
   * A blocked batch whose deviation names the pending `task-other` is decided, and it records its revision.
   */
  it('Settle_ADecisionWhenThePlanDoesNotResolve_UsesTheCompletionRows', async () => {
    const named = await hold('batch-names-the-finished-task', [completedClaim(VERIFY)], [{ ...MATERIAL, affectedTasks: [NAMED] }]);
    const pending = await hold('batch-names-a-pending-task', [blockedClaim(VERIFY)], [{ ...OTHER_MATERIAL, affectedTasks: [OTHER] }]);
    await finishByASecondBatch();
    await store.append(STREAM, { type: 'state.patched', data: { patch: { [`tasks[id=${OTHER}].status`]: 'complete' } } });
    const resolved = await resolveWorkflowState({ featureId: STREAM, eventStore: store });
    expect('error' in resolved).toBe(true);

    const refused = receiptOf(await decide('batch-names-the-finished-task', named));
    expect(refused.outcome).toBe('rejected');
    expect(findingsOf(refused)).toEqual([['deviation-names-finished-task', NAMED, 'deviations[0].affectedTasks[0]']]);
    expect(refused).not.toHaveProperty('designRevision');

    const admitted = receiptOf(await decide('batch-names-a-pending-task', pending));
    expect(admitted.outcome).toBe('corrective-capsule');
    expect(findingsOf(admitted)).toEqual([['task-blocked', VERIFY, 'claims[0]']]);
    expect(admitted.designRevision).toStrictEqual({
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: [pending.pendingDeviations?.[0]?.deviationId],
    });
    expect((await revisionRows()).map((row) => [row.batchId, row.affectedTasks])).toEqual([
      ['batch-names-a-pending-task', [OTHER]],
    ]);
  });
});

describe('settle — a named task that completes before the commit of the decision round', () => {
  /**
   * The held claim is blocked, so the round runs no segment. Another writer completes `task-named` after the last
   * read of the round and before its commit. The commit rolls back, and the redo is rejected with no revision.
   */
  it('Settle_ADecisionWhoseNamedTaskIsCompletedBeforeTheCommit_IsRejectedAndRevisesNothing', async () => {
    const held = await hold('batch-held-blocked', [blockedClaim(VERIFY)], [{ ...MATERIAL, affectedTasks: [NAMED] }]);
    const gate = gateLeaf();
    const commits = raceSettleCommits(1, () => completeTask(NAMED));

    const decided = receiptOf(await decide('batch-held-blocked', held, () => 'accepted', gate));

    expect(commits.count()).toBe(2);
    expect(decided.outcome).toBe('rejected');
    expect(findingsOf(decided)).toEqual([
      ['task-blocked', VERIFY, 'claims[0]'],
      ['deviation-names-finished-task', NAMED, 'deviations[0].affectedTasks[0]'],
    ]);
    expect(decided).not.toHaveProperty('designRevision');
    expect(gate.runs).toEqual([]);
    expect(await revisionRows()).toEqual([]);
    expect(await decisionRows()).toHaveLength(1);
    expect(await completionRows()).toEqual([NAMED]);
  });

  /**
   * The held claims run their segments on the decision round, and each one verifies. Then another writer
   * completes `task-named` before the commit. The redo is rejected, and the verified tasks stay complete.
   * The receipt lists them in `acceptedTasks` and in its verification, with their segment operations.
   */
  it('Settle_ADecisionWhoseNamedTaskIsCompletedAfterItsSegments_KeepsTheVerifiedTasks', async () => {
    const held = await hold(
      'batch-held-completed',
      [completedClaim(VERIFY), completedClaim(SECOND)],
      [{ ...MATERIAL, affectedTasks: [NAMED] }],
    );
    const gate = gateLeaf();
    const commits = raceSettleCommits(1, () => completeTask(NAMED));

    const decided = receiptOf(await decide('batch-held-completed', held, () => 'accepted', gate));

    expect(commits.count()).toBe(2);
    expect(gate.runs).toEqual([SECOND, VERIFY]);
    expect(decided.outcome).toBe('rejected');
    expect(findingsOf(decided)).toEqual([['deviation-names-finished-task', NAMED, 'deviations[0].affectedTasks[0]']]);
    expect(decided.acceptedTasks).toEqual([SECOND, VERIFY]);
    expect(decided.verification).toEqual([
      expect.objectContaining({ taskId: SECOND, outcome: 'verified', operationId: segmentOperationOf(decided.operationId, SECOND) }),
      expect.objectContaining({ taskId: VERIFY, outcome: 'verified', operationId: segmentOperationOf(decided.operationId, VERIFY) }),
    ]);
    expect(decided).not.toHaveProperty('designRevision');
    expect(await revisionRows()).toEqual([]);
    expect(await completionRows()).toEqual([SECOND, VERIFY, NAMED]);
  });
});

/** The selector of the deviations that revise the design, with the standing of the named tasks. */
describe('the accepted material deviations of a decision round', () => {
  /**
   * Each deviation is accepted and of a material kind. Without a standing, the selector keeps all four.
   * With a standing, it drops each deviation that names a finished task. A standing of `unknown` drops nothing.
   */
  it('AcceptedMaterialDeviations_ADeviationNamingAFinishedTask_IsNotSelected', () => {
    const namesFinished: ProposedDeviation = { ...MATERIAL, affectedTasks: [NAMED] };
    const namesPending: ProposedDeviation = { ...OTHER_MATERIAL, affectedTasks: [OTHER] };
    const namesBoth: ProposedDeviation = {
      deviationKind: 'invalidated-assumption',
      statement: 'the queue was not ordered',
      affectedTasks: [NAMED, OTHER],
    };
    const namesNone: ProposedDeviation = { deviationKind: 'invalidated-assumption', statement: 'the cache was cold' };
    const round = [namesFinished, namesPending, namesBoth, namesNone];
    const acceptEach = (): 'accepted' => 'accepted';
    const standing = (taskId: string): TaskStanding => (taskId === NAMED ? { kind: 'finished' } : { kind: 'pending' });

    expect(acceptedMaterialDeviations(heldCapsule(), round, acceptEach)).toEqual(round);
    expect(acceptedMaterialDeviations(heldCapsule(), round, acceptEach, standing)).toEqual([namesPending, namesNone]);
    expect(acceptedMaterialDeviations(heldCapsule(), round, acceptEach, () => ({ kind: 'unknown' }))).toEqual(round);
  });
});
