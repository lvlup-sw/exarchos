/**
 * Tests for the reads that decide a settlement verdict. The pure cases build the rows, the capsule,
 * the claims and the runs by hand. Each case compares its result with a value worked out by hand.
 *
 * One case runs `handleSettle` end to end on a real store. Another call completes a task while the
 * segment of the other task runs, and the read after the segments finds that completion.
 *
 * @oracle-sources: ../../../../src/verbs/settle/settlement-reads.ts, the facts, outcomes and traces worked out by hand in each case
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowDefinitionV1Schema } from '@lvlup-sw/strategos-contracts';

import type { ExarchosCapsuleV1 } from '../../../../src/contract/capsule/exarchos-capsule.js';
import { baseValidCapsule, baseValidDefinition } from '../../../../src/contract/capsule/exarchos-capsule-fixtures.js';
import { deriveMcpCallerIdentity, snapshotCallerAuthorization } from '../../../../src/dispatch/caller-identity.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { mintDispatchContext, runWithDispatchContext } from '../../../../src/dispatch/dispatch-context.js';
import { EventStore } from '../../../../src/events/store.js';
import { ExecutionSettledData } from '../../../../src/events/schemas.js';
import type { ToolResult } from '../../../../src/format.js';
import { findActionInRegistry } from '../../../../src/registry.js';
import { ALL_RUNBOOKS } from '../../../../src/runbooks/definitions.js';
import type { RunbookDefinition, RunbookStep } from '../../../../src/runbooks/types.js';
import { ACTION_HANDLERS } from '../../../../src/verbs/composite.js';
import { INTENT_ARG_SCHEMAS } from '../../../../src/verbs/execute/arg-schemas.js';
import type { ExecuteIntentDeps, LeafHandler } from '../../../../src/verbs/execute/executor.js';
import { commitPreparedCapsule } from '../../../../src/verbs/prepare/prepared-record.js';
import type { SettlementClaim, TaskStanding } from '../../../../src/verbs/settle/adjudicate.js';
import { handleSettle } from '../../../../src/verbs/settle/handler.js';
import {
  judgeSettlement,
  settlementFactsOf,
  type EvidenceCheck,
  type SettlementInputs,
  type VerificationRun,
} from '../../../../src/verbs/settle/settlement-reads.js';
import { createInMemoryResolver } from '../../../../src/workflow/capabilities/resolver.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedActivePhaseAttempt } from '../../../../tools/test-helpers/trusted-context.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

const VERIFY = 'task-verify';
const SECOND = 'task-second';
const DIGEST = { algorithm: 'sha256', value: 'a'.repeat(64) };

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

/** A completed claim of one task, with no evidence. */
function passing(taskId: string): SettlementClaim {
  return { taskId, fields: { passed: true }, evidence: [] };
}

/** The inputs of one attempt with no deviation, no decision and no blob check. */
function inputsOf(capsule: ExarchosCapsuleV1, claims: readonly SettlementClaim[]): SettlementInputs {
  return { capsule, claims, deviations: [], decided: () => undefined, round: 0, evidenceChecks: new Map() };
}

/** The completion row of one task, as another writer or a segment appends it. */
function completion(taskId: string, sequence: number): { type: string; sequence: number; data: unknown } {
  return { type: 'task.completed', sequence, data: { taskId, verified: true } };
}

/** The facts of rows with no revision and no citation. */
function factsOf(rows: readonly { type: string; sequence: number; data: unknown }[]): ReturnType<typeof settlementFactsOf> {
  return settlementFactsOf(rows, { pinnedSequence: 1, cited: [] });
}

/** A run that verified its task, with the trace that the executor receipt gives. */
function verifiedRun(taskId: string): VerificationRun {
  return {
    kind: 'ran',
    outcome: { kind: 'verified' },
    trace: { taskId, outcome: 'verified', operationId: `settle-task:run-of-${taskId}` },
  };
}

