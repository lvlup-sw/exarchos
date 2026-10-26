/**
 * Tests for the commit of `settle`, which judges the batch again from the rows of its write transaction.
 *
 * Each case runs `handleSettle` on a real store. Another writer acts between the last read of an
 * attempt and its commit, through one of two seams. The first seam is a bundle store that acts before
 * it puts the bundle. The second is a spy on `decideOnce` that acts before each settle commit, and
 * lets each segment commit through. A changed judgement rolls the commit back, and the call reads again.
 *
 * @oracle-sources: ../../../../src/verbs/settle/handler.ts, the rows and the operation claims that the real store holds after each call, and the bundles that each attempt put in custody
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { CapsuleScope, ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { canonicalJson } from '../../../../src/contract/request-context.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import type { BundleRefV1 } from '../../../../src/events/bundle/digest-references.js';
import { RunBundleStore } from '../../../../src/events/bundle/run-bundle-store.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  DesignRevisedData,
  ExecutionSettledData,
  OrchestrateIntentExecutedData,
  type ExecutionSettled,
} from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import { INTENT_EXECUTED_EVENT, type ExecuteIntentDeps, type LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { ladderRequirementId } from '../../../../src/verbs/gates/durable-gate-producer.js';
import { designVersionOf } from '../../../../src/verbs/prepare/design-version.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import { decodeSettlementBundle, type SettlementBundleV1 } from '../../../../src/verbs/settle/settlement-bundle.js';
import type { SettlementReceipt, SettlementVerificationTrace } from '../../../../src/verbs/settle/types.js';
import type { ArtifactId } from '../../../../src/workflow/admission/types.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { initStateFile, readStateFile } from '../../../../src/workflow/state-store.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt, seedGateEvidence } from '../../../../tools/test-helpers/trusted-context.js';
import { inScopeObserver, scopeOfCheckout, withScope } from '../../../helpers/scoped-capsule.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const STREAM = 'feat-settle-in-commit';
const VERIFY = 'task-verify';
const SECOND = 'task-second';
const CAPSULE_VERSION = 7;
const DIGEST = { algorithm: 'sha256', value: 'a'.repeat(64) };
/** Where the claims say the work is. Bare, so the one gate that runs passes advisory. */
const WORKTREE = '/nonexistent-settle-in-commit-worktree';

/**
 * The worktree that the claim, the seed and the completion of one task name. Each task has a path of its own.
 * `task-verify` keeps the bare path.
 */
function worktreeOf(taskId: string): string {
  return taskId === VERIFY ? WORKTREE : `${WORKTREE}/${taskId}`;
}
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];

/** The base capsule with a second task beside `task-verify`. Both tasks are required, and both have terms. */
function twoTaskCapsule(): ExarchosCapsuleV1 {
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
    },
    settlementContract: {
      requiredResults: [VERIFY, SECOND],
      taskVerification: {
        [VERIFY]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
        [SECOND]: { riskTier: 'low', boundaryTouching: false, baseRef: 'feature/capsule-corpus' },
      },
    },
  };
}

const WORKFLOW_ID = twoTaskCapsule().identity.workflowId;

let stateDir: string;
let store: EventStore;
let phaseAttemptId: string;
/** The scope that each seeded capsule pins: a temp checkout with no config, so its digest matches. */
let scope: CapsuleScope;

/** The wiring of one call. The observer of a claimed worktree finds each claimed path in the pinned scope. */
function wiring(): DispatchContext {
  return { stateDir, eventStore: store, enableTelemetry: false, treeObserver: inScopeObserver(scope) };
}

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settle-in-commit-fixture' });
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

/**
 * The mock-boundary leaf, which records each task that it runs for. `before` acts before the gate
 * judges, as another writer does while a segment runs. The gate refuses the task that `refuse` names.
 */
