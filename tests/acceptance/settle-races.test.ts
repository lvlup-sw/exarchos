/**
 * The races of `settle` through the real dispatcher.
 *
 * Each call goes through `dispatch` with a real caller identity and capability resolver. A one-shot spy on
 * `decideOnce` of the real appender acts before the first settle commit, and it lets each segment commit through.
 * A wrapper of the live static-analysis leaf acts while the segment of one task runs, before its completion leaf.
 * The tasks are low-risk and off the boundary. Thus the ladder runs the production static-analysis gate on a real
 * project, and policy skips the other gates. The cases turn telemetry off.
 *
 * @oracle-sources: ../../src/verbs/settle/handler.ts, the rows of the real event store after each dispatched call, worked out by hand in each case
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch, type DispatchContext } from '../../src/dispatch/core/dispatch.js';
import {
  CapsuleRecompiledData,
  DesignRevisedData,
  DeviationDecidedData,
  ExecutionSettledData,
  OrchestrateIntentExecutedData,
} from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import type { ToolResult } from '../../src/format.js';
import { ACTION_HANDLERS } from '../../src/verbs/composite.js';
import type { SettlementReceipt } from '../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { CURRENT_ES_VERSION } from '../../src/workflow/handlers/shared.js';
import { initStateFile } from '../../src/workflow/state-store.js';
import { makeTempDir, rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-settle-races-acceptance';
const TASK_A = 'task-a';
const TASK_B = 'task-b';
const TASK_C = 'task-c';
/** Real npm scripts: the cheapest processes that exit 0. */
const OK = 'node -e ""';
/** The branch that each task forks from. `prepare` freezes it in the capsule. */
const INTEGRATION_BRANCH = 'feature/settle-races';
/** The material deviation of the held batch. The compiled envelope lists its kind as material. */
const MATERIAL_KIND = 'invalidated-assumption';

let stateDir: string;
let eventStore: EventStore;
/** A real on-disk Node project that the production static-analysis gate passes. */
let greenWorktree: string;
const scratchDirs: string[] = [];

/** One task of the plan, as the planner stamps it: low risk and off the boundary. */
interface PlannedTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly blockedBy: readonly string[];
  readonly riskTier: 'low';
  readonly boundaryTouching: boolean;
}

