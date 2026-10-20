/**
 * Governance tier: the chain from gate to durable evidence to completion.
 *
 * Each test drives the real `dispatch()` through `createPublicRootHarness`, which builds the context with the production composition root.
 * Nothing is a stub. `check_static_analysis` runs the npm scripts of a real fixture repository.
 * The verdict persists as an `admission.evidence-recorded` row.
 * `task_complete` reads the `gate.executed` signal that the gate runner mints from that row.
 *
 * Each criterion has a BLOCKING ARM and its NEGATIVE TWIN:
 * - `task_complete` gates on a real event, not on evidence from the caller.
 * - The governed cannot supply governance.
 * - A skipped constituent cannot render as a pass.
 *
 * One `settle` case brings the state document level in the `workflow_state` row of the shipped store.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createPublicRootHarness,
  assertNoStubbedCompositeHandlers,
  type PublicRootHarness,
  type DispatchObservation,
} from '../_harness.js';
import { deriveLocalOperatorIdentity } from '../../../../src/dispatch/caller-identity.js';
import { AdmissionEvidenceRecordedData, type WorkflowEvent } from '../../../../src/events/schemas.js';
import { EventStore } from '../../../../src/events/store.js';
import type { EvidenceSubjectV1 } from '../../../../src/workflow/admission/types.js';
import { initStateFile, readStateFile, writeStateFile } from '../../../../src/workflow/state-store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { seedStaticAnalysisVerdict } from '../../../helpers/static-analysis-verdict.js';

type Rec = Record<string, unknown>;

const FEATURE_ID = 'gov-t2-gate-before-completion';

/** Real npm scripts. `node -e` is the cheapest process that exits with 0 or 1. */
const OK = 'node -e ""';
const FAIL = 'node -e "process.exit(1)"';

let harness: PublicRootHarness;
let verifiedComposites: readonly string[] = [];
const scratchDirs: string[] = [];

/** Makes a real Node project on disk that the production static-analysis gate can run. */
async function makeNodeFixture(scripts: Record<string, string>): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gov-t2-sa-')));
  scratchDirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'gov-t2-fixture', version: '1.0.0', private: true, scripts }, null, 2),
    'utf-8',
  );
  return dir;
}

function payload(obs: DispatchObservation): Rec {
  return (obs.result?.data ?? {}) as Rec;
}

/** The placeholder form of a runbook step param. The intent compiler reads the same form. */
const PLACEHOLDER = /^<([A-Za-z0-9_]+)>$/;

/**
 * Binds the `<var>` placeholders of a step to values, as an agent does when it follows a runbook directly.
 * A placeholder with no value throws, so the test cannot run a step with a missing variable.
 */
function bindStepParams(params: Rec, bindings: Readonly<Record<string, string>>): Rec {
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => {
      const variable = typeof value === 'string' ? PLACEHOLDER.exec(value)?.[1] : undefined;
      if (variable === undefined) return [key, value];
      const bound = bindings[variable];
      if (bound === undefined) throw new Error(`no value for the runbook variable <${variable}>`);
      return [key, bound];
    }),
  );
}

/**
 * Reads the durable `gate.executed` rows for one task from the real event store.
 * The gate check of `task_complete` reads only `gate.executed` events.
 */
async function gateSignalsFor(taskId: string): Promise<readonly Rec[]> {
  const events = await harness.events(FEATURE_ID);
  return events
    .filter((e) => e.type === 'gate.executed')
    .map((e): Rec => ({ ...(e.data as Rec), __source: e.source }))
    .filter((d) => ((d.details as Rec | undefined)?.taskId ?? null) === taskId);
}

/** The subject of the first evidence record in the rows whose subject is the task, or undefined when none exists. */
function taskSubjectIn(rows: readonly WorkflowEvent[], taskId: string): EvidenceSubjectV1 | undefined {
  for (const row of rows) {
    if (row.type !== 'admission.evidence-recorded') continue;
    const parsed = AdmissionEvidenceRecordedData.safeParse(row.data);
    if (!parsed.success) continue;
    const { subject } = parsed.data.evidence;
    if (subject.kind === 'task' && subject.taskId === taskId) return subject;
  }
  return undefined;
}

