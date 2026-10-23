/**
 * Tests for a design revision that commits while a settle segment runs.
 *
 * The gate leaf of the claimed task decides another held batch. That decision round accepts a
 * material deviation that names the task, so it commits a revision before the completion leaf runs.
 * The completion leaf gets the capsule version of the batch, so it refuses the task, and the read
 * after the segments makes the batch stale. A continuation that prepare records in the same window
 * does not let the earlier batch complete the task.
 *
 * Each case runs `handleSettle` on a real store, with the shipped leaves cut to the two that run in the process.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows that the real store holds and the leaf arguments recorded in each case, worked out by hand
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { DesignRevisedData, OrchestrateIntentExecutedData } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import { INTENT_EXECUTED_EVENT, type ExecuteIntentDeps, type LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { ProposedDeviation } from '../../../../src/verbs/settle/adjudicate.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import type { SettlementReceipt } from '../../../../src/verbs/settle/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const STREAM = 'feat-settle-revision-race';
/** The task that the racing batch claims, and that the deviation of the held batch names. */
const VERIFY = 'task-verify';
/** The task that the held batch claims as blocked, so its decision round runs no segment. */
const HOLDER = 'task-holder';
/** The capsule of the held batch. It lists `invalidated-assumption` as a material kind. */
const HELD_VERSION = 7;
/** The capsule of the batch that races the revision. */
const RACE_VERSION = 8;
/** The continuation capsule that a prepare records after the revision. */
const CONTINUATION_VERSION = 9;
/** Where the claims say the work is. Bare, so the one gate that runs passes advisory. */
const WORKTREE = '/nonexistent-settle-revision-race-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];
const MATERIAL: ProposedDeviation = {
  deviationKind: 'invalidated-assumption',
  statement: 'the store was not SQLite',
  affectedTasks: [VERIFY],
};

/**
 * The capsule of the held batch. It requires `task-holder` only, and it holds terms for both tasks.
 * Its envelope requires approval and lists `invalidated-assumption` as material.
 */