function gateLeaf(options: { readonly refuse?: string; readonly before?: (taskId: string) => Promise<void> } = {}): GateLeaf {
  const runs: string[] = [];
  const handler: LeafHandler = async (args, leafStateDir, leafCtx) => {
    const taskId = typeof args.taskId === 'string' ? args.taskId : '';
    runs.push(taskId);
    if (options.before !== undefined) await options.before(taskId);
    if (taskId === options.refuse) {
      return { success: false, error: { code: 'GATE_BLOCKED', message: `the gate refuses ${taskId}` } };
    }
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
  return { taskId, fields: { passed: true, worktreePath: worktreeOf(taskId) }, evidence: [] };
}

/** A claim that its task waits for a change outside the task. */
function blockedClaim(taskId: string): Record<string, unknown> {
  return { taskId, status: 'blocked', reason: 'waits on a review' };
}

/** One settle call for a batch on the prepared capsule. */
async function settle(
  batchId: string,
  claims: readonly Record<string, unknown>[],
  gate: GateLeaf,
  bundleStore?: RunBundleStore,
): Promise<ToolResult> {
  return runWithDispatchContext(correlation(), () =>
    handleSettle({ featureId: STREAM, capsuleVersion: CAPSULE_VERSION, batchId, claims: [...claims] }, stateDir, wiring(), {
      execute: executeDeps(gate.handler),
      ...(bundleStore !== undefined ? { bundleStore } : {}),
    }),
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

/** The trace of one task on a receipt. */
function traceOf(receipt: SettlementReceipt, taskId: string): SettlementVerificationTrace | undefined {
  return receipt.verification?.find((trace) => trace.taskId === taskId);
}

/** Another writer completes a task through the live completion leaf, outside any settle call, on the worktree of the task. */
async function completeTask(taskId: string): Promise<void> {
  const completed = await runWithDispatchContext(correlation(), () =>
    liveHandler('task_complete')(
      { taskId, featureId: STREAM, result: { worktreePath: worktreeOf(taskId) } },
      stateDir,
      wiring(),
    ),
  );
  expect(completed.success, JSON.stringify(completed)).toBe(true);
}

/**
 * Another decision round records a design revision that names the tasks. The row stands for the
 * revision of a concurrent round, and it takes the next design version of the stream.
 */
async function reviseDesign(taskIds: readonly string[]): Promise<void> {
  const prior = designVersionOf(await store.query(STREAM));
  await store.append(STREAM, {
    type: 'design.revised',
    data: DesignRevisedData.parse({
      operationId: `settle:another-round-${prior}`,
      workflowId: WORKFLOW_ID,
      capsuleVersion: CAPSULE_VERSION,
      batchId: `batch-another-round-${prior}`,
      priorDesignVersion: prior,
      nextDesignVersion: prior + 1,
      deviationIds: [`dev:another-round-${prior}`],
      affectedTasks: [...taskIds],
      bundleRefs: [{ artifactId: 'run-bundle:settlement:wf-capsule-corpus:1', digest: DIGEST }],
    }),
  });
}

/** A row that no verdict reads, as an unrelated writer appends one. It moves the tail of the stream. */
async function appendUnrelatedRow(): Promise<void> {
  await store.append(STREAM, { type: 'state.patched', data: { patch: { 'artifacts.notes': 'moved' } } });
}

/** The settle commits that the spy saw, and the way to remove the spy. */
interface SettleCommits {
  readonly count: () => number;
  readonly restore: () => void;
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
  const spy = vi.spyOn(appender, 'decideOnce').mockImplementation(async (operationId, requestDigest, closure) => {
    if (operationId.startsWith('settle:')) {
      commits += 1;
      if (commits <= times) await race();
    }
    return commit(operationId, requestDigest, closure);
  });
  return { count: () => commits, restore: () => spy.mockRestore() };
}

/**
 * A bundle store that acts before its first put, which is after the last read of the first attempt.
 * It keeps each bundle that the call put and the reference of each put.
 */
class RacingBundleStore extends RunBundleStore {
  readonly puts: SettlementBundleV1[] = [];
  readonly refs: BundleRefV1[] = [];
  private readonly race: () => Promise<void>;

  constructor(race: () => Promise<void>) {
    super(store.bundleStore.root);
    this.race = race;
  }

  override async putThenReference<T>(
    artifactId: ArtifactId,
    bytes: Uint8Array,
    commit: (ref: BundleRefV1) => Promise<T>,
  ): Promise<T> {
    this.puts.push(decodeSettlementBundle(bytes));
    if (this.puts.length === 1) await this.race();
    return super.putThenReference(artifactId, bytes, async (ref) => {
      this.refs.push(ref);
      return commit(ref);
    });
  }
}

/** A bundle store whose put fails, so the call ends after its segments and records no verdict. */
class FailingBundleStore extends RunBundleStore {
  constructor() {
    super(store.bundleStore.root);
  }

  override async putThenReference<T>(): Promise<T> {
    throw new Error('the bundle store refused the put');
  }
}

/** The operation of a settle call for a batch, from the batch identity alone. */
function settleOperationOf(batchId: string): string {
  const key = canonicalJson({ streamId: STREAM, workflowId: WORKFLOW_ID, capsuleVersion: CAPSULE_VERSION, batchId });
  return `settle:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** The operation of the segment of one task, from the settle operation and the task. */
function segmentOperationOf(settleOperation: string, taskId: string): string {
  const key = `${settleOperation}${String.fromCharCode(0)}${taskId}`;
  return `settle-task:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
}

/** The stored claim of the settle operation of a batch, or undefined when the store holds none. */
function settleClaimOf(batchId: string): unknown {
  return store.getAppender().ensureSqliteBackendSync().lookupOperationClaim(settleOperationOf(batchId));
}

/** The settlement records of the stream, in commit order. */
async function settledRecords(): Promise<ExecutionSettled[]> {
  return (await store.query(STREAM, { type: 'execution.settled' })).map((row) => ExecutionSettledData.parse(row.data));
}

/** The task of each completion row of the stream, in commit order. */
async function completionRows(): Promise<unknown[]> {
  return (await store.query(STREAM, { type: 'task.completed' })).map((row) => (isRecord(row.data) ? row.data.taskId : undefined));
}

/** The outcome of each segment row of one operation, in commit order. */
async function segmentOutcomes(operationId: string): Promise<string[]> {
  return (await store.query(STREAM, { type: INTENT_EXECUTED_EVENT }))
    .map((row) => OrchestrateIntentExecutedData.parse(row.data))
    .filter((data) => data.operationId === operationId)
    .map((data) => data.outcome);
}

/** The bundle that a settlement record references, read back from custody. */
async function bundleOf(record: ExecutionSettled | undefined): Promise<SettlementBundleV1> {
  const ref = record?.bundleRefs[0];
  if (ref === undefined) throw new Error('the record references no bundle');
  return decodeSettlementBundle(await store.bundleStore.resolve(ref.digest));
}

beforeEach(async () => {
  stateDir = makeTempDir('settle-in-commit-');
  store = new EventStore(stateDir);
  await store.initialize();
  phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
  scope = await scopeOfCheckout(path.join(stateDir, 'checkout'));
  await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId: VERIFY, stateDir, phaseAttemptId, worktreePath: worktreeOf(VERIFY) });
  await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId: SECOND, stateDir, phaseAttemptId, worktreePath: worktreeOf(SECOND) });
  const capsule = withScope(twoTaskCapsule(), scope);
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
});