/**
 * The override is a context seam only. It gives a trusted local-operator identity, which the durable gate producer requires.
 * It replaces no handler.
 */
beforeAll(async () => {
  harness = await createPublicRootHarness({
    overrides: { callerIdentity: deriveLocalOperatorIdentity('gov-t2-gate') },
  });
  await harness.runAction('exarchos_workflow', 'init', {
    featureId: FEATURE_ID,
    workflowType: 'feature',
  });
}, 120_000);

afterAll(async () => {
  await harness?.dispose();
  for (const dir of scratchDirs) {
    await rmrfAsync(dir).catch(() => undefined);
  }
});

describe('T2 governance — gate before completion (DR-1, DR-2, DR-6)', () => {
  /**
   * The named acceptance test for a red gate.
   * BLOCKING ARM: the gate runs and returns a red verdict, which the gate runner mints as one `gate.executed` signal with `passed: false`.
   * Then `task_complete` gets `GATE_NOT_PASSED` with `unmetGates: ['static-analysis']`, and no `task.completed` event exists for the task.
   * NEGATIVE TWIN: the same call for a task with a green gate succeeds, so the gate verdict caused the refusal.
   */
  it('Governance_BlockingGateRed_BlocksTaskCompletion', async () => {
    const redRepo = await makeNodeFixture({
      lint: FAIL,
      typecheck: OK,
      'quality-check': OK,
    });
    const greenRepo = await makeNodeFixture({
      lint: OK,
      typecheck: OK,
      'quality-check': OK,
    });

    const redGate = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-red', repoRoot: redRepo },
      { timeoutMs: 180_000 },
    );
    expect(redGate.result?.success).toBe(true);
    expect(payload(redGate).passed).toBe(false);
    expect(payload(redGate).failCount).toBeGreaterThan(0);

    const redSignals = await gateSignalsFor('T-red');
    expect(redSignals).toHaveLength(1);
    expect(redSignals[0]?.gateName).toBe('static-analysis');
    expect(redSignals[0]?.passed).toBe(false);
    expect(redSignals[0]?.__source).toBe('gate-runner/v1/static-analysis');

    const blocked = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-red',
      streamId: FEATURE_ID,
    });
    expect(blocked.result?.success).toBe(false);
    expect(blocked.errorCode).toBe('GATE_NOT_PASSED');
    expect(blocked.result?.error?.unmetGates).toEqual(['static-analysis']);
    expect(blocked.handlerEntered).toBe(true);

    const afterBlock = await harness.events(FEATURE_ID);
    expect(
      afterBlock.filter(
        (e) => e.type === 'task.completed' && (e.data as Rec | undefined)?.taskId === 'T-red',
      ),
    ).toHaveLength(0);

    const greenGate = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-green', repoRoot: greenRepo },
      { timeoutMs: 180_000 },
    );
    expect(payload(greenGate).passed).toBe(true);

    const greenSignals = await gateSignalsFor('T-green');
    expect(greenSignals).toHaveLength(1);
    expect(greenSignals[0]?.passed).toBe(true);

    const allowed = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-green',
      streamId: FEATURE_ID,
    });
    expect(allowed.errorCode).toBeUndefined();
    expect(allowed.result?.success).toBe(true);
    expect((allowed.result?.data as Rec | undefined)?.type).toBe('task.completed');
  }, 400_000);

  /**
   * The gate accepts only a durable event from the gate runner, never evidence that the caller gives to `task_complete`.
   * BLOCKING ARM: a local operator supplies passing `evidence` for a task with no gate row, and still gets `GATE_NOT_PASSED`.
   * The self-supplied evidence does not become a gate row.
   * NEGATIVE TWIN: the identical call without an `evidence` field succeeds for a task whose gate ran green.
   * The signal of that gate comes from the gate runner and refers to the persisted evidence record.
   * Both arms use the same operator identity and the same action, so they differ only in the durable evidence.
   */
  it('Governance_Dr1Dr2_CallerSuppliedEvidence_CannotSatisfyBlockingGate', async () => {
    expect(await gateSignalsFor('T-selfattested')).toHaveLength(0);

    const selfAttested = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-selfattested',
      streamId: FEATURE_ID,
      evidence: {
        type: 'test',
        output: 'I ran the checks myself and everything passed.',
        passed: true,
      },
    });
    expect(selfAttested.result?.success).toBe(false);
    expect(selfAttested.errorCode).toBe('GATE_NOT_PASSED');
    expect(selfAttested.result?.error?.unmetGates).toEqual(['static-analysis']);
    expect(String(selfAttested.result?.error?.message)).toContain('static-analysis');

    expect(await gateSignalsFor('T-selfattested')).toHaveLength(0);

    const repo = await makeNodeFixture({ lint: OK, typecheck: OK, 'quality-check': OK });
    await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-attested', repoRoot: repo },
      { timeoutMs: 180_000 },
    );
    const signals = await gateSignalsFor('T-attested');
    expect(signals).toHaveLength(1);
    expect(signals[0]?.passed).toBe(true);
    expect(signals[0]?.__source).toBe('gate-runner/v1/static-analysis');
    expect(String((signals[0]?.details as Rec | undefined)?.evidenceId)).toMatch(/^evidence:/);

    const accepted = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-attested',
      streamId: FEATURE_ID,
    });
    expect(accepted.result?.success).toBe(true);
    expect(accepted.errorCode).toBeUndefined();

    expect(selfAttested.actionId).toBe(accepted.actionId);
  }, 400_000);

  /**
   * A skipped constituent cannot render as a pass.
   * BLOCKING ARM: a fixture without `quality-check` has no failure and one skip, but the gate reports `passed: false` and `degraded`.
   * The signal has `passed: false` with the verdict `indeterminate`, and `task_complete` gets `GATE_NOT_PASSED`.
   * NEGATIVE TWIN: with the missing script added to the same repository, the identical run reports a pass.
   */
  it('Governance_Dr6_SkippedConstituent_RendersDegradedNotPass', async () => {
    const partial = await makeNodeFixture({ lint: OK, typecheck: OK });

    const degraded = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-skip', repoRoot: partial },
      { timeoutMs: 180_000 },
    );
    const d = payload(degraded);
    expect(d.failCount).toBe(0);
    expect(d.skipCount).toBe(1);
    expect(d.passed).toBe(false);
    expect(d.degraded).toBe(true);
    expect(d.skipReason).toBe('constituent-skipped');
    expect(String(d.report)).toContain('**Result: DEGRADED**');
    expect(String(d.report)).not.toContain('**Result: PASS**');

    const degradedSignals = await gateSignalsFor('T-skip');
    expect(degradedSignals).toHaveLength(1);
    expect(degradedSignals[0]?.passed).toBe(false);
    expect((degradedSignals[0]?.details as Rec | undefined)?.verdict).toBe('indeterminate');

    const refused = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-skip',
      streamId: FEATURE_ID,
    });
    expect(refused.errorCode).toBe('GATE_NOT_PASSED');
    expect(refused.result?.error?.unmetGates).toEqual(['static-analysis']);

    const pkgPath = path.join(partial, 'package.json');
    const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as {
      scripts: Record<string, string>;
    };
    pkg.scripts['quality-check'] = OK;
    await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2), 'utf-8');

    const complete = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-noskip', repoRoot: partial },
      { timeoutMs: 180_000 },
    );
    const c = payload(complete);
    expect(c.skipCount).toBe(0);
    expect(c.passed).toBe(true);
    expect(c.degraded).toBeFalsy();
    expect(String(c.report)).toContain('**Result: PASS**');

    const twinSignals = await gateSignalsFor('T-noskip');
    expect(twinSignals[0]?.passed).toBe(true);
    expect((twinSignals[0]?.details as Rec | undefined)?.verdict).toBe('pass');
  }, 400_000);

  /**
   * The documented direct path completes a task.
   * The agent reads each completion runbook through the `runbook` action and binds its variables.
   * Then it runs the static-analysis step and `task_complete` for the same task, with no other params.
   * The step must bind the worktree, so the gate runs on the fixture and not in the process directory.
   * The step must bind the task, because `task_complete` refuses a gate record that names no task.
   */
  it('Governance_DocumentedRunbookPath_StaticAnalysisStepCompletesTheTask', async () => {
    const repo = await makeNodeFixture({ lint: OK, typecheck: OK, 'quality-check': OK });
    const paths: ReadonlyArray<{ readonly runbookId: string; readonly taskId: string }> = [
      { runbookId: 'task-completion', taskId: 'T-runbook-complete' },
      { runbookId: 'task-fix', taskId: 'T-runbook-fix' },
    ];
    for (const { runbookId, taskId } of paths) {
      const resolved = await harness.runAction('exarchos_orchestrate', 'runbook', { id: runbookId });
      expect(resolved.result?.success, runbookId).toBe(true);
      const steps = (payload(resolved).steps ?? []) as readonly Rec[];
      const step = steps.find((s) => s.action === 'check_static_analysis');
      expect(step, `${runbookId} must have a check_static_analysis step`).toBeDefined();
      const params = bindStepParams((step?.params ?? {}) as Rec, { taskId, worktreePath: repo });
      expect(params, runbookId).toMatchObject({ repoRoot: 'auto', worktreePath: repo });

      const gate = await harness.runAction(
        'exarchos_orchestrate',
        'check_static_analysis',
        { featureId: FEATURE_ID, ...params },
        { timeoutMs: 180_000 },
      );
      expect(gate.result?.success, runbookId).toBe(true);
      expect(payload(gate).passed, runbookId).toBe(true);

      const completed = await harness.runAction('exarchos_orchestrate', 'task_complete', {
        taskId,
        streamId: FEATURE_ID,
      });
      expect(completed.errorCode, runbookId).toBeUndefined();
      expect(completed.result?.success, runbookId).toBe(true);
      expect((completed.result?.data as Rec | undefined)?.type, runbookId).toBe('task.completed');
    }
  }, 400_000);

  /**
   * The static-analysis seed of the reader tests writes the subject that a real run writes.
   * The real gate runs for a task with the default base, and the seed runs for the same task on a scratch store.
   * The two subjects are equal, so the evidence id and the chain of a seeded record follow a real run.
   */
  it('Governance_StaticAnalysisSeed_WritesTheSubjectOfARealRun', async () => {
    const repo = await makeNodeFixture({ lint: OK, typecheck: OK, 'quality-check': OK });
    const taskId = 'T-seed-subject';
    const gate = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId, repoRoot: repo },
      { timeoutMs: 180_000 },
    );
    expect(payload(gate).passed).toBe(true);
    const real = taskSubjectIn(await harness.events(FEATURE_ID), taskId);
    expect(real).toBeDefined();

    const scratchDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gov-t2-seed-')));
    scratchDirs.push(scratchDir);
    const scratch = new EventStore(scratchDir);
    await scratch.initialize();
    try {
      await seedStaticAnalysisVerdict(scratch, { streamId: FEATURE_ID, taskId, stateDir: scratchDir });
      expect(taskSubjectIn(await scratch.query(FEATURE_ID), taskId)).toEqual(real);
    } finally {
      scratch.close();
    }
  }, 400_000);

  /**
   * The completion runbook has no blocking gate after `task_complete`. A gate that runs after its subject is decorative.
   * BLOCKING ARM: the predicate finds no blocking gate after `task_complete` in the real runbook, and blocking gates do exist.
   * NEGATIVE TWIN: the predicate detects a blocking gate appended to a copy, and a list without a `task_complete` step.
   * Thus a predicate that always returns `[]` cannot pass this test.
   */
  it('Governance_Dr1_TaskCompletionRunbook_HasNoBlockingGateAfterTaskComplete', async () => {
    interface Step {
      readonly seq?: number;
      readonly action?: string;
      readonly gate?: { readonly blocking?: boolean } | null;
    }
    const blockingGatesAfterCompletion = (steps: readonly Step[]): readonly string[] => {
      const idx = steps.findIndex((s) => s.action === 'task_complete');
      if (idx < 0) return ['<task_complete step is missing entirely>'];
      return steps
        .slice(idx + 1)
        .filter((s) => s.gate?.blocking === true)
        .map((s) => s.action ?? '<unnamed>');
    };

    const resolved = await harness.runAction('exarchos_orchestrate', 'runbook', {
      id: 'task-completion',
    });
    expect(resolved.result?.success).toBe(true);
    const steps = (payload(resolved).steps ?? []) as readonly Step[];
    expect(steps.length).toBeGreaterThan(1);
    expect(steps.some((s) => s.action === 'task_complete')).toBe(true);

    expect(blockingGatesAfterCompletion(steps)).toEqual([]);
    const gateSteps = steps.filter((s) => s.gate?.blocking === true);
    expect(gateSteps.length).toBeGreaterThan(0);

    const corrupted: Step[] = [
      ...steps,
      { seq: 999, action: 'check_static_analysis', gate: { blocking: true } },
    ];
    expect(blockingGatesAfterCompletion(corrupted)).toEqual(['check_static_analysis']);
    expect(blockingGatesAfterCompletion([{ action: 'noop' }])).toEqual([
      '<task_complete step is missing entirely>',
    ]);
  }, 120_000);

  /**
   * The anti-stub invariant of this tier.
   * The check inspects only the composites that this process loaded, so the test asserts the returned list.
   * An empty list makes the check vacuous.
   */
  it('Governance_GateTier_DrivesRealCompositeHandlers', async () => {
    verifiedComposites = await assertNoStubbedCompositeHandlers();
    expect(verifiedComposites).toContain('exarchos_orchestrate');
    expect(verifiedComposites).toContain('exarchos_workflow');
    expect(harness.reachedActionIds()).toContain('exarchos_orchestrate.task_complete');
    expect(harness.reachedActionIds()).toContain('exarchos_orchestrate.check_static_analysis');
  });
});