function plannedTask(id: string): PlannedTask {
  return { id, title: `the work of ${id}`, status: 'pending', blockedBy: [], riskTier: 'low', boundaryTouching: false };
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-races-acceptance-');
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  greenWorktree = await realpath(makeTempDir('settle-races-worktree-'));
  scratchDirs.push(greenWorktree);
  await writeFile(
    path.join(greenWorktree, 'package.json'),
    JSON.stringify({ name: 'settle-races-fixture', version: '1.0.0', private: true, scripts: { lint: OK, typecheck: OK, 'quality-check': OK } }),
    'utf-8',
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

/** The dispatch context of an agent, with telemetry off, so each case reads only the rows of the calls under test. */
function callerContext(): DispatchContext {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'settle-races-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

function call(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  return dispatch(tool, args, callerContext());
}

/**
 * Seeds a feature workflow in `delegate` with its ready tasks. The events that the projection folds and the
 * document that the transition guards read hold the same facts. The document is event-sourced, so the `update`
 * action also appends the patch of a later plan.
 */
async function seedDelegatingFeature(taskIds: readonly string[]): Promise<void> {
  const tasks = taskIds.map(plannedTask);
  await initStateFile(stateDir, STREAM, 'feature', {
    _esVersion: CURRENT_ES_VERSION,
    phase: 'delegate',
    tasks: tasks.map(({ id, title, status }) => ({ id, title, status })),
  });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': INTEGRATION_BRANCH, tasks } },
  });
}

/** Plans the given tasks through the `update` action, after the first capsule. */
async function planTasks(taskIds: readonly string[]): Promise<void> {
  const planned = await call('exarchos_workflow', { action: 'update', featureId: STREAM, updates: { tasks: taskIds.map(plannedTask) } });
  expect(planned.success, JSON.stringify(planned)).toBe(true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a case reads from the receipt of `prepare`: the version, the compiled tasks and the recompile. */
interface PreparedFacts {
  readonly capsuleVersion: number;
  readonly tasks: readonly unknown[];
  readonly recompile: unknown;
}

/** Runs `prepare` and reads its receipt. */
async function prepare(): Promise<PreparedFacts> {
  const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
  expect(prepared.success, JSON.stringify(prepared)).toBe(true);
  const data = prepared.data;
  const capsule = isRecord(data) ? data.capsule : undefined;
  const graph = isRecord(capsule) ? capsule.graph : undefined;
  const tasks = isRecord(graph) && Array.isArray(graph.tasks) ? graph.tasks : [];
  if (!isRecord(data) || typeof data.capsuleVersion !== 'number') throw new Error(`prepare returned no receipt: ${JSON.stringify(prepared)}`);
  return {
    capsuleVersion: data.capsuleVersion,
    tasks: tasks.map((task) => (isRecord(task) ? task.taskId : undefined)),
    recompile: data.recompile,
  };
}

function isReceipt(value: unknown): value is SettlementReceipt {
  return (
    isRecord(value) &&
    typeof value.operationId === 'string' &&
    typeof value.outcome === 'string' &&
    Array.isArray(value.acceptedTasks)
  );
}

/** Runs one `settle` call and reads its receipt. */
async function settle(args: Record<string, unknown>): Promise<SettlementReceipt> {
  const result = await call('exarchos_orchestrate', { action: 'settle', featureId: STREAM, ...args });
  expect(result.success, JSON.stringify(result)).toBe(true);
  if (!isReceipt(result.data)) throw new Error(`settle returned no receipt: ${JSON.stringify(result)}`);
  return result.data;
}

/** A claim that its task is complete, with the worktree of the work. */
function completedClaim(taskId: string): Record<string, unknown> {
  return { taskId, fields: { worktreePath: greenWorktree, files: [`src/${taskId}.ts`] }, evidence: [] };
}

/** A claim that its task waits for a change outside the task. */
function blockedClaim(taskId: string): Record<string, unknown> {
  return { taskId, status: 'blocked', reason: 'waits on a review' };
}

/** Holds a batch on a capsule. Its blocked claim runs no segment, and its material deviation names one task. */
async function holdTheDeviation(capsuleVersion: number, claimed: string, named: string): Promise<SettlementReceipt> {
  const held = await settle({
    capsuleVersion,
    batchId: 'batch-held',
    claims: [blockedClaim(claimed)],
    deviations: [{ deviationKind: MATERIAL_KIND, statement: 'the endpoint reads a cache that the design did not name', affectedTasks: [named] }],
  });
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** The decision round of the held batch, which accepts each pending deviation. */
async function decideTheDeviation(capsuleVersion: number, held: SettlementReceipt): Promise<SettlementReceipt> {
  return settle({
    capsuleVersion,
    batchId: 'batch-held',
    decisions: (held.pendingDeviations ?? []).map(({ deviationId }) => ({
      deviationId,
      decision: 'accepted',
      actor: 'human:reviewer',
      rationale: 'the design did not name the cache, and the change is sound',
    })),
  });
}

/** Another caller completes a task: the gate runs on the worktree, then `task_complete` records the row. */
async function completeElsewhere(taskId: string): Promise<void> {
  const gate = await call('exarchos_orchestrate', { action: 'check_static_analysis', featureId: STREAM, taskId, repoRoot: greenWorktree });
  expect(gate.success, JSON.stringify(gate)).toBe(true);
  const completed = await call('exarchos_orchestrate', {
    action: 'task_complete',
    featureId: STREAM,
    taskId,
    result: { worktreePath: greenWorktree },
  });
  expect(completed.success, JSON.stringify(completed)).toBe(true);
}

/** The operation of each settle commit that the spy saw, in order. */
interface SettleCommits {
  readonly operations: string[];
}

/**
 * A one-shot spy on `decideOnce` of the real appender. Before the first settle commit it runs `race`. A segment
 * commit has an operation id that starts with `settle-task:`, so the spy lets it through and does not record it.
 */
function raceTheFirstSettleCommit(race: () => Promise<void>): SettleCommits {
  const appender = eventStore.getAppender();
  const commit = appender.decideOnce.bind(appender);
  const operations: string[] = [];
  vi.spyOn(appender, 'decideOnce').mockImplementation(async (operationId, requestDigest, closure) => {
    if (operationId.startsWith('settle:')) {
      operations.push(operationId);
      if (operations.length === 1) await race();
    }
    return commit(operationId, requestDigest, closure);
  });
  return { operations };
}

/**
 * A wrapper of the live static-analysis leaf. While the segment of `taskId` runs, it runs `race` once before the gate.
 * The dispatcher reads the leaf from the live table when the segment reaches it.
 */
function raceTheGateOf(taskId: string, race: () => Promise<void>): void {
  const live = ACTION_HANDLERS.check_static_analysis;
  if (live === undefined) throw new Error('the orchestrate table has no check_static_analysis');
  let acted = false;
  vi.spyOn(ACTION_HANDLERS, 'check_static_analysis').mockImplementation(async (args, leafStateDir, leafCtx) => {
    if (!acted && args.taskId === taskId) {
      acted = true;
      await race();
    }
    return live(args, leafStateDir, leafCtx);
  });
}

/** The task of each completion row of the stream, in commit order. */
async function completionRows(): Promise<unknown[]> {
  return (await eventStore.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The batch, the outcome and the round of each settlement record, in commit order. */
async function settlementRows(): Promise<unknown[][]> {
  return (await eventStore.query(STREAM, { type: 'execution.settled' })).map((row) => {
    const record = ExecutionSettledData.parse(row.data);
    return [record.batchId, record.outcome, record.round ?? 0];
  });
}

/** Each finding of a receipt as its kind and its subject. */
function findingsOf(receipt: SettlementReceipt): string[][] {
  return receipt.findings.map((finding) => [finding.kind, finding.subject]);
}

describe('settle races, through the dispatcher', () => {
  /**
   * The batch claims two of three required tasks, so its first read rejects it for the missing claim. Before that
   * commit, another caller completes the third task. The commit reads that row and rolls back. The redo verifies the
   * two claims, and the record lists the third task as already complete, with no missing claim.
   */
  it('SettleRaces_ACompletionThatLandsBeforeTheCommit_IsReadInsideIt', async () => {
    await seedDelegatingFeature([TASK_A, TASK_B, TASK_C]);
    const { capsuleVersion } = await prepare();
    const commits = raceTheFirstSettleCommit(() => completeElsewhere(TASK_C));

    const receipt = await settle({ capsuleVersion, batchId: 'batch-1', claims: [completedClaim(TASK_A), completedClaim(TASK_B)] });

    expect(commits.operations).toEqual([receipt.operationId, receipt.operationId]);
    expect(receipt).toMatchObject({ outcome: 'settled', acceptedTasks: [TASK_A, TASK_B], findings: [] });
    expect(receipt.verification).toEqual(
      expect.arrayContaining([
        { taskId: TASK_C, outcome: 'already-complete' },
        expect.objectContaining({ taskId: TASK_A, outcome: 'verified' }),
        expect.objectContaining({ taskId: TASK_B, outcome: 'verified' }),
      ]),
    );
    expect(receipt.verification).toHaveLength(3);
    const records = (await eventStore.query(STREAM, { type: 'execution.settled' })).map((row) => ExecutionSettledData.parse(row.data));
    expect(records.map((record) => [record.batchId, record.outcome, record.acceptedTasks, record.findingCounts])).toEqual([
      ['batch-1', 'settled', [TASK_A, TASK_B], []],
    ]);
    expect(await completionRows()).toEqual([TASK_C, TASK_A, TASK_B]);
  });

  /**
   * A held batch carries a material deviation that names `task-b`. Its decision round reads `task-b` as pending.
   * Before the commit of the round, a second batch on the next capsule finishes `task-b`. The commit reads that
   * completion and rolls back. The redo refuses the accepted deviation for the finished task, so it revises nothing.
   */
  it('SettleRaces_ADecisionWhoseDeviationNamesATaskASecondBatchFinished_IsRejectedAndRevisesNothing', async () => {
    await seedDelegatingFeature([TASK_A]);
    const first = await prepare();
    await planTasks([TASK_A, TASK_B]);
    const held = await holdTheDeviation(first.capsuleVersion, TASK_A, TASK_B);
    const second = await prepare();
    expect(second.tasks).toEqual([TASK_A, TASK_B]);
    const finished: SettlementReceipt[] = [];
    const commits = raceTheFirstSettleCommit(async () => {
      finished.push(
        await settle({ capsuleVersion: second.capsuleVersion, batchId: 'batch-second', claims: [completedClaim(TASK_A), completedClaim(TASK_B)] }),
      );
    });

    const decided = await decideTheDeviation(first.capsuleVersion, held);

    expect(finished.map((receipt) => [receipt.outcome, receipt.acceptedTasks])).toEqual([['settled', [TASK_A, TASK_B]]]);
    expect(commits.operations).toEqual([decided.operationId, finished[0]?.operationId, decided.operationId]);
    expect(decided.outcome).toBe('rejected');
    expect(decided.round).toBe(1);
    expect(findingsOf(decided)).toEqual([['deviation-names-finished-task', TASK_B]]);
    expect(decided).not.toHaveProperty('designRevision');
    expect(await eventStore.query(STREAM, { type: 'design.revised' })).toEqual([]);
    const decisions = (await eventStore.query(STREAM, { type: 'deviation.decided' })).map((row) => DeviationDecidedData.parse(row.data));
    expect(decisions.map((row) => [row.batchId, row.decision])).toEqual([['batch-held', 'accepted']]);
    expect(await settlementRows()).toEqual([
      ['batch-held', 'deviation-pending', 0],
      ['batch-second', 'settled', 0],
      ['batch-held', 'rejected', 1],
    ]);
    expect(await completionRows()).toEqual([TASK_A, TASK_B]);
  });

  /**
   * While the segment of `task-b` runs, its gate leaf decides a held batch. The accepted material deviation of that
   * batch names `task-b`, so a revision commits before the completion leaf. The leaf refuses the task, and the batch
   * needs a recompile. The task that verified before the change stays complete. The continuation `prepare` compiles `task-b`
   * again, and a batch under the new capsule settles it.
   */
  it('SettleRaces_ARevisionThatLandsWhileABatchVerifies_NeedsARecompileThenSettlesUnderTheContinuation', async () => {
    await seedDelegatingFeature([TASK_A]);
    const first = await prepare();
    await planTasks([TASK_A, TASK_B]);
    const held = await holdTheDeviation(first.capsuleVersion, TASK_A, TASK_B);
    const second = await prepare();
    expect(second.tasks).toEqual([TASK_A, TASK_B]);
    const decided: SettlementReceipt[] = [];
    raceTheGateOf(TASK_B, async () => {
      decided.push(await decideTheDeviation(first.capsuleVersion, held));
    });

    const stale = await settle({
      capsuleVersion: second.capsuleVersion,
      batchId: 'batch-racing',
      claims: [completedClaim(TASK_A), completedClaim(TASK_B)],
    });

    expect(decided.map((receipt) => receipt.designRevision?.nextDesignVersion)).toEqual([2]);
    const revisions = (await eventStore.query(STREAM, { type: 'design.revised' })).map((row) => DesignRevisedData.parse(row.data));
    expect(revisions.map((row) => [row.batchId, row.affectedTasks])).toEqual([['batch-held', [TASK_B]]]);
    expect(stale.outcome).toBe('recompile-required');
    expect(findingsOf(stale)).toEqual([['claim-superseded-by-revision', TASK_B]]);
    expect(stale.acceptedTasks).toEqual([TASK_A]);
    expect(stale.verification).toEqual([expect.objectContaining({ taskId: TASK_A, outcome: 'verified' })]);
    const segments = (await eventStore.query(STREAM, { type: 'orchestrate.intent_executed' })).map((row) =>
      OrchestrateIntentExecutedData.parse(row.data),
    );
    expect(segments.map((segment) => [segment.outcome, segment.failedLeaf])).toEqual([
      ['committed', undefined],
      ['failed', 'task_complete'],
    ]);
    expect(await completionRows()).toEqual([TASK_A]);

    const continuation = await prepare();
    expect(continuation.tasks).toEqual([TASK_B]);
    expect(continuation.recompile).toMatchObject({ priorCapsuleVersion: second.capsuleVersion, invalidatedTasks: [TASK_B] });
    const recompiles = (await eventStore.query(STREAM, { type: 'capsule.recompiled' })).map((row) => CapsuleRecompiledData.parse(row.data));
    expect(recompiles.map((row) => row.capsuleVersion)).toEqual([continuation.capsuleVersion]);

    const settled = await settle({ capsuleVersion: continuation.capsuleVersion, batchId: 'batch-continuation', claims: [completedClaim(TASK_B)] });

    expect(settled).toMatchObject({ outcome: 'settled', acceptedTasks: [TASK_B], findings: [] });
    expect(await completionRows()).toEqual([TASK_A, TASK_B]);
    expect((await settlementRows()).at(-1)).toEqual(['batch-continuation', 'settled', 0]);
  });
});