afterEach(async () => {
  vi.restoreAllMocks();
  store.close();
  await rmrfAsync(stateDir);
});

describe('settle — a completion row that commits before the settle commit', () => {
  /**
   * The batch claims `task-verify` only. The first attempt finds no completion of `task-second`, so it
   * is rejected for a missing claim. Another writer completes `task-second` before the commit. The commit
   * reads that row and rolls back. The redo runs the segment of `task-verify` and settles the batch.
   */
  it('Settle_ACompletionRowAppendedBeforeTheCommit_IsReadByTheCommit', async () => {
    const gate = gateLeaf();
    const bundles = new RacingBundleStore(() => completeTask(SECOND));

    const receipt = receiptOf(await settle('batch-completion-race', [completedClaim(VERIFY)], gate, bundles));

    expect(bundles.puts.map((put) => [put.outcome, put.findings.map((finding) => [finding.kind, finding.subject])])).toEqual([
      ['rejected', [['missing-claim', SECOND]]],
      ['settled', []],
    ]);
    expect(bundles.puts[0]?.verification).toEqual([]);
    expect(gate.runs).toEqual([VERIFY]);
    expect(receipt).toMatchObject({ outcome: 'settled', acceptedTasks: [VERIFY], findings: [] });
    expect(receipt.verification).toEqual([
      { taskId: SECOND, outcome: 'already-complete' },
      expect.objectContaining({
        taskId: VERIFY,
        outcome: 'verified',
        operationId: segmentOperationOf(receipt.operationId, VERIFY),
      }),
    ]);
    expect((await settledRecords()).map((record) => [record.batchId, record.outcome, record.acceptedTasks])).toEqual([
      ['batch-completion-race', 'settled', [VERIFY]],
    ]);
    expect(await completionRows()).toEqual([SECOND, VERIFY]);
  });

  /** The same race, through the spy on the commit. The record has no missing-claim finding, and it traces the task as complete. */
  it('Settle_ARequiredTaskCompletedBeforeTheCommit_NeedsNoClaim', async () => {
    const commits = raceSettleCommits(1, () => completeTask(SECOND));

    const receipt = receiptOf(await settle('batch-unclaimed-required', [completedClaim(VERIFY)], gateLeaf()));

    expect(commits.count()).toBe(2);
    expect(receipt).toMatchObject({ outcome: 'settled', acceptedTasks: [VERIFY], findings: [] });
    expect(traceOf(receipt, SECOND)).toEqual({ taskId: SECOND, outcome: 'already-complete' });
    const records = await settledRecords();
    expect(records.map((record) => [record.batchId, record.outcome, record.acceptedTasks, record.findingCounts])).toEqual([
      ['batch-unclaimed-required', 'settled', [VERIFY], []],
    ]);
  });

  /**
   * A claim reports `task-second` as blocked, so the first attempt leaves it unresolved. Another writer
   * completes the task before the commit. The record lists it as already complete, not as unresolved.
   */
  it('Settle_AStatusClaimWhoseTaskIsCompletedBeforeTheCommit_IsAlreadyComplete', async () => {
    const commits = raceSettleCommits(1, () => completeTask(SECOND));

    const receipt = receiptOf(
      await settle('batch-blocked-then-complete', [completedClaim(VERIFY), blockedClaim(SECOND)], gateLeaf()),
    );

    expect(commits.count()).toBe(2);
    expect(receipt).toMatchObject({ outcome: 'settled', acceptedTasks: [SECOND, VERIFY], findings: [] });
    expect(receipt).not.toHaveProperty('unresolved');
    expect(traceOf(receipt, SECOND)).toEqual({ taskId: SECOND, outcome: 'already-complete' });
    expect((await settledRecords()).map((record) => [record.outcome, record.unresolvedTasks])).toEqual([
      ['settled', undefined],
    ]);
  });
});