/** The workflow of the `settle` case. It is apart from the workflow of the gate cases. */
const SETTLE_FEATURE_ID = 'gov-t2-settle-document-row';

/** The status of each task in the state document that the transition guards read. */
async function documentStatuses(): Promise<unknown[][]> {
  const state = await readStateFile(path.join(harness.stateDir, `${SETTLE_FEATURE_ID}.state.json`));
  const tasks: readonly unknown[] = Array.isArray(state.tasks) ? state.tasks : [];
  return tasks.map((task) => {
    const entry: { readonly id?: unknown; readonly status?: unknown } = typeof task === 'object' && task !== null ? task : {};
    return [entry.id, entry.status];
  });
}

/**
 * The twin of the levelling cases of `settle` in the row form of the shipped store. The acceptance
 * and handler cases keep the state document in a JSON file. Here the production composition root
 * keeps it in the `workflow_state` row of the SQLite backend, with telemetry at its shipped default.
 */
describe('settle levels the state document in the workflow_state row', () => {
  /**
   * The first batch completes one task and leaves the other unresolved. The test then puts the row
   * back to an earlier status through the store writer, as after a lost write. A retry of
   * the batch returns its receipt and brings the complete task level in the row. The correction
   * claims only the unresolved task and settles, and the guard that reads the row admits the move.
   */
  it('Governance_SettleOnTheWorkflowStateRow_BringsTheDocumentLevel', async () => {
    const green = await makeNodeFixture({ lint: OK, typecheck: OK, 'quality-check': OK });
    const red = await makeNodeFixture({ lint: FAIL, typecheck: OK, 'quality-check': OK });
    const tasks = ['task-a', 'task-b'].map((id) => ({
      id,
      title: id,
      status: 'pending',
      blockedBy: [],
      riskTier: 'low',
      boundaryTouching: false,
    }));
    await initStateFile(harness.stateDir, SETTLE_FEATURE_ID, 'feature', {
      phase: 'delegate',
      tasks: tasks.map(({ id, title, status }) => ({ id, title, status })),
    });
    expect(harness.storage.getState(SETTLE_FEATURE_ID)?.phase).toBe('delegate');
    expect(harness.ctx.enableTelemetry, 'the twin keeps the shipped telemetry default').toBe(true);
    await harness.appendEvent(SETTLE_FEATURE_ID, {
      type: 'workflow.started',
      data: { featureId: SETTLE_FEATURE_ID, workflowType: 'feature' },
    });
    await harness.appendEvent(SETTLE_FEATURE_ID, { type: 'workflow.transition', data: { from: 'plan-review', to: 'delegate' } });
    await harness.appendEvent(SETTLE_FEATURE_ID, {
      type: 'state.patched',
      data: { patch: { 'synthesis.integrationBranch': 'feature/settle-row', tasks } },
    });

    const prepared = await harness.runAction('exarchos_orchestrate', 'prepare', { featureId: SETTLE_FEATURE_ID });
    expect(prepared.result?.success, JSON.stringify(prepared.result)).toBe(true);
    const capsuleVersion = (payload(prepared).capsuleVersion ?? 0) as number;
    const claimOf = (taskId: string, worktreePath: string): Rec => ({ taskId, fields: { worktreePath }, evidence: [] });
    const firstBatch = {
      featureId: SETTLE_FEATURE_ID,
      capsuleVersion,
      batchId: 'batch-row',
      claims: [claimOf('task-a', green), claimOf('task-b', red)],
    };
    const first = await harness.runAction('exarchos_orchestrate', 'settle', firstBatch, { timeoutMs: 180_000 });
    expect(first.result?.success, JSON.stringify(first.result)).toBe(true);
    expect(payload(first)).toMatchObject({ outcome: 'corrective-capsule', acceptedTasks: ['task-a'] });
    expect(await documentStatuses()).toEqual([
      ['task-a', 'complete'],
      ['task-b', 'pending'],
    ]);

    const stateFile = path.join(harness.stateDir, `${SETTLE_FEATURE_ID}.state.json`);
    const level = await readStateFile(stateFile);
    const stale = level.tasks.map((task): typeof task => ({ ...task, status: 'pending' }));
    await writeStateFile(stateFile, { ...level, tasks: stale }, { expectedVersion: level._version ?? 1 });
    expect(await documentStatuses()).toEqual([
      ['task-a', 'pending'],
      ['task-b', 'pending'],
    ]);

    const retried = await harness.runAction('exarchos_orchestrate', 'settle', firstBatch, { timeoutMs: 180_000 });
    expect(retried.result?.success, JSON.stringify(retried.result)).toBe(true);
    expect(retried.result?.data).toEqual(first.result?.data);
    expect(await documentStatuses()).toEqual([
      ['task-a', 'complete'],
      ['task-b', 'pending'],
    ]);
    const early = await harness.runAction('exarchos_workflow', 'transition', { featureId: SETTLE_FEATURE_ID, target: 'review' });
    expect(early.errorCode).toBe('GUARD_FAILED');

    const corrected = await harness.runAction(
      'exarchos_orchestrate',
      'settle',
      { featureId: SETTLE_FEATURE_ID, capsuleVersion, batchId: 'batch-row-correction', claims: [claimOf('task-b', green)] },
      { timeoutMs: 180_000 },
    );
    expect(corrected.result?.success, JSON.stringify(corrected.result)).toBe(true);
    expect(payload(corrected)).toMatchObject({ outcome: 'settled', acceptedTasks: ['task-b'] });
    expect(await documentStatuses()).toEqual([
      ['task-a', 'complete'],
      ['task-b', 'complete'],
    ]);
    const moved = await harness.runAction('exarchos_workflow', 'transition', { featureId: SETTLE_FEATURE_ID, target: 'review' });
    expect(moved.result?.success, JSON.stringify(moved.result)).toBe(true);
    expect(harness.storage.getState(SETTLE_FEATURE_ID)?.phase).toBe('review');
  }, 400_000);
});
