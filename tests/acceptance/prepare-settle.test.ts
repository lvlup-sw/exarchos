// The normal path of the semantic plane through the real dispatcher: one `prepare`, one `settle`,
// and nothing between them.
//
// Every call goes through `dispatch` with a real caller identity and capability resolver. Thus
// admission, the economy cap and the reserved-type guard apply as they do for an agent. One case
// stores a capsule in the form of an earlier build, through the commit function of `prepare`.
//
// `settle` accepts the capsule from `prepare` by version, and answers a retry of the same batch
// from the claim. It refuses an edited capsule, and only `prepare` can write the prepared record.
// To settle a batch, `settle` runs the production static-analysis gate on a real project and
// persists the verdict. The tasks are then complete on the stream, in the projection and on the
// state document, so the guards admit the next transition. When the lint of the project fails,
// the same call rejects the batch and names the halt.
//
// The tasks are low-risk and off the boundary, so the ladder runs static analysis only. Policy
// skips the kill probe, the contract-drift gate and the mock-boundary gate. No test needs a git
// repository.
//
// @oracle-sources: ../../src/verbs/prepare/handler.ts, the settlement record and bundle blobs counted out of the real event store and content-addressed store after each dispatched call

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { contentDigest } from '../../src/contract/capsule/capsule-digest.js';
import { ExarchosCapsuleV1Schema } from '../../src/contract/capsule/exarchos-capsule.js';
import { deriveMcpCallerIdentity } from '../../src/dispatch/caller-identity.js';
import { dispatch } from '../../src/dispatch/core/dispatch.js';
import { CapsuleRecompiledData, DesignRevisedData, WorkflowPreparedData } from '../../src/events/schemas.js';
import { EventStore } from '../../src/events/store.js';
import { PREPARE_ECONOMY_BUDGET_TOKENS } from '../../src/verbs/prepare/economy.js';
import { lowerBuiltInDefinition } from '../../src/verbs/prepare/lower-definition.js';
import { commitPreparedCapsule } from '../../src/verbs/prepare/prepared-record.js';
import { createInMemoryResolver } from '../../src/workflow/capabilities/resolver.js';
import { CURRENT_ES_VERSION } from '../../src/workflow/handlers/shared.js';
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
 * Seeds a feature workflow in `delegate` with its ready tasks and their integration branch.
 * The plan is the three tasks, unless a case names another plan. The events that the projection
 * folds and the document that the transition guards read hold the same facts.
 *
 * `document` adds fields to the document. A case that changes the plan through the `update` action
 * marks the document as event-sourced, as `init` does, so the action also appends the patch.
 */