describe('settle — a cited record that commits before the settle commit', () => {
  /**
   * The claim of `task-verify` cites a gate record that the stream does not hold at the first read, so the first
   * attempt is rejected. The record lands before the commit. The judgement key does not change, because the record
   * has no blob check. The commit sees that it needs that check and rolls back. The redo checks the record, runs the
   * segments and settles the batch.
   */
  it('Settle_ACitedRecordThatAppearsBeforeTheCommit_RedoesAndSettles', async () => {
    const seed = { streamId: STREAM, requirementId: ladderRequirementId('test'), phaseAttemptId };
    const evidenceId = await seedGateEvidence({ append: () => Promise.resolve(undefined) }, seed);
    const commits = raceSettleCommits(1, async () => {
      expect(await seedGateEvidence(store, seed)).toBe(evidenceId);
    });
    const bundles = new RacingBundleStore(() => Promise.resolve());
    const gate = gateLeaf();
    const cited = { ...completedClaim(VERIFY), evidence: [{ kind: 'test', ref: evidenceId }] };

    const receipt = receiptOf(await settle('batch-cited-race', [cited, completedClaim(SECOND)], gate, bundles));

    expect(commits.count()).toBe(2);
    expect(bundles.puts.map((put) => [put.outcome, put.findings.map((finding) => [finding.kind, finding.subject])])).toEqual([
      ['rejected', [['inadmissible-evidence', evidenceId]]],
      ['settled', []],
    ]);
    expect(receipt).toMatchObject({ outcome: 'settled', acceptedTasks: [SECOND, VERIFY], findings: [] });
    expect(receipt.adjudicated.evidence).toBe(1);
    expect(gate.runs).toEqual([SECOND, VERIFY]);
    expect((await settledRecords()).map((record) => [record.batchId, record.outcome, record.findingCounts])).toEqual([
      ['batch-cited-race', 'settled', []],
    ]);
  });
});