describe('judgeSettlement — the outcome of each task from the facts and the runs', () => {
  /**
   * Both tasks are accepted. The stream shows `task-second` complete, so it needs no segment.
   * `task-verify` has no run and no completion row, so it needs a segment. After its run, nothing is needed.
   */
  it('JudgeSettlement_AnAcceptedTaskWithNoRunOrCompletion_NeedsASegment', () => {
    const inputs = inputsOf(twoTaskCapsule(), [passing(VERIFY), passing(SECOND)]);
    const facts = factsOf([completion(SECOND, 4)]);

    const before = judgeSettlement(inputs, facts, new Map());
    expect(before.verifies).toBe(true);
    expect(before.needsSegment).toEqual([VERIFY]);
    expect(before.alreadyComplete).toEqual([SECOND]);
    expect(before.traces).toEqual([{ taskId: SECOND, outcome: 'already-complete' }]);

    const after = judgeSettlement(inputs, facts, new Map([[VERIFY, verifiedRun(VERIFY)]]));
    expect(after.needsSegment).toEqual([]);
    expect(after.verdict.outcome).toBe('settled');
    expect(after.verdict.acceptedTasks).toEqual([SECOND, VERIFY]);
    expect(after.traces).toEqual([
      { taskId: SECOND, outcome: 'already-complete' },
      { taskId: VERIFY, outcome: 'verified', operationId: 'settle-task:run-of-task-verify' },
    ]);
  });

  /**
   * One segment halted at a leaf that is not a gate, and the other failed at a gate. With no completion row,
   * the halt is the refusal of the call. When the facts show both tasks complete, completion wins.
   */
  it('JudgeSettlement_AHaltedOrFailedRunWhoseTaskIsNowComplete_IsAlreadyComplete', () => {
    const inputs = inputsOf(twoTaskCapsule(), [passing(VERIFY), passing(SECOND)]);
    const runs = new Map<string, VerificationRun>([
      [
        VERIFY,
        {
          kind: 'refused',
          halted: true,
          result: { success: false, error: { code: 'INTENT_SEGMENT_FAILED', message: 'the segment halted' } },
        },
      ],
      [
        SECOND,
        {
          kind: 'ran',
          outcome: { kind: 'failed', failedLeaf: 'check_mock_boundary', message: 'the gate refused' },
          trace: {
            taskId: SECOND,
            outcome: 'failed',
            operationId: 'settle-task:run-of-task-second',
            failedLeaf: 'check_mock_boundary',
            message: 'the gate refused',
          },
        },
      ],
    ]);

    const open = judgeSettlement(inputs, factsOf([]), runs);
    expect(open.refusal).toEqual({
      success: false,
      error: { code: 'INTENT_SEGMENT_FAILED', message: 'the segment halted' },
    });
    expect(open.alreadyComplete).toEqual([]);

    const complete = judgeSettlement(inputs, factsOf([completion(VERIFY, 5), completion(SECOND, 6)]), runs);
    expect(complete).not.toHaveProperty('refusal');
    expect(complete.alreadyComplete).toEqual([SECOND, VERIFY]);
    expect(complete.traces).toEqual([
      { taskId: VERIFY, outcome: 'already-complete' },
      { taskId: SECOND, outcome: 'already-complete' },
    ]);
    expect([...complete.outcomes]).toEqual([
      [VERIFY, { kind: 'already-complete' }],
      [SECOND, { kind: 'already-complete' }],
    ]);
    expect(complete.verdict.outcome).toBe('settled');
    expect(complete.verdict.findings).toEqual([]);
    expect(complete.verdict.acceptedTasks).toEqual([SECOND, VERIFY]);
  });

  /** A refused run that did not halt is not an answer about its task, so a completion row does not change it. */
  it('JudgeSettlement_ARefusedRunThatDidNotHalt_IsTheRefusalAlsoWhenItsTaskIsComplete', () => {
    const inputs = inputsOf(baseValidCapsule(), [passing(VERIFY)]);
    const runs = new Map<string, VerificationRun>([
      [
        VERIFY,
        {
          kind: 'refused',
          halted: false,
          result: { success: false, error: { code: 'OPERATION_DIGEST_MISMATCH', message: 'a different claim' } },
        },
      ],
    ]);

    const judgement = judgeSettlement(inputs, factsOf([completion(VERIFY, 3)]), runs);

    expect(judgement.refusal).toEqual({
      success: false,
      error: { code: 'OPERATION_DIGEST_MISMATCH', message: 'a different claim' },
    });
    expect(judgement.alreadyComplete).toEqual([]);
  });

  /** Another writer stored the completion of the task while its segment verified it. The trace stays the trace of the run. */
  it('JudgeSettlement_AVerifiedRunWhoseTaskIsNowComplete_StaysVerified', () => {
    const inputs = inputsOf(baseValidCapsule(), [passing(VERIFY)]);

    const judgement = judgeSettlement(inputs, factsOf([completion(VERIFY, 3)]), new Map([[VERIFY, verifiedRun(VERIFY)]]));

    expect(judgement.alreadyComplete).toEqual([]);
    expect(judgement.traces).toEqual([
      { taskId: VERIFY, outcome: 'verified', operationId: 'settle-task:run-of-task-verify' },
    ]);
    expect([...judgement.outcomes]).toEqual([[VERIFY, { kind: 'verified' }]]);
    expect(judgement.verdict.outcome).toBe('settled');
    expect(judgement.verdict.acceptedTasks).toEqual([VERIFY]);
  });

  /**
   * A claim reports `task-second` as blocked. With no completion row, the task is unresolved. When the
   * facts show it complete, adjudication accepts the claim and the task is already complete.
   */
  it('JudgeSettlement_AStatusClaimWhoseTaskIsNowComplete_IsAlreadyComplete', () => {
    const blocked: SettlementClaim = { taskId: SECOND, status: 'blocked', reason: 'waits on a review', fields: {}, evidence: [] };
    const inputs = inputsOf(twoTaskCapsule(), [passing(VERIFY), blocked]);
    const runs = new Map([[VERIFY, verifiedRun(VERIFY)]]);

    const open = judgeSettlement(inputs, factsOf([completion(VERIFY, 4)]), runs);
    expect(open.verdict.outcome).toBe('corrective-capsule');
    expect(open.verdict.unresolved).toEqual([{ taskId: SECOND, cause: 'task-blocked' }]);

    const complete = judgeSettlement(inputs, factsOf([completion(VERIFY, 4), completion(SECOND, 5)]), runs);
    expect(complete.verdict.outcome).toBe('settled');
    expect(complete.verdict.findings).toEqual([]);
    expect(complete.verdict.acceptedTasks).toEqual([SECOND, VERIFY]);
    expect(complete.alreadyComplete).toEqual([SECOND]);
    expect(complete.traces).toEqual([
      { taskId: SECOND, outcome: 'already-complete' },
      { taskId: VERIFY, outcome: 'verified', operationId: 'settle-task:run-of-task-verify' },
    ]);
  });

  /**
   * A deviation names `task-second`, and the plan says that the task is pending. When the facts show the
   * task complete, it is finished. The decision round reads the decision first. No decision answers the
   * deviation, so it waits for approval, and its task gets no check.
   */
  it('JudgeSettlement_ATaskThatTheFactsShowComplete_StandsFinishedWhateverThePlanSays', () => {
    const deviation = { deviationKind: 'invalidated-assumption', statement: 'the store was not SQLite', affectedTasks: [SECOND] };
    const pending = (): TaskStanding => ({ kind: 'pending' });
    const inputs: SettlementInputs = { ...inputsOf(twoTaskCapsule(), [passing(VERIFY)]), deviations: [deviation], planStanding: pending };
    const facts = factsOf([completion(SECOND, 4)]);

    const submitted = judgeSettlement(inputs, facts, new Map());
    expect(submitted.verdict.outcome).toBe('rejected');
    expect(submitted.verdict.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['deviation-names-finished-task', SECOND],
    ]);

    const deciding = judgeSettlement({ ...inputs, round: 1 }, facts, new Map());
    expect(deciding.verdict.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['deviation-awaiting-approval', 'invalidated-assumption'],
    ]);
  });

  /**
   * A revision after the prepared record names a claimed task. A revision at the sequence of the record
   * does not count. The batch is stale and needs no segment.
   */
  it('SettlementFactsOf_ARevisionAfterThePin_MakesTheBatchStale', () => {
    const revision = (sequence: number, nextDesignVersion: number, affectedTasks: readonly string[]): { type: string; sequence: number; data: unknown } => ({
      type: 'design.revised',
      sequence,
      data: {
        operationId: `settle:revision-${sequence}`,
        workflowId: 'wf-capsule-corpus',
        capsuleVersion: 7,
        batchId: `batch-revision-${sequence}`,
        priorDesignVersion: nextDesignVersion - 1,
        nextDesignVersion,
        deviationIds: [`deviation-${sequence}`],
        affectedTasks: [...affectedTasks],
        bundleRefs: [{ artifactId: 'run-bundle:settlement:wf-capsule-corpus:1', digest: DIGEST }],
      },
    });
    const rows = [revision(2, 2, [SECOND]), completion(SECOND, 3), revision(4, 3, [VERIFY])];

    const facts = settlementFactsOf(rows, { pinnedSequence: 2, cited: [] });
    expect([...facts.revisions]).toEqual([[VERIFY, 3]]);
    expect([...facts.completed]).toEqual([SECOND]);

    const judgement = judgeSettlement(inputsOf(twoTaskCapsule(), [passing(VERIFY)]), facts, new Map());
    expect(judgement.verifies).toBe(false);
    expect(judgement.verdict.outcome).toBe('recompile-required');
    expect(judgement.needsSegment).toEqual([]);
    expect(judgement.traces).toEqual([]);
  });
});