async function seedDelegatingFeature(
  tasks: readonly (typeof TASKS)[number][] = TASKS,
  document: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  await initStateFile(stateDir, STREAM, 'feature', {
    ...document,
    phase: 'delegate',
    tasks: tasks.map(({ id, title, status }) => ({ id, title, status })),
  });
  await eventStore.append(STREAM, { type: 'workflow.started', data: { featureId: STREAM, workflowType: 'feature' } });
  await eventStore.append(STREAM, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
  await eventStore.append(STREAM, {
    type: 'state.patched',
    data: { patch: { 'synthesis.integrationBranch': 'feature/prepare-settle', tasks } },
  });
}

/**
 * Every named task claims the same worktree: where the work is, and what it touched.
 * The claims cover the three tasks, unless a case names the tasks of its batch.
 */
function completedClaims(
  worktreePath: string = greenWorktree,
  taskIds: readonly string[] = TASKS.map((task) => task.id),
): Record<string, unknown>[] {
  return taskIds.map((taskId) => ({
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
    readonly identity: { readonly designVersion: string };
    readonly graph: { readonly tasks: readonly { readonly taskId: string }[] };
    readonly contracts: Record<string, unknown>;
  };
  /** Present on the receipt of the first prepare after a design revision. */
  readonly recompile?: {
    readonly priorCapsuleVersion: number;
    readonly priorDesignVersion: number;
    readonly nextDesignVersion: number;
    readonly declaredTasks: readonly string[];
    readonly invalidatedTasks: readonly string[];
  };
}

/** The recompile rows of the stream, each parsed through the row schema. */
async function recompileRows(): Promise<ReturnType<typeof CapsuleRecompiledData.parse>[]> {
  return (await rowsOf('capsule.recompiled')).map((row) =>
    CapsuleRecompiledData.parse((row as { data: unknown }).data),
  );
}

/** The compiler name that the build before the design version counter stamped. */
const EARLIER_COMPILER_VERSION = 'exarchos-prepare-1';

/**
 * The design version id that the earlier compiler stamped for a workflow with no design reference.
 * It is the prefix, then the first sixteen hex digits of the digest of the absent reference.
 */
const EARLIER_DESIGN_VERSION_ID = `design-${contentDigest(null).slice(0, 16)}`;

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
    expect(receipt).not.toHaveProperty('recompile');
    expect(await rowsOf('capsule.recompiled')).toEqual([]);
  });

  /**
   * The retry returns the first answer. It appends no row, verifies nothing a second time and
   * writes no blob.
   */
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
   * Each of the four ladder gates leaves an evidence row for each task, and a policy-skipped gate
   * records the skip. The three static-analysis rows hold the verdicts that decided the batch.
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
   * A worker reports that the capsule lacks context. The compiled envelope admits the deviation
   * kind and requires approval, so `settle` holds the batch. It verifies nothing, completes
   * nothing, and names the pending deviation.
   *
   * The second `settle` call names the same batch and carries the decision and no claims. With
   * the deviation accepted, `settle` verifies the work and settles the batch. The decision is a
   * fact next to the proposal. The guards then admit the transition, as after any settled batch.
   *
   * The compiled envelope does not list this kind as material, so the acceptance revises nothing.
   */
  it('PrepareSettle_AHeldBatchDecided_IsThreeCallsAndCompletesItsTasks', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    const { capsuleVersion, capsule } = prepared.data as PreparedReceipt;
    expect(capsule.contracts.deviationEnvelope).toEqual({
      allowedDeviationKinds: ['invalidated-assumption', 'missing-context'],
      materialDeviationKinds: ['invalidated-assumption'],
      requiresApproval: true,
    });

    const held = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion,
      batchId: 'batch-1',
      claims: completedClaims(),
      deviations: [
        { deviationKind: 'missing-context', statement: 'the capsule does not say which cache the endpoint reads' },
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
        rationale: 'the capsule really does not name the cache',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    expect((decided.data as { outcome: string; round: number }).outcome).toBe('settled');
    expect((decided.data as { outcome: string; round: number }).round).toBe(1);
    expect(await rowsOf('deviation.decided')).toHaveLength(1);
    expect(await rowsOf('execution.settled')).toHaveLength(2);
    expect(await rowsOf('design.revised')).toEqual([]);
    expect(decided.data).not.toHaveProperty('designRevision');
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);

    const moved = await call('exarchos_workflow', { action: 'transition', featureId: STREAM, target: 'review' });
    expect(moved.success, JSON.stringify(moved)).toBe(true);
  });

  /**
   * The capsule declares `worktreePath` as a string. A number on one claim is a field-type
   * mismatch. The mismatch rejects the batch, although `settle` admits the other two claims. A
   * rejected batch is a settlement but not progress: `settle` verifies none of its tasks.
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
   * The stored capsule is the one that this build compiles, with two fields in the form of the
   * earlier build. They are the design version id in its hash form and the name of the earlier
   * compiler. No call of this build compiles that form, so the commit function of `prepare` puts
   * the capsule in custody as the next version. `settle` finds it by version and settles the batch.
   */
  it('PrepareSettle_ACapsuleStoredWithTheEarlierIdentityForm_StillSettles', async () => {
    await seedDelegatingFeature();
    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const current = ExarchosCapsuleV1Schema.parse((prepared.data as PreparedReceipt).capsule);
    expect(EARLIER_DESIGN_VERSION_ID).toMatch(/^design-[0-9a-f]{16}$/);
    expect(current.identity.designVersion).not.toBe(EARLIER_DESIGN_VERSION_ID);

    const earlierVersion = current.identity.capsuleVersion + 1;
    const earlier = ExarchosCapsuleV1Schema.parse({
      ...current,
      identity: { ...current.identity, designVersion: EARLIER_DESIGN_VERSION_ID, capsuleVersion: earlierVersion },
      provenance: { ...current.provenance, compilerVersion: EARLIER_COMPILER_VERSION },
    });
    const lowered = lowerBuiltInDefinition('feature');
    if (lowered === undefined) throw new Error('the feature workflow did not lower');
    await commitPreparedCapsule(callerContext(), {
      streamId: STREAM,
      operationId: 'prepare:recorded-by-the-earlier-compiler',
      requestDigest: 'sha256:recorded-by-the-earlier-compiler',
      workflowType: 'feature',
      capsule: earlier,
      definition: lowered.definition,
    });
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion, record.compilerVersion])).toEqual([
      [current.identity.capsuleVersion, 'design-v1', current.provenance.compilerVersion],
      [earlierVersion, EARLIER_DESIGN_VERSION_ID, EARLIER_COMPILER_VERSION],
    ]);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: earlierVersion,
      batchId: 'batch-earlier-form',
      claims: completedClaims(),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const receipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      capsule: { capsuleVersion: number; designVersion: string };
    };
    expect(receipt.outcome).toBe('settled');
    expect(receipt.acceptedTasks).toEqual(['task-a', 'task-b', 'task-c']);
    expect(receipt.capsule).toMatchObject({ capsuleVersion: earlierVersion, designVersion: EARLIER_DESIGN_VERSION_ID });
    expect(await rowsOf('execution.settled')).toHaveLength(1);
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual(['task-a', 'task-b', 'task-c']);
  });

  /**
   * The plan holds two tasks when the first capsule is compiled. Then the `update` action plans the
   * third task. A deviation can name only an unfinished task that its own batch does not claim, so
   * the deviation of the batch names the third task.
   *
   * The kind is material in the compiled envelope. The accepted decision settles the batch and
   * records one design revision. The settled batch keeps the design version that it was compiled
   * under. The next `prepare` compiles the third task under the next design version.
   *
   * That `prepare` is the continuation of the revision. Its commit holds one recompile row for
   * the third task, between the announcement of that task and the prepared record. Its receipt
   * names the same recompile, and a retry appends nothing.
   */
  it('PrepareSettle_AnAcceptedMaterialDeviation_RevisesTheDesignAndTheNextCapsuleCompilesUnderIt', async () => {
    const [first, second, third] = TASKS;
    if (first === undefined || second === undefined || third === undefined) throw new Error('the plan is three tasks');
    await seedDelegatingFeature([first, second], { _esVersion: CURRENT_ES_VERSION });

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsuleVersion).toBe(1);
    expect(compiled.capsule.identity.designVersion).toBe('design-v1');
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id, second.id]);

    const planned = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { tasks: TASKS },
    });
    expect(planned.success, JSON.stringify(planned)).toBe(true);

    const batch = { action: 'settle', featureId: STREAM, capsuleVersion: compiled.capsuleVersion, batchId: 'batch-1' };
    const held = await call('exarchos_orchestrate', {
      ...batch,
      claims: completedClaims(greenWorktree, [first.id, second.id]),
      deviations: [
        {
          deviationKind: 'invalidated-assumption',
          statement: 'the endpoint reads a cache that the design did not name',
          affectedTasks: [third.id],
          proposedChange: 'the third task reads the cache through the adapter',
        },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as {
      outcome: string;
      pendingDeviations?: { deviationId: string; affectedTasks?: string[] }[];
    };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations?.map((pending) => pending.affectedTasks)).toEqual([[third.id]]);
    expect(await rowsOf('design.revised')).toEqual([]);

    const decided = await call('exarchos_orchestrate', {
      ...batch,
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    const decidedReceipt = decided.data as {
      outcome: string;
      acceptedTasks: string[];
      capsule: { designVersion: string };
      designRevision?: { priorDesignVersion: number; nextDesignVersion: number; deviationIds: string[] };
    };
    expect(decidedReceipt.outcome).toBe('settled');
    expect(decidedReceipt.acceptedTasks).toEqual([first.id, second.id]);
    expect(decidedReceipt.capsule.designVersion).toBe('design-v1');
    const deviationIds = (heldReceipt.pendingDeviations ?? []).map((pending) => pending.deviationId);
    expect(deviationIds).toHaveLength(1);
    expect(decidedReceipt.designRevision).toStrictEqual({ priorDesignVersion: 1, nextDesignVersion: 2, deviationIds });

    const revisions = (await rowsOf('design.revised')).map((row) =>
      DesignRevisedData.parse((row as { data: unknown }).data),
    );
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      capsuleVersion: 1,
      batchId: 'batch-1',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds,
      affectedTasks: [third.id],
    });

    expect(compiled).not.toHaveProperty('recompile');
    expect(await recompileRows()).toEqual([]);
    const tailBeforeTheContinuation = (await eventStore.query(STREAM)).length;

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const next = recompiled.data as PreparedReceipt;
    expect(next.capsuleVersion).toBe(2);
    expect(next.capsule.identity.designVersion).toBe('design-v2');
    expect(next.capsule.graph.tasks.map((t) => t.taskId)).toEqual([third.id]);
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v2'],
    ]);

    const recompile = {
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [third.id],
      invalidatedTasks: [third.id],
    };
    expect(next.recompile).toStrictEqual(recompile);
    const continuation = (await eventStore.query(STREAM)).slice(tailBeforeTheContinuation);
    expect(continuation.map((event) => event.type)).toEqual([
      'task.assigned',
      'capsule.recompiled',
      'workflow.prepared',
    ]);
    expect(await recompileRows()).toStrictEqual([
      {
        operationId: records[1]?.operationId,
        workflowId: STREAM,
        capsuleVersion: 2,
        capsuleDigest: next.capsuleDigest,
        ...recompile,
        bundleRefs: records[1]?.bundleRefs,
      },
    ]);

    const retried = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(retried.data).toEqual(recompiled.data);
    expect(await eventStore.query(STREAM)).toHaveLength(tailBeforeTheContinuation + continuation.length);
  });

  /**
   * The first capsule holds one task. The `update` action then plans two tasks with no blocker, and
   * the deviation of the first batch names one of them. The second `prepare` runs before the
   * decision, so its capsule holds the named task under the terms that the revision changes.
   *
   * The accepted decision records the revision after the second capsule. A batch on that capsule is
   * rejected for the named task, and the unfinished sibling in it stays unfinished. The third
   * `prepare` compiles a new capsule under the next design version, and both tasks settle under it.
   *
   * The second `prepare` comes before the revision, so it records no recompile. The third is the
   * continuation. Its recompile row names the second capsule as the prior one, and it invalidates
   * the named task and not the sibling.
   */
  it('PrepareSettle_AClaimRefusedForALaterRevision_SettlesAfterTheNextPrepare', async () => {
    const [first, sibling, named] = TASKS;
    if (first === undefined || sibling === undefined || named === undefined) throw new Error('the plan is three tasks');
    await seedDelegatingFeature([first], { _esVersion: CURRENT_ES_VERSION });

    const prepared = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(prepared.success, JSON.stringify(prepared)).toBe(true);
    const compiled = prepared.data as PreparedReceipt;
    expect(compiled.capsuleVersion).toBe(1);
    expect(compiled.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id]);

    const planned = await call('exarchos_workflow', {
      action: 'update',
      featureId: STREAM,
      updates: { tasks: TASKS },
    });
    expect(planned.success, JSON.stringify(planned)).toBe(true);

    const firstBatch = { action: 'settle', featureId: STREAM, capsuleVersion: compiled.capsuleVersion, batchId: 'batch-1' };
    const held = await call('exarchos_orchestrate', {
      ...firstBatch,
      claims: completedClaims(greenWorktree, [first.id]),
      deviations: [
        {
          deviationKind: 'invalidated-assumption',
          statement: 'the endpoint reads a cache that the design did not name',
          affectedTasks: [named.id],
          proposedChange: 'the named task reads the cache through the adapter',
        },
      ],
    });
    expect(held.success, JSON.stringify(held)).toBe(true);
    const heldReceipt = held.data as { outcome: string; pendingDeviations?: { deviationId: string }[] };
    expect(heldReceipt.outcome).toBe('deviation-pending');
    expect(heldReceipt.pendingDeviations).toHaveLength(1);

    const beforeTheDecision = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(beforeTheDecision.success, JSON.stringify(beforeTheDecision)).toBe(true);
    const second = beforeTheDecision.data as PreparedReceipt;
    expect(second.capsuleVersion).toBe(2);
    expect(second.capsule.identity.designVersion).toBe('design-v1');
    expect(second.capsule.graph.tasks.map((t) => t.taskId)).toEqual([first.id, sibling.id, named.id]);
    expect(second).not.toHaveProperty('recompile');

    const decided = await call('exarchos_orchestrate', {
      ...firstBatch,
      decisions: (heldReceipt.pendingDeviations ?? []).map(({ deviationId }) => ({
        deviationId,
        decision: 'accepted',
        actor: 'human:reviewer',
        rationale: 'the design did not name the cache, and the change is sound',
      })),
    });
    expect(decided.success, JSON.stringify(decided)).toBe(true);
    const decidedReceipt = decided.data as {
      outcome: string;
      acceptedTasks: string[];
      designRevision?: { priorDesignVersion: number; nextDesignVersion: number };
    };
    expect(decidedReceipt.outcome).toBe('settled');
    expect(decidedReceipt.acceptedTasks).toEqual([first.id]);
    expect(decidedReceipt.designRevision).toMatchObject({ priorDesignVersion: 1, nextDesignVersion: 2 });

    const stream = await eventStore.query(STREAM);
    const revisionRows = stream.filter((event) => event.type === 'design.revised');
    expect(revisionRows).toHaveLength(1);
    expect(DesignRevisedData.parse(revisionRows[0]?.data).affectedTasks).toEqual([named.id]);
    const secondRecord = stream.filter((event) => event.type === 'workflow.prepared')[1];
    expect(WorkflowPreparedData.parse(secondRecord?.data).capsuleVersion).toBe(2);
    expect(secondRecord?.sequence ?? Number.NaN).toBeLessThan(revisionRows[0]?.sequence ?? Number.NaN);

    const refused = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: second.capsuleVersion,
      batchId: 'batch-2',
      claims: completedClaims(),
    });
    expect(refused.success, JSON.stringify(refused)).toBe(true);
    const refusedReceipt = refused.data as {
      outcome: string;
      findings: { kind: string; subject: string; message: string }[];
      verification: unknown[];
    };
    expect(refusedReceipt.outcome).toBe('rejected');
    expect(refusedReceipt.findings.map((f) => [f.kind, f.subject])).toEqual([
      ['claim-superseded-by-revision', named.id],
    ]);
    expect(refusedReceipt.findings[0]?.message).toContain('design version 2');
    expect(refusedReceipt.findings[0]?.message).toContain('prepare again');
    expect(refusedReceipt.verification).toEqual([]);
    expect(await rowsOf('orchestrate.intent_executed')).toHaveLength(1);
    const completedBefore = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completedBefore.map((e) => e.data.taskId)).toEqual([first.id]);
    expect(await recompileRows()).toEqual([]);

    const recompiled = await call('exarchos_orchestrate', { action: 'prepare', featureId: STREAM });
    expect(recompiled.success, JSON.stringify(recompiled)).toBe(true);
    const third = recompiled.data as PreparedReceipt;
    expect(third.capsuleVersion).toBe(3);
    expect(third.capsuleDigest).not.toBe(second.capsuleDigest);
    expect(third.capsule.identity.designVersion).toBe('design-v2');
    expect(third.capsule.graph.tasks.map((t) => t.taskId)).toEqual([sibling.id, named.id]);
    const records = (await rowsOf('workflow.prepared')).map((row) =>
      WorkflowPreparedData.parse((row as { data: unknown }).data),
    );
    expect(records.map((record) => [record.capsuleVersion, record.designVersion])).toEqual([
      [1, 'design-v1'],
      [2, 'design-v1'],
      [3, 'design-v2'],
    ]);
    const recompile = {
      priorCapsuleVersion: 2,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: [named.id],
      invalidatedTasks: [named.id],
    };
    expect(third.recompile).toStrictEqual(recompile);
    expect(await recompileRows()).toMatchObject([
      { capsuleVersion: 3, capsuleDigest: third.capsuleDigest, ...recompile },
    ]);

    const settled = await call('exarchos_orchestrate', {
      action: 'settle',
      featureId: STREAM,
      capsuleVersion: third.capsuleVersion,
      batchId: 'batch-3',
      claims: completedClaims(greenWorktree, [sibling.id, named.id]),
    });
    expect(settled.success, JSON.stringify(settled)).toBe(true);
    const settledReceipt = settled.data as {
      outcome: string;
      acceptedTasks: string[];
      findings: unknown[];
      capsule: { capsuleVersion: number; designVersion: string };
    };
    expect(settledReceipt.outcome).toBe('settled');
    expect(settledReceipt.findings).toEqual([]);
    expect(settledReceipt.acceptedTasks).toEqual([sibling.id, named.id]);
    expect(settledReceipt.capsule).toMatchObject({ capsuleVersion: 3, designVersion: 'design-v2' });
    const completions = (await rowsOf('task.completed')) as { data: { taskId: string } }[];
    expect(completions.map((e) => e.data.taskId).sort()).toEqual([first.id, sibling.id, named.id]);
    expect(await rowsOf('design.revised')).toHaveLength(1);
    expect(await recompileRows()).toHaveLength(1);
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

  /**
   * A revision row moves the design version of the stream. If the generic surface can append it, a
   * caller can revise the design with no accepted deviation. The row is well formed, so the
   * refusal is the reservation and not the shape of the row.
   */
  it('PrepareSettle_ADesignRevision_CannotBeAppendedByAnyoneButSettle', async () => {
    const data = {
      operationId: 'settle:forged',
      workflowId: STREAM,
      capsuleVersion: 1,
      batchId: 'batch-1',
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      deviationIds: ['dev:forged'],
      affectedTasks: [],
      bundleRefs: [
        { artifactId: 'run-bundle:settlement-adjudication:batch-1:1', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
      ],
    };
    expect(DesignRevisedData.safeParse(data).success).toBe(true);

    const result = await dispatch(
      'exarchos_event',
      { action: 'append', stream: STREAM, event: { type: 'design.revised', data } },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'design.revised' },
    });
    expect(await rowsOf('design.revised')).toEqual([]);
  });

  /**
   * A recompile row says that a prepare compiled a capsule again after a revision, and it names
   * the tasks that the revision invalidated. If the generic surface can append it, a caller can
   * record a recompile that no prepare made. The row is well formed, so the refusal is the
   * reservation and not the shape of the row.
   */
  it('PrepareSettle_ARecompileRecord_CannotBeAppendedByAnyoneButPrepare', async () => {
    const data = {
      operationId: 'prepare:forged',
      workflowId: STREAM,
      capsuleVersion: 2,
      capsuleDigest: 'f'.repeat(64),
      priorCapsuleVersion: 1,
      priorDesignVersion: 1,
      nextDesignVersion: 2,
      declaredTasks: ['task-c'],
      invalidatedTasks: ['task-c'],
      bundleRefs: [
        { artifactId: 'run-bundle:prepared-capsule:forged:2', digest: { algorithm: 'sha256', value: 'f'.repeat(64) } },
      ],
    };
    expect(CapsuleRecompiledData.safeParse(data).success).toBe(true);

    const result = await dispatch(
      'exarchos_event',
      { action: 'append', stream: STREAM, event: { type: 'capsule.recompiled', data } },
      callerContext(),
    );
    expect(result).toMatchObject({
      success: false,
      error: { code: 'RESERVED_EVENT_TYPE', eventType: 'capsule.recompiled' },
    });
    expect(await rowsOf('capsule.recompiled')).toEqual([]);
  });
});