describe('settle — a revision that commits before the settle commit', () => {
  /**
   * A claim reports `task-second` as blocked, and `task-verify` verifies. A revision that names
   * `task-second` commits before the commit, so the redo is stale. The verified task stays complete and listed.
   */
  it('Settle_ARevisionOfAStatusClaimTaskBeforeTheCommit_GivesRecompileRequired', async () => {
    const gate = gateLeaf();
    const commits = raceSettleCommits(1, () => reviseDesign([SECOND]));

    const receipt = receiptOf(
      await settle('batch-revised-status-claim', [completedClaim(VERIFY), blockedClaim(SECOND)], gate),
    );

    expect(commits.count()).toBe(2);
    expect(receipt.outcome).toBe('recompile-required');
    expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['claim-superseded-by-revision', SECOND],
    ]);
    expect(receipt.acceptedTasks).toEqual([VERIFY]);
    expect(receipt.verification).toEqual([
      expect.objectContaining({
        taskId: VERIFY,
        outcome: 'verified',
        operationId: segmentOperationOf(receipt.operationId, VERIFY),
      }),
    ]);
    expect(gate.runs).toEqual([VERIFY]);
    expect(await completionRows()).toEqual([VERIFY]);
  });

  /**
   * Tasks A and B are claimed. The gate refuses B, and A verifies. A revision that names B commits
   * before the commit. The stale record names B, and it lists A in `acceptedTasks` and in the trace.
   */
  it('Settle_ARevisionOfTheOtherTaskAfterASegment_KeepsTheVerifiedTask', async () => {
    const gate = gateLeaf({ refuse: SECOND });
    const commits = raceSettleCommits(1, () => reviseDesign([SECOND]));

    const receipt = receiptOf(
      await settle('batch-revised-other-task', [completedClaim(VERIFY), completedClaim(SECOND)], gate),
    );

    expect(commits.count()).toBe(2);
    expect(gate.runs).toEqual([SECOND, VERIFY]);
    expect(receipt.outcome).toBe('recompile-required');
    expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['claim-superseded-by-revision', SECOND],
    ]);
    expect(receipt.acceptedTasks).toEqual([VERIFY]);
    expect(traceOf(receipt, VERIFY)).toMatchObject({
      outcome: 'verified',
      operationId: segmentOperationOf(receipt.operationId, VERIFY),
    });
    const [record] = await settledRecords();
    expect([record?.outcome, record?.acceptedTasks]).toEqual(['recompile-required', [VERIFY]]);
    expect((await bundleOf(record)).verification).toContainEqual(
      expect.objectContaining({ taskId: VERIFY, outcome: 'verified' }),
    );
    expect(await completionRows()).toEqual([VERIFY]);
  });

  /**
   * A revision that names `task-verify` commits while its segment runs, so the completion leaf refuses
   * the task. The read after the segment is stale, and that judgement decides the record. The call does not fail.
   */
  it('Settle_ALeafRefusedUnderAStaleJudgement_DoesNotFailTheCall', async () => {
    const gate = gateLeaf({ before: (taskId) => (taskId === VERIFY ? reviseDesign([VERIFY]) : Promise.resolve()) });

    const receipt = receiptOf(
      await settle('batch-refused-leaf', [completedClaim(VERIFY), blockedClaim(SECOND)], gate),
    );

    expect(receipt.outcome).toBe('recompile-required');
    expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['claim-superseded-by-revision', VERIFY],
      ['task-blocked', SECOND],
    ]);
    expect(receipt.verification).toEqual([]);
    expect(await segmentOutcomes(segmentOperationOf(receipt.operationId, VERIFY))).toEqual(['failed']);
    const [halt] = (await store.query(STREAM, { type: INTENT_EXECUTED_EVENT })).map((row) =>
      OrchestrateIntentExecutedData.parse(row.data),
    );
    expect(halt?.failedLeaf).toBe('task_complete');
    expect(await completionRows()).toEqual([]);
    expect((await settledRecords()).map((record) => record.outcome)).toEqual(['recompile-required']);
  });

  /**
   * The gate refuses `task-second`. The completion leaf of `task-verify` appends its row but cannot write the
   * corrupt document, so the segment halts. A revision that names `task-second` commits while that segment runs.
   * The stale judgement settles `task-verify` as already complete, and the document cannot follow, so no verdict
   * is recorded. After the repair, the same batch records the stale verdict and the document shows the task complete.
   */
  it('Settle_ACompletionLeafThatCannotWriteTheDocumentUnderAStaleVerdict_RecordsNoVerdict', async () => {
    await initStateFile(stateDir, STREAM, 'feature', {
      tasks: [
        { id: VERIFY, title: 'verify', status: 'in_progress' },
        { id: SECOND, title: 'second', status: 'in_progress' },
      ],
    });
    const stateFile = path.join(stateDir, `${STREAM}.state.json`);
    const intact = await readFile(stateFile, 'utf-8');
    await writeFile(stateFile, '{ not a document', 'utf-8');
    const claims = [completedClaim(VERIFY), completedClaim(SECOND)];
    const gate = gateLeaf({
      refuse: SECOND,
      before: (taskId) => (taskId === VERIFY ? reviseDesign([SECOND]) : Promise.resolve()),
    });

    const halted = await settle('batch-stale-unwritable', claims, gate);

    expect(halted.success).toBe(false);
    expect(halted.error?.code).toBe('STATE_SYNC_FAILED');
    expect(halted.error?.message).toContain(`the stream records "${VERIFY}" complete`);
    expect(halted.error?.message).toContain('exarchos_workflow reconcile');
    expect(halted).not.toHaveProperty('data');
    expect(gate.runs).toEqual([SECOND, VERIFY]);
    const segment = segmentOperationOf(settleOperationOf('batch-stale-unwritable'), VERIFY);
    expect(await segmentOutcomes(segment)).toEqual(['failed']);
    expect(await completionRows()).toEqual([VERIFY]);
    expect(await settledRecords()).toEqual([]);
    expect(settleClaimOf('batch-stale-unwritable')).toBeUndefined();

    await writeFile(stateFile, intact, 'utf-8');
    const receipt = receiptOf(await settle('batch-stale-unwritable', claims, gateLeaf()));

    expect(receipt.outcome).toBe('recompile-required');
    expect(receipt.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['claim-superseded-by-revision', SECOND],
    ]);
    expect(receipt.acceptedTasks).toEqual([VERIFY]);
    expect(traceOf(receipt, VERIFY)).toEqual({ taskId: VERIFY, outcome: 'already-complete' });
    expect((await settledRecords()).map((record) => [record.batchId, record.outcome])).toEqual([
      ['batch-stale-unwritable', 'recompile-required'],
    ]);
    expect(await completionRows()).toEqual([VERIFY]);
    const state = await readStateFile(stateFile);
    expect(state.tasks.map((task) => [task.id, task.status])).toEqual([
      [VERIFY, 'complete'],
      [SECOND, 'in_progress'],
    ]);
  });
});