/** The fields that each evidence record of these cases shares. */
const EVIDENCE_BASE = {
  contractVersion: '1.0',
  phaseAttemptId: 'phase-attempt-001',
  subject: { kind: 'task', taskId: VERIFY, digest: DIGEST },
  producer: {
    producerId: 'producer.gate-runner',
    providerRef: 'provider.test-adequacy',
    providerVersion: '1.0.0',
    invocationId: 'invocation-001',
  },
  policyId: 'policy-001',
  policyDigest: DIGEST,
  contentDigest: DIGEST,
  kind: 'gate',
  verdict: 'pass',
};

/** The record that the claim cites, as a gate row of the `test` kind holds it. */
const CITED_RECORD = {
  eventVersion: '1.0',
  evidence: {
    ...EVIDENCE_BASE,
    evidenceId: 'evidence-cited',
    requirementId: 'verification-ladder:test',
    createdAt: '2026-10-22T10:00:00.000Z',
  },
};

/** A later record of the same evidence id. Its blob check is not the check of the earlier record. */
const CHANGED_RECORD = {
  eventVersion: '1.0',
  evidence: { ...CITED_RECORD.evidence, createdAt: '2026-10-22T11:00:00.000Z' },
};

/** A gate row that no claim cites, as a segment appends one for its own gate. */
const UNCITED_RECORD = {
  eventVersion: '1.0',
  evidence: {
    ...EVIDENCE_BASE,
    evidenceId: 'evidence-of-the-segment',
    requirementId: 'verification-ladder:static-analysis',
    createdAt: '2026-10-22T10:30:00.000Z',
  },
};

