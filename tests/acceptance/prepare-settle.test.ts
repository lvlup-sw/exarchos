// The normal path of the semantic plane through the real dispatcher: one `prepare`, one `settle`,
// and nothing between them.
//
// Every call goes through `dispatch` with a real caller identity and capability resolver. Thus
// admission, the economy cap and the reserved-type guard apply as they do for an agent.
//
// `settle` accepts the capsule from `prepare` by version, and answers a retry of the same batch
// from the claim. It refuses an edited capsule, and only `prepare` can write the prepared record.
// A settled batch runs the production static-analysis gate on a real project and persists the
// verdict. Its tasks are then complete on the stream, in the projection and on the state
// document, so the guards admit the next transition. When the lint of the project fails, the same
// call rejects the batch and names the halt.
//
// The tasks are low-risk and off the boundary, so the ladder runs static analysis only. Policy
// skips the kill probe and the contract-drift gate, and no test needs a git repository.
//
// @oracle-sources: ../../src/verbs/prepare/handler.ts, the settlement record and bundle blobs counted out of the real event store and content-addressed store after each dispatched call

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../src/events/store.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../src/verbs/prepare/economy.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { initStateFile } from '../../src/workflow/state-store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

const STREAM = 'feat-prepare-settle-acceptance';

/** Real npm scripts — the cheapest processes that exit 0 and 1. */
const OK = 'node -e ""';
const FAIL = 'node -e "process.exit(1)"';

let stateDir: string;
let eventStore: EventStore;
/** A real on-disk Node project the production static-analysis gate passes. */
let greenWorktree: string;
const scratchDirs: string[] = [];

/** A real on-disk Node project the production static-analysis gate can run. */
async function makeNodeFixture(scripts: Record<string, string>): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'prepare-settle-worktree-')));
  scratchDirs.push(dir);
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'prepare-settle-fixture', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  return dir;
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'prepare-settle-acceptance-'));
  eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  greenWorktree = await makeNodeFixture({ lint: OK, typecheck: OK, 'quality-check': OK });
});

afterEach(async () => {
  eventStore.close();
  await rmrfAsync(stateDir);
  for (const dir of scratchDirs.splice(0)) await rmrfAsync(dir);
});

function callerContext() {
  return {
    stateDir,
    eventStore,
    enableTelemetry: false,
    callerIdentity: deriveMcpCallerIdentity({ sessionId: 'prepare-settle-acceptance' }),
    capabilityResolver: createInMemoryResolver(['fs:read', 'fs:write', 'mcp:exarchos', 'shell:exec']),
  };
}

async function call(tool: string, args: Record<string, unknown>): Promise<{
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}> {
  return (await dispatch(tool, args, callerContext())) as {
    success: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
  };
}

/** Stamped by the planner: low risk, off the boundary, so static analysis is the whole ladder. */
const STAMP = { riskTier: 'low', boundaryTouching: false } as const;
const TASKS = [
  { id: 'task-a', title: 'first', status: 'pending', blockedBy: [], ...STAMP },
  { id: 'task-b', title: 'second', status: 'pending', blockedBy: [], ...STAMP },
  { id: 'task-c', title: 'third', status: 'pending', blockedBy: [], ...STAMP },
];

/**
 * Seeds a feature workflow in `delegate` with three ready tasks and their integration branch.
 * The events that the projection folds and the document that the transition guards read hold the
 * same facts.
 */
async function seedDelegatingFeature(): Promise<void> {
  await initStateFile(stateDir, STREAM, 'feature', {
    phase: 'delegate',
    tasks: TASKS.map(({ id, title, status }) => ({ id, title, status })),
  });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': 'feature/prepare-settle', tasks: TASKS } },
  });
}

/** Every task claims the same worktree: where the work is, and what it touched. */
function completedClaims(worktreePath: string = greenWorktree): Record<string, unknown>[] {
  return ['task-a', 'task-b', 'task-c'].map((taskId) => ({
    taskId,
    fields: { worktreePath, files: [`src/${taskId}.ts`] },
    evidence: [],
  }));
}

async function rowsOf(type: string): Promise<unknown[]> {
  return (await eventStore.query(STREAM)).filter((event) => event.type === type);
}

async function blobCount(): Promise<number> {
  let count = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      if ((await stat(full)).isDirectory()) await walk(full);
      else count += 1;
    }
  };
  await walk(eventStore.bundleStore.root);
  return count;
}

interface PreparedReceipt {
  readonly capsuleVersion: number;
  readonly capsuleDigest: string;
  readonly capsule: Record<string, unknown> & {
    readonly graph: { readonly tasks: readonly { readonly taskId: string }[] };
    readonly contracts: Record<string, unknown>;
  };
}