describe('settle — the attempts of one call', () => {
  /**
   * A row that no verdict reads lands before the commit, and the batch commits on its first attempt.
   * The second batch shows that the spy counts each settle commit: its race forces one redo.
   */
  it('Settle_UnchangedReads_CommitOnTheFirstAttempt', async () => {
    const quiet = raceSettleCommits(1, appendUnrelatedRow);
    const settled = receiptOf(await settle('batch-quiet', [completedClaim(VERIFY), completedClaim(SECOND)], gateLeaf()));
    quiet.restore();
    expect(quiet.count()).toBe(1);
    expect(settled).toMatchObject({ outcome: 'settled', acceptedTasks: [SECOND, VERIFY], findings: [] });

    const changed = raceSettleCommits(1, () => reviseDesign([VERIFY]));
    const stale = receiptOf(await settle('batch-changed', [completedClaim(VERIFY)], gateLeaf()));
    expect(changed.count()).toBe(2);
    expect(stale.outcome).toBe('recompile-required');
  });

  /**
   * The first attempt verifies `task-verify`, and a completion of `task-second` changes the read before
   * the commit. The redo keeps the run, so the gate runs once, and the trace keeps the segment operation.
   */
  it('Settle_ARedoRunsEachSegmentAtMostOnce', async () => {
    const gate = gateLeaf();
    const commits = raceSettleCommits(1, () => completeTask(SECOND));

    const receipt = receiptOf(await settle('batch-redo-once', [completedClaim(VERIFY), blockedClaim(SECOND)], gate));

    expect(commits.count()).toBe(2);
    expect(gate.runs).toEqual([VERIFY]);
    const segment = segmentOperationOf(receipt.operationId, VERIFY);
    expect(traceOf(receipt, VERIFY)).toMatchObject({ outcome: 'verified', operationId: segment });
    expect(await segmentOutcomes(segment)).toEqual(['committed']);
    expect(receipt.outcome).toBe('settled');
  });

  /**
   * Before each commit, a new revision names the blocked task, so each attempt reads another verdict.
   * After three attempts the call refuses. It records no verdict and no claim, and the verified segment stays.
   */
  it('Settle_ReadsThatChangeBeforeThreeCommits_GiveConcurrencyConflictAndRecordNothing', async () => {
    const gate = gateLeaf();
    const commits = raceSettleCommits(Number.POSITIVE_INFINITY, () => reviseDesign([SECOND]));

    const result = await settle('batch-three-changes', [completedClaim(VERIFY), blockedClaim(SECOND)], gate);
    commits.restore();

    expect(commits.count()).toBe(3);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CONCURRENCY_CONFLICT');
    expect(result.error?.message).toContain('changed before each of its 3 commits, so nothing was recorded');
    expect(await settledRecords()).toEqual([]);
    expect(settleClaimOf('batch-three-changes')).toBeUndefined();
    expect(await completionRows()).toEqual([VERIFY]);
    expect(gate.runs).toEqual([VERIFY]);

    const retried = receiptOf(await settle('batch-three-changes', [completedClaim(VERIFY), blockedClaim(SECOND)], gate));
    expect(retried.operationId).toBe(settleOperationOf('batch-three-changes'));
    expect(settleClaimOf('batch-three-changes')).toBeDefined();
  });
});