describe('judgeSettlement — the cited evidence', () => {
  const CITED = { kind: 'test', ref: 'evidence-cited' };
  const KEY = 'test\u0000evidence-cited';
  const claim: SettlementClaim = { taskId: VERIFY, fields: { passed: true }, evidence: [CITED] };
  const intact: EvidenceCheck = { record: CITED_RECORD, intact: true };

  /**
   * The segment of the task appends a gate row that no claim cites. The facts hold only the cited record,
   * and the check that the call made before the segment still covers it.
   */
  it('JudgeSettlement_AnUncitedEvidenceRow_ChangesNoFact', () => {
    const rows = [
      { type: 'admission.evidence-recorded', sequence: 2, data: CITED_RECORD },
      completion(VERIFY, 4),
      { type: 'admission.evidence-recorded', sequence: 5, data: UNCITED_RECORD },
    ];

    const facts = settlementFactsOf(rows, { pinnedSequence: 1, cited: [CITED] });
    expect([...facts.cited.keys()]).toEqual([KEY]);
    expect(facts.cited.get(KEY)).toEqual({ key: KEY, record: CITED_RECORD });

    const inputs: SettlementInputs = { ...inputsOf(baseValidCapsule(), [claim]), evidenceChecks: new Map([[KEY, intact]]) };
    const judgement = judgeSettlement(inputs, facts, new Map([[VERIFY, verifiedRun(VERIFY)]]));
    expect(judgement.needsEvidenceCheck).toEqual([]);
    expect(judgement.verdict.outcome).toBe('settled');
    expect(judgement.verdict.findings).toEqual([]);
  });

  /**
   * A later row replaces the cited record, so the check of the earlier record does not cover it. The
   * judgement names the record for a new check, and until then the evidence does not resolve.
   */
  it('JudgeSettlement_ACitedRecordThatChangedAfterItsCheck_NeedsANewCheck', () => {
    const rows = [
      { type: 'admission.evidence-recorded', sequence: 2, data: CITED_RECORD },
      { type: 'admission.evidence-recorded', sequence: 5, data: CHANGED_RECORD },
    ];
    const inputs: SettlementInputs = { ...inputsOf(baseValidCapsule(), [claim]), evidenceChecks: new Map([[KEY, intact]]) };

    const judgement = judgeSettlement(inputs, settlementFactsOf(rows, { pinnedSequence: 1, cited: [CITED] }), new Map());

    expect(judgement.needsEvidenceCheck).toEqual([{ key: KEY, record: CHANGED_RECORD }]);
    expect(judgement.verifies).toBe(false);
    expect(judgement.verdict.findings.map((finding) => [finding.kind, finding.subject])).toEqual([
      ['inadmissible-evidence', 'evidence-cited'],
    ]);
  });
});