describe('prepare then settle, through the dispatcher', () => {
  /**
   * `prepare` announces its tasks with `task.assigned`, and no earlier call does. The capsule
   * arrives whole, not capped, because the harness runs the batch from it. The test measures the
   * capsule against its declared budget. `settle` runs the verification: one segment record for
   * each task, and the verdict of the production gate with each.
   */
  it('PrepareSettle_TheNormalPath_IsTwoCallsAndOneDecision', async () => {
    await seedDelegatingFeature();

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const receipt = prepared.data as PreparedReceipt;
    expect(receipt.capsuleVersion).toBe(1);
    expect(receipt.capsule.graph.tasks.map((t) => t.taskId)).toEqual(['task-a', 'task-b', 'task-c']);
    expect((await rowsOf('task.assigned')).map((e) => (e as { data: { taskId: string } }).data.taskId)).toEqual([
      'task-a',
      'task-b',
      'task-c',
    ]);
    const estimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(prepared.data), 'utf8') / 4);
    expect(estimatedTokens).toBeLessThan(PREPARE_ECONOMY_BUDGET_TOKENS);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: receipt.capsuleVersion,
      batchId: 'batch-1',
      claims: completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect((settled.data as { outcome: string }).outcome).toBe('settled');
    expect(await rowsOf('workflow.prepared')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);
    const gates = (await rowsOf('gate.executed')) as { data: { gateName: string; passed: boolean } }[];
    expect(gates.filter((g) => g.data.gateName === 'static-analysis' && g.data.passed)).toHaveLength(3);
  });

  /** The retry also verifies nothing a second time. */
  it('PrepareSettle_ARetriedBatch_IsAnsweredFromTheClaim', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const args = { action: 'settle', featureId: STREAM, capsuleVersion, batchId: 'batch-1', claims: completedClaims() };

    const first = await call('exarchos_orchestrate', args);
    const blobs = await blobCount();
    const retried = await call('exarchos_orchestrate', args);

    expect(retried.data).toEqual(first.data);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('task.assigned')).toHaveLength(3);
    expect(await rowsOf('task.completed')).toHaveLength(3);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(3);
    expect(await blobCount()).toBe(blobs);
  });

  /**
   * Each task leaves the `task.completed` fact of the primitive path on the feature stream, from
   * the same leaf. `verified` is the flag of that leaf for caller-attached evidence, and a settled
   * claim attaches none. The verification is the durable gate row, not a field on the fact.
   *
   * Each ladder gate leaves an evidence row, and a policy-skipped gate records the skip. The three
   * static-analysis rows hold the verdicts that decided the batch.
   *
   * The projection reads the facts as progress. The transition is a separate call with its own
   * guard, and the guard admits it.
   */
  it('PrepareSettle_ASettledBatch_CompletesItsTasksAndAdmitsTheTransition', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    expect((settled.data as { outcome: string }).outcome).toBe('settled');

    const completions = (await rowsOf('task.completed')) as { data: { taskId: string; verified: boolean; worktreePath: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
    expect(completions.every((e) => e.data.verified === false && e.data.worktreePath === greenWorktree)).toBe(true);
    const evidence = (await rowsOf('admission.evidence-recorded')) as {
      data: { evidence: { requirementId: string; verdict: string } };
    }[];
    expect(evidence).toHaveLength(12);
    const decided = evidence.filter((e) => e.data.evidence.requirementId === 'verification-ladder:static-analysis');
    expect(decided.map((e) => e.data.evidence.verdict)).toEqual(['pass', 'pass', 'pass']);

    const got = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    expect(got.success, JSON.stringify(got)).toBe(true);
    const tasks = (got.data as { tasks: { id: string; status: string }[] }).tasks;
    expect(tasks.map((t) => t.status)).toEqual(['complete', 'complete', 'complete']);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
    const transitions = (await rowsOf('workflow.transition')) as { data: { to: string } }[];
    expect(transitions.at(-1)?.data.to).toBe('review');
  });

  /**
   * A worker reports that a capsule assumption is wrong. The compiled envelope admits the
   * deviation kind and requires approval, so `settle` holds the batch. It verifies nothing,
   * completes nothing, and names the pending deviation.
   *
   * The second `settle` call names the same batch and carries the decision and no claims. With
   * the deviation accepted, `settle` verifies the work and settles the batch. The decision is a
   * fact next to the proposal. The guards then admit the transition, as after any settled batch.
   */
  it('PrepareSettle_AHeldBatchDecided_IsThreeCallsAndCompletesItsTasks', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;

    const held = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: completedClaims(),
      deviations: [
        { deviationKind: 'invalidated-assumption', statement: 'the endpoint sends no validators; a bounded TTL cache replaces the ETag check' },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as { outcome: string; pendingDeviations?: { deviationId: string }[] };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations).toHaveLength(1);
    expect(await rowsOf('deviation.proposed')).toHaveLength(1);
    expect(await rowsOf('task.completed')).toEqual([]);

    const decided = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the endpoint really sends no validators',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    expect((decided.data as { outcome: string; round: number }).outcome).toBe('settled');
    expect((decided.data as { outcome: string; round: number }).round).toBe(1);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(2);
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * The capsule declares `worktreePath` as a string. A number on one claim is a field-type
   * mismatch, and it refuses the batch although `settle` admits the other two claims. A refused
   * batch is a settlement but not progress: `settle` verifies none of its tasks.
   */
  it('PrepareSettle_ABatchRejectedOnShape_VerifiesNothingAndLeavesNoCompletion', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const claims = completedClaims().map((claim, i) =>
      i === 0 ? { ...claim, fields: { worktreePath: 42 } } : claim,
    );
    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-wrong',
      claims,
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as { outcome: string; acceptedTasks: string[]; verification: unknown[] };
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.acceptedTasks).toEqual(['task-b', 'task-c']);
    expect(receipt.verification).toEqual([]);
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    expect(await rowsOf('orchestrate.intent_executed')).toEqual([]);
    expect(await rowsOf('task.completed')).toEqual([]);
  });

  /**
   * The negative twin of the normal path: the same call against a project whose lint fails. The
   * production gate records its failing verdict and halts the segment. `settle` rejects the batch
   * and names the halt of each task. The failing verdict is durable once for each task, no
   * completion is durable, and the tasks stay pending.
   */
  it('PrepareSettle_ABatchWhoseVerificationFails_IsRejectedWithTheHaltNamed', async () => {
    await seedDelegatingFeature();
    const redWorktree = await makeNodeFixture({ lint: FAIL, typecheck: OK, 'quality-check': OK });
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion } = prepared.data as PreparedReceipt;
    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-red',
      claims: completedClaims(redWorktree),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      findings: { kind: string; subject: string; message: string }[];
      verification: { taskId: string; outcome: string; failedLeaf?: string }[];
    };
    expect(receipt.outcome).toBe('rejected');
    expect(receipt.acceptedTasks).toEqual([]);
    expect(receipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['verification-failed', 'task-a'],
      ['verification-failed', 'task-b'],
      ['verification-failed', 'task-c'],
    ]);
    expect(receipt.findings.every((f) => f.message.includes('check_static_analysis'))).toBe(true);
    expect(receipt.verification.map((v) => [v.taskId, v.outcome, v.failedLeaf])).toEqual([
      ['task-a', 'failed', 'check_static_analysis'],
      ['task-b', 'failed', 'check_static_analysis'],
      ['task-c', 'failed', 'check_static_analysis'],
    ]);
    const gates = (await rowsOf('gate.executed')) as { data: { gateName: string; passed: boolean } }[];
    expect(gates.filter((g) => g.data.gateName === 'static-analysis' && !g.data.passed)).toHaveLength(3);
    expect(await rowsOf('task.completed')).toEqual([]);
    const got = await call('exarchos_workflow', { action: 'get', featureId: STREAM });
    const tasks = (got.data as { tasks: { status: string }[] }).tasks;
    expect(tasks.map((t) => t.status)).toEqual(['pending', 'pending', 'pending']);
  });

  /**
   * The test admits an evidence kind that the compilation did not admit. Then it submits the
   * edited document as the capsule of the work.
   */
  it('PrepareSettle_ACapsuleEditedAfterCompilation_IsRefused', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const receipt = prepared.data as PreparedReceipt;
    const kinds = receipt.capsule.contracts.evidenceKinds as string[];
    const edited = {
      ...receipt.capsule,
      contracts: { ...receipt.capsule.contracts, evidenceKinds: [...kinds, 'vibes'] },
    };

    const result = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsule: edited,
      batchId: 'batch-edited',
      claims: completedClaims(),
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('CAPSULE_DIGEST_MISMATCH');
    expect(await rowsOf('execution.settled')).toEqual([]);
  });

  /**
   * Settlement trusts this record. If the generic surface can append it, any caller can pin any
   * capsule and then settle against it.
   */
  it('PrepareSettle_APreparedRecord_CannotBeAppendedByAnyoneButPrepare', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'workflow.prepared',
          data: {
            operationId: 'prepare:forged',
            workflowId: STREAM,
            workflowType: 'feature',
            capsuleVersion: 1,
            definitionVersion: 'a'.repeat(64),
            designVersion: 'design-forged',
            capsuleDigest: 'f'.repeat(64),
            compilerVersion: 'forged',
            taskCount: 1,
            requestDigest: 'sha256:forged',
            bundleRefs: [
              { artifactId: 'run-bundle:prepared-capsule:forged:1', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
            ],
          },
        },
      },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'workflow.prepared' },
    });
    expect(await rowsOf('workflow.prepared')).toEqual([]);
  });

  /**
   * A decision lets `settle` verify and settle held work. If the generic surface can append it, a
   * caller can decide its own deviation and settle past the human that the envelope names.
   */
  it('PrepareSettle_ADecision_CannotBeAppendedByAnyoneButSettle', async () => {
    const result = await dispatch(
      'exarchos_event',
      {
        action: 'append',
        stream: STREAM,
        event: {
          type: 'deviation.decided',
          data: {
            operationId: 'settle:forged',
            workflowId: STREAM,
            capsuleVersion: 1,
            batchId: 'batch-1',
            deviationId: 'dev:forged',
            decision: 'accepted',
            actor: 'human:forged',
            rationale: 'forged',
          },
        },
      },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'deviation.decided' },
    });
    expect(await rowsOf('deviation.decided')).toEqual([]);
  });
});