describe('settle — a retry of the same batch', () => {
  /** The first call settles after a redo. The retry returns the same verdict, puts no bundle and appends no row. */
  it('Settle_ARetryAfterARedoneCommit_ReturnsTheVerdictAndAppendsNothing', async () => {
    const gate = gateLeaf();
    const racing = new RacingBundleStore(() => completeTask(SECOND));
    const first = receiptOf(await settle('batch-redone-then-retried', [completedClaim(VERIFY)], gate, racing));
    expect(racing.puts.map((put) => put.outcome)).toEqual(['rejected', 'settled']);
    expect(first.outcome).toBe('settled');
    const tail = (await store.query(STREAM)).length;

    const quiet = new RacingBundleStore(() => Promise.resolve());
    const replayed = receiptOf(await settle('batch-redone-then-retried', [completedClaim(VERIFY)], gate, quiet));

    expect(replayed).toEqual(first);
    expect(quiet.puts).toEqual([]);
    expect(await store.query(STREAM)).toHaveLength(tail);
    expect(gate.runs).toEqual([VERIFY]);
  });

  /**
   * The first call ends with `CONCURRENCY_CONFLICT` after its segment verified `task-verify`. The retry
   * replays that segment, so no gate runs again, and the trace carries the segment operation.
   */
  it('Settle_ARetryAfterAConcurrencyConflict_ReplaysItsSegmentsWithTheirOperations', async () => {
    const gate = gateLeaf();
    const claims = [completedClaim(VERIFY), blockedClaim(SECOND)];
    const commits = raceSettleCommits(Number.POSITIVE_INFINITY, () => reviseDesign([SECOND]));
    const conflict = await settle('batch-conflict-then-retried', claims, gate);
    commits.restore();
    expect(conflict.error?.code).toBe('CONCURRENCY_CONFLICT');
    expect(gate.runs).toEqual([VERIFY]);

    const receipt = receiptOf(await settle('batch-conflict-then-retried', claims, gate));

    expect(gate.runs).toEqual([VERIFY]);
    const segment = segmentOperationOf(receipt.operationId, VERIFY);
    expect(receipt.verification).toEqual([expect.objectContaining({ taskId: VERIFY, outcome: 'verified', operationId: segment })]);
    expect(receipt.acceptedTasks).toEqual([VERIFY]);
    expect(await segmentOutcomes(segment)).toEqual(['committed']);
  });

  /**
   * While the segment of `task-verify` runs, another writer completes the task, and its row is the stored
   * completion. The put of the bundle then fails, so no verdict is recorded. The retry still replays the
   * segment of this batch, so the trace is `verified` with the segment operation, not `already-complete`.
   */
  it('Settle_ARetryAfterAForeignCompletion_StillReplaysItsOwnSegment', async () => {
    const claims = [completedClaim(VERIFY), completedClaim(SECOND)];
    const foreign = gateLeaf({ before: (taskId) => (taskId === VERIFY ? completeTask(VERIFY) : Promise.resolve()) });
    await expect(settle('batch-foreign-completion', claims, foreign, new FailingBundleStore())).rejects.toThrow(
      'the bundle store refused the put',
    );
    expect(await settledRecords()).toEqual([]);
    expect(await completionRows()).toEqual([SECOND, VERIFY]);
    const storedBy = new Map(
      (await store.query(STREAM, { type: 'task.completed' })).map((row) => [
        isRecord(row.data) ? row.data.taskId : undefined,
        row.operationId ?? '',
      ]),
    );
    const segmentOf = (taskId: string): string => segmentOperationOf(settleOperationOf('batch-foreign-completion'), taskId);
    expect(storedBy.get(SECOND)?.startsWith(segmentOf(SECOND))).toBe(true);
    expect(storedBy.get(VERIFY)?.startsWith(segmentOf(VERIFY))).toBe(false);
    expect(await segmentOutcomes(segmentOf(VERIFY))).toEqual(['committed']);

    const gate = gateLeaf();
    const receipt = receiptOf(await settle('batch-foreign-completion', claims, gate));

    expect(gate.runs).toEqual([]);
    expect(receipt.outcome).toBe('settled');
    expect(traceOf(receipt, VERIFY)).toMatchObject({
      outcome: 'verified',
      operationId: segmentOperationOf(receipt.operationId, VERIFY),
    });
    expect(traceOf(receipt, SECOND)).toMatchObject({
      outcome: 'verified',
      operationId: segmentOperationOf(receipt.operationId, SECOND),
    });
    expect(receipt.verification?.map((trace) => trace.outcome)).not.toContain('already-complete');
    expect(await completionRows()).toEqual([SECOND, VERIFY]);
  });
});