const STREAM = 'feat-settlement-reads';
/** Where the claims say the work is. Bare, so the one gate that runs passes advisory. */
const WORKTREE = '/nonexistent-settlement-reads-worktree';
/** The capabilities that the composed leaves declare. The gate runner also needs a trusted caller. */
const CAPABILITIES = ['fs:read', 'fs:write', 'shell:exec', 'mcp:exarchos', 'admission:issue-gate-evidence'];
/** The shipped runbook, cut to the leaves that decide without leaving the process. */
const NO_SHELL_LEAVES = ['check_mock_boundary', 'task_complete'];

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

/** A caller with the capabilities of the composed leaves. */
function correlation(): ReturnType<typeof mintDispatchContext> {
  const identity = deriveMcpCallerIdentity({ sessionId: 'settlement-reads-fixture' });
  return mintDispatchContext(undefined, snapshotCallerAuthorization(identity, createInMemoryResolver(CAPABILITIES)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `handleSettle` on a real store, with the shipped leaves of the task-completion runbook cut to the
 * two that run in the process. The capsule requires two tasks, and each has a seeded gate.
 */
describe('settle — the read after the segments', () => {
  let stateDir: string;
  let store: EventStore;
  const wiring = (): DispatchContext => ({ stateDir, eventStore: store, enableTelemetry: false });

  beforeEach(async () => {
    stateDir = makeTempDir('settlement-reads-');
    store = new EventStore(stateDir);
    await store.initialize();
    const phaseAttemptId = await seedActivePhaseAttempt(store, STREAM);
    await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId: VERIFY, stateDir, phaseAttemptId });
    await seedStaticAnalysisVerdict(store, { streamId: STREAM, taskId: SECOND, stateDir, phaseAttemptId });
    const capsule = twoTaskCapsule();
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
    store.close();
    await rmrfAsync(stateDir);
  });

  /**
   * A batch claims `task-verify` as completed and `task-second` as blocked. While the segment of
   * `task-verify` runs, another call completes `task-second`. The read after the segments finds that
   * completion, so the batch settles, and the receipt lists `task-second` as already complete.
   */
  it('Settle_AStatusClaimWhoseTaskAnotherCallCompletesWhileASegmentRuns_SettlesItAlreadyComplete', async () => {
    const completesTheSecondTask: LeafHandler = async (leafArgs, leafStateDir, leafCtx) => {
      const completed = await liveHandler('task_complete')({ taskId: SECOND, featureId: STREAM }, leafStateDir, leafCtx);
      expect(completed.success).toBe(true);
      return liveHandler('check_mock_boundary')(leafArgs, leafStateDir, leafCtx);
    };
    const schema = INTENT_ARG_SCHEMAS['task-completion'];
    if (schema === undefined) throw new Error('no argument schema for task-completion');
    const execute: ExecuteIntentDeps = {
      runbookTable: [noShellTaskCompletion()],
      findAction: findActionInRegistry,
      argSchemas: { 'task-completion': schema },
      handlers: { ...ACTION_HANDLERS, check_mock_boundary: completesTheSecondTask },
      handlerTool: 'exarchos_orchestrate',
    };

    const result: ToolResult = await runWithDispatchContext(correlation(), () =>
      handleSettle(
        {
          featureId: STREAM,
          capsuleVersion: 7,
          batchId: 'batch-status-claim',
          claims: [
            { taskId: VERIFY, fields: { passed: true, worktreePath: WORKTREE }, evidence: [] },
            { taskId: SECOND, status: 'blocked', reason: 'waits on a review' },
          ],
        },
        stateDir,
        wiring(),
        { execute },
      ),
    );

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.data).toMatchObject({ outcome: 'settled', acceptedTasks: [SECOND, VERIFY], findings: [] });
    expect(result.data).not.toHaveProperty('unresolved');
    expect(result.data).toHaveProperty('verification', [
      { taskId: SECOND, outcome: 'already-complete' },
      expect.objectContaining({ taskId: VERIFY, outcome: 'verified' }),
    ]);
    const records = (await store.query(STREAM, { type: 'execution.settled' })).map((row) => ExecutionSettledData.parse(row.data));
    expect(records.map((record) => [record.outcome, record.acceptedTasks, record.unresolvedTasks])).toEqual([
      ['settled', [SECOND, VERIFY], undefined],
    ]);
    const completions = (await store.query(STREAM, { type: 'task.completed' })).map((row) =>
      isRecord(row.data) ? row.data.taskId : undefined,
    );
    expect(completions).toEqual([SECOND, VERIFY]);
  });
});
