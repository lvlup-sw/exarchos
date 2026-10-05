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
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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