function heldCapsule(): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return {
    ...base,
    graph: { ...base.graph, tasks: [...base.graph.tasks, { taskId: HOLDER, title: 'the holder task' }] },
    contracts: {
      ...base.contracts,
      taskResults: {
        ...base.contracts.taskResults,
        [HOLDER]: [
          { name: 'passed', type: 'boolean', required: true },
          { name: 'worktreePath', type: 'string', required: false },
        ],
      },
      deviationEnvelope: {
        allowedDeviationKinds: ['invalidated-assumption'],
        materialDeviationKinds: ['invalidated-assumption'],
        requiresApproval: true,
      },
    },
    settlementContract: {
      requiredResults: [HOLDER],
      taskVerification: {
        [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        [HOLDER]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

/** The base capsule under another version and design version. It requires `task-verify`. */
function verifyCapsule(capsuleVersion: number, designVersion: string): ExarchosCapsuleV1 {
  const base = baseValidCapsule();
  return { ...base, identity: { ...base.identity, capsuleVersion, designVersion } };
}

let stateDir: string;
let store: EventStore;

function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-revision-race-fixture' });
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

/** The live mock-boundary leaf. `before` acts once for `task-verify`, before the gate judges, while the segment runs. */
function gateLeaf(before?: () => Promise<void>): LeafHandler {
  let acted = false;
  return async (args, leafStateDir, leafCtx) => {
    if (before !== undefined && !acted && args.taskId === VERIFY) {
      acted = true;
      await before();
    }
    return liveHandler('check_mock_boundary')(args, leafStateDir, leafCtx);
  };
}

/** One run of the completion leaf: the task, the capsule version that the leaf got, and the code of a refusal. */
interface CompletionRun {
  readonly taskId: unknown;
  readonly capsuleVersion: unknown;
  readonly refusal: string | undefined;
}

/** The live completion leaf, which records each run. */
interface CompletionLeaf {
  readonly runs: CompletionRun[];
  readonly handler: LeafHandler;
}

function completionLeaf(): CompletionLeaf {
  const runs: CompletionRun[] = [];
  const handler: LeafHandler = async (args, leafStateDir, leafCtx) => {
    const result = await liveHandler('task_complete')(args, leafStateDir, leafCtx);
    runs.push({ taskId: args.taskId, capsuleVersion: args.capsuleVersion, refusal: result.success ? undefined : result.error?.code });
    return result;
  };
  return { runs, handler };
}

/** The collaborators of the executor, with the gate leaf and the completion leaf of the call. */
function executeDeps(gate: LeafHandler, completion: LeafHandler): ExecuteIntentDeps {
  const schema = INTENT_ARG_SCHEMAS['task-completion'];
  if (schema === undefined) throw new Error('no argument schema for task-completion');
  return {
    runbookTable: [noShellTaskCompletion()],
    findAction: findActionInRegistry,
    argSchemas: { 'task-completion': schema },
    handlers: { ...ACTION_HANDLERS, check_mock_boundary: gate, task_complete: completion },
    handlerTool: 'exarchos_orchestrate',
  };
}

/** A claim that its task is complete, with the result fields of the task. */
function completedClaim(taskId: string): Record<string, unknown> {
  return { taskId, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] };
}

/** One settle call with the given request. */
async function settle(
  raw: Record<string, unknown>,
  gate: LeafHandler = gateLeaf(),
  completion: CompletionLeaf = completionLeaf(),
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, ...raw }, stateDir, wiring(), { execute: executeDeps(gate, completion.handler) }),
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

/** Each finding of a receipt as its kind and its subject. */
function findingsOf(receipt: SettlementReceipt): string[][] {
  return receipt.findings.map((finding) => [finding.kind, finding.subject]);
}

/** Holds a batch on the held capsule. Its blocked claim runs no segment, and its deviation names `task-verify`. */
async function holdTheDeviation(): Promise<SettlementReceipt> {
  const held = receiptOf(
    await settle({
      capsuleVersion: HELD_VERSION,
      batchId: 'batch-held',
      claims: [{ taskId: HOLDER, status: 'blocked', reason: 'waits on a review' }],
      deviations: [MATERIAL],
    }),
  );
  expect(held.outcome).toBe('deviation-pending');
  return held;
}

/** The decision round of the held batch. It accepts the deviation, so it commits a revision that names `task-verify`. */
async function decideTheDeviation(held: SettlementReceipt): Promise<SettlementReceipt> {
  const decisions = (held.pendingDeviations ?? []).map((pending) => ({
    deviationId: pending.deviationId,
    decision: 'accepted',
    actor: 'human:reviewer',
    rationale: 'the assumption was wrong and the change is sound',
  }));
  return receiptOf(await settle({ capsuleVersion: HELD_VERSION, batchId: 'batch-held', decisions }));
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

/** The task of each completion row of the stream, in commit order. */
async function completionRows(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The batch and the named tasks of each design revision of the stream, in commit order. */
async function revisionRows(): Promise<unknown[][]> {
  return (await store.query(STREAM, { type: 'design.revised' })).map((row) => {
    const revision = DesignRevisedData.parse(row.data);
    return [revision.batchId, revision.affectedTasks];
  });
}

/** The outcome and the halted leaf of each segment row of the stream, in commit order. */
async function segmentRows(): Promise<unknown[][]> {
  return (await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).map((row) => {
    const segment = OrchestrateIntentExecutedData.parse(row.data);
    return [segment.outcome, segment.failedLeaf];
  });
}

/** The sequence of the first row of one type, or of the prepared record of one capsule version. */
async function sequenceOf(type: string, capsuleVersion?: number): Promise<number> {
  const row = (await store.query(STREAM, { type })).find(
    (candidate) => capsuleVersion === undefined || (isRecord(candidate.data) && candidate.data.capsuleVersion === capsuleVersion),
  );
  if (row === undefined) throw new Error(`the stream holds no ${type} row`);
  return row.sequence;
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-revision-race-');
  store = new EventStore(stateDir);
  await store.initialize();
  const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  for (const taskId of [VERIFY, HOLDER]) {
    await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId, stateDir, phaseAttemptId });
  }
  await store.append(STREAM, {
    type: 'state.patched',
    data: { patch: { tasks: [VERIFY, HOLDER].map((id) => ({ id, title: `the work of ${id}`, status: 'pending' })) } },
  });
  await seedPrepared(heldCapsule());
  await seedPrepared(verifyCapsule(RACE_VERSION, 'design-1'));
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('settle — a revision that commits while a segment runs', () => {
  /**
   * The gate leaf of `task-verify` decides the held batch, and the round commits a revision that names the task.
   * The completion leaf then refuses the task, so no completion row exists. The read after the segment is stale,
   * and that judgement decides the record. The call does not fail on the refused leaf.
   */
  it('Settle_ARevisionOfAClaimedTaskWhileItsSegmentRuns_GivesRecompileRequiredWithNoCompletionRow', async () => {
    const held = await holdTheDeviation();
    const decided: SettlementReceipt[] = [];
    const completion = completionLeaf();

    const result = await settle(
      { capsuleVersion: RACE_VERSION, batchId: 'batch-race', claims: [completedClaim(VERIFY)] },
      gateLeaf(async () => {
        decided.push(await decideTheDeviation(held));
      }),
      completion,
    );

    expect(decided.map((receipt) => [receipt.outcome, receipt.designRevision?.nextDesignVersion])).toEqual([
      ['corrective-capsule', 2],
    ]);
    const receipt = receiptOf(result);
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([['claim-superseded-by-revision', VERIFY]]);
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.verification).toEqual([]);
    expect(completion.runs).toEqual([{ taskId: VERIFY, capsuleVersion: RACE_VERSION, refusal: 'TASK_SUPERSEDED_BY_REVISION' }]);
    expect(await segmentRows()).toEqual([['failed', 'task_complete']]);
    expect(await completionRows()).toEqual([]);
    expect(await revisionRows()).toEqual([['batch-held', [VERIFY]]]);
  });

  /**
   * While the segment runs, the decision round revises `task-verify`, and a prepare records the continuation after it.
   * The latest prepared record is then after the revision. The leaf reads the revisions after the capsule of the batch,
   * so it still refuses the task. A batch under the continuation then settles the task.
   */
  it('Settle_AContinuationPreparedWhileABatchVerifies_DoesNotLetItCompleteTheRevisedTask', async () => {
    const held = await holdTheDeviation();
    const completion = completionLeaf();

    const result = await settle(
      { capsuleVersion: RACE_VERSION, batchId: 'batch-race', claims: [completedClaim(VERIFY)] },
      gateLeaf(async () => {
        await decideTheDeviation(held);
        await seedPrepared(verifyCapsule(CONTINUATION_VERSION, 'design-2'));
      }),
      completion,
    );

    expect(await sequenceOf('workflow.prepared', CONTINUATION_VERSION)).toBeGreaterThan(await sequenceOf('design.revised'));
    expect(await completionRows()).toEqual([]);
    const receipt = receiptOf(result);
    expect(receipt.outcome).toBe('recompile-required');
    expect(findingsOf(receipt)).toEqual([['claim-superseded-by-revision', VERIFY]]);
    expect(completion.runs).toEqual([{ taskId: VERIFY, capsuleVersion: RACE_VERSION, refusal: 'TASK_SUPERSEDED_BY_REVISION' }]);

    const continued = receiptOf(
      await settle({ capsuleVersion: CONTINUATION_VERSION, batchId: 'batch-continuation', claims: [completedClaim(VERIFY)] }),
    );

    expect(continued).toMatchObject({ outcome: 'settled', acceptedTasks: [VERIFY], findings: [] });
    expect(await completionRows()).toEqual([VERIFY]);
  });
});

describe('settle — the arguments of the completion leaf', () => {
  /**
   * Two batches settle on two capsules. The completion leaf of each gets the capsule version of its own batch,
   * not the latest prepared record of the stream.
   */
  it('Settle_TheCompletionLeaf_CarriesTheCapsuleVersion', async () => {
    const completion = completionLeaf();

    const race = receiptOf(
      await settle({ capsuleVersion: RACE_VERSION, batchId: 'batch-verify', claims: [completedClaim(VERIFY)] }, gateLeaf(), completion),
    );
    const holder = receiptOf(
      await settle({ capsuleVersion: HELD_VERSION, batchId: 'batch-holder', claims: [completedClaim(HOLDER)] }, gateLeaf(), completion),
    );

    expect([race.outcome, holder.outcome]).toEqual(['settled', 'settled']);
    expect(completion.runs).toEqual([
      { taskId: VERIFY, capsuleVersion: RACE_VERSION, refusal: undefined },
      { taskId: HOLDER, capsuleVersion: HELD_VERSION, refusal: undefined },
    ]);
    expect(await completionRows()).toEqual([VERIFY, HOLDER]);
  });
});