describe('settle — the custody of a discarded attempt', () => {
  /**
   * The first attempt put its bundle, and its commit rolled back. That blob stays, and no row references it.
   * The bundle integrity check reads only referenced blobs, so it reports no violation.
   */
  it('Settle_ARedoneAttempt_LeavesOnlyAnUnreferencedBlob', async () => {
    const racing = new RacingBundleStore(() => completeTask(SECOND));

    const receipt = receiptOf(await settle('batch-orphan-blob', [completedClaim(VERIFY)], gateLeaf(), racing));

    expect(receipt.outcome).toBe('settled');
    const [discarded, kept] = racing.refs;
    expect(racing.refs).toHaveLength(2);
    if (discarded === undefined || kept === undefined) throw new Error('the call put fewer than two bundles');
    expect(await store.bundleStore.has(discarded.digest)).toBe('ok');
    const referenced = (await store.query(STREAM)).flatMap((row) =>
      isRecord(row.data) && Array.isArray(row.data.bundleRefs) ? row.data.bundleRefs : [],
    );
    expect(referenced).not.toContainEqual(expect.objectContaining({ digest: discarded.digest }));
    expect(receipt.bundleRefs).toEqual([kept]);
    const integrity = await store.runBundleIntegrityCheck();
    expect(integrity.ok, JSON.stringify(integrity)).toBe(true);
  });
});
