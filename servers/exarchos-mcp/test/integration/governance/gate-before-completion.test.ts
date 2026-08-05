/**
 * T2 governance tier — the *gate → durable evidence → completion* chain.
 *
 * DR-28: every assertion here is driven through the REAL public root
 * (`dispatch()`), against the production composition root built by
 * `createPublicRootHarness`. Nothing is stubbed: `check_static_analysis`
 * really shells out to a real fixture repo's npm scripts, the verdict is
 * really persisted as an `admission.evidence-recorded` row, and
 * `task_complete` really reads back the `gate.executed` signal minted from it.
 *
 * Criteria covered here (each with a BLOCKING arm and its NEGATIVE TWIN):
 *   DR-1  `task_complete` gates on a real event, not caller-supplied evidence
 *   DR-2  the governed cannot supply governance
 *   DR-6  `skipped` cannot render as PASS
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
import { deriveLocalOperatorIdentity } from '../../../src/dispatch/caller-identity.js';

type Rec = Record<string, unknown>;

const FEATURE_ID = 'gov-t2-gate-before-completion';

/** Real npm scripts — `node -e ""` is the cheapest process that exits 0/1. */
const OK = 'node -e ""';
const FAIL = 'node -e "process.exit(1)"';

let harness: PublicRootHarness;
let verifiedComposites: readonly string[] = [];
const scratchDirs: string[] = [];

/** A real on-disk Node project the production static-analysis gate can run. */
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
 * The durable `gate.executed` rows for one task, read back out of the REAL
 * event store — this is the only oracle `task_complete` itself consults.
 */
async function gateSignalsFor(taskId: string): Promise<readonly Rec[]> {
  const events = await harness.events(FEATURE_ID);
  return events
    .filter((e) => e.type === 'gate.executed')
    .map((e): Rec => ({ ...(e.data as Rec), __source: e.source }))
    .filter((d) => ((d.details as Rec | undefined)?.taskId ?? null) === taskId);
}

beforeAll(async () => {
  harness = await createPublicRootHarness({
    // Context seam only: a trusted local-operator identity, which is what the
    // durable gate producer requires. No handler is stubbed.
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
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe('T2 governance — gate before completion (DR-1, DR-2, DR-6)', () => {
  /**
   * NAMED ACCEPTANCE TEST.
   *
   * BLOCKING arm: a real red (degraded) static-analysis verdict is minted as
   * `gate.executed{passed:false}`, and `task_complete` REFUSES with the
   * specific `GATE_NOT_PASSED` / `unmetGates:['static-analysis']` contract.
   * NEGATIVE TWIN: the very same call for a task whose gate ran green
   * SUCCEEDS — so the refusal is attributable to the gate verdict and not to
   * "task_complete never works".
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

    // ── BLOCKING ARM ──────────────────────────────────────────────────────
    const redGate = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-red', repoRoot: redRepo },
      { timeoutMs: 180_000 },
    );
    expect(redGate.result?.success).toBe(true); // the gate RAN; its verdict is red
    expect(payload(redGate).passed).toBe(false);
    expect(payload(redGate).failCount).toBeGreaterThan(0);

    // The verdict is durable, and it is what task_complete will read.
    const redSignals = await gateSignalsFor('T-red');
    expect(redSignals).toHaveLength(1);
    expect(redSignals[0]?.gateName).toBe('static-analysis');
    expect(redSignals[0]?.passed).toBe(false);
    // Provenance: minted by the gate runner, not by the caller.
    expect(redSignals[0]?.__source).toBe('gate-runner/v1/static-analysis');

    const blocked = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-red',
      streamId: FEATURE_ID,
    });
    expect(blocked.result?.success).toBe(false);
    expect(blocked.errorCode).toBe('GATE_NOT_PASSED');
    expect(blocked.result?.error?.unmetGates).toEqual(['static-analysis']);
    expect(blocked.handlerEntered).toBe(true);

    // ...and the refusal is durable-observable: no task.completed for T-red.
    const afterBlock = await harness.events(FEATURE_ID);
    expect(
      afterBlock.filter(
        (e) => e.type === 'task.completed' && (e.data as Rec | undefined)?.taskId === 'T-red',
      ),
    ).toHaveLength(0);

    // ── NEGATIVE TWIN ─────────────────────────────────────────────────────
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
   * DR-1 / DR-2: the gate is satisfied by a DURABLE event produced by the gate
   * runner, never by evidence the caller hands to `task_complete`.
   *
   * BLOCKING arm: a fully-privileged local operator supplies its own passing
   * `evidence` for a task with NO gate row — still refused, with the same
   * typed `GATE_NOT_PASSED` contract.
   * NEGATIVE TWIN: the identical call, minus the self-supplied evidence, for a
   * task whose gate really ran green — accepted.
   */
  it('Governance_Dr1Dr2_CallerSuppliedEvidence_CannotSatisfyBlockingGate', async () => {
    // ── BLOCKING ARM: the governed tries to supply its own governance ─────
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

    // The self-attestation did not become durable evidence either.
    expect(await gateSignalsFor('T-selfattested')).toHaveLength(0);

    // ── NEGATIVE TWIN: independently produced durable evidence ────────────
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
    // Produced by the runner, carrying a reference to the persisted evidence
    // record — a caller-supplied `evidence` blob has neither property.
    expect(signals[0]?.__source).toBe('gate-runner/v1/static-analysis');
    expect(String((signals[0]?.details as Rec | undefined)?.evidenceId)).toMatch(/^evidence:/);

    const accepted = await harness.runAction('exarchos_orchestrate', 'task_complete', {
      taskId: 'T-attested',
      streamId: FEATURE_ID,
      // NOTE: no `evidence` field at all — the durable row is what counts.
    });
    expect(accepted.result?.success).toBe(true);
    expect(accepted.errorCode).toBeUndefined();

    // Cross-check that the two arms differ ONLY in the durable evidence:
    // both used the same operator identity and the same action.
    expect(selfAttested.actionId).toBe(accepted.actionId);
  }, 400_000);

  /**
   * DR-6: a SKIPPED constituent may not be rendered as PASS.
   *
   * BLOCKING arm: a fixture missing `quality-check` produces zero failures —
   * `failCount === 0` — yet the gate must NOT report success: the verdict is
   * DEGRADED/indeterminate, `gate.executed.passed === false`, and downstream
   * `task_complete` is refused.
   * NEGATIVE TWIN: add the missing script and the identical run reports PASS.
   */
  it('Governance_Dr6_SkippedConstituent_RendersDegradedNotPass', async () => {
    const partial = await makeNodeFixture({ lint: OK, typecheck: OK });

    // ── BLOCKING ARM ──────────────────────────────────────────────────────
    const degraded = await harness.runAction(
      'exarchos_orchestrate',
      'check_static_analysis',
      { featureId: FEATURE_ID, taskId: 'T-skip', repoRoot: partial },
      { timeoutMs: 180_000 },
    );
    const d = payload(degraded);
    expect(d.failCount).toBe(0); // nothing FAILED …
    expect(d.skipCount).toBe(1); // … one constituent was SKIPPED …
    expect(d.passed).toBe(false); // … and that is NOT a pass.
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

    // ── NEGATIVE TWIN: the same repo, one script added ────────────────────
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
   * DR-1: the completion runbook places no BLOCKING gate after `task_complete`
   * — a gate that runs after the thing it is supposed to gate is decorative.
   *
   * The predicate is applied to BOTH the real resolved runbook (must be clean)
   * and to a deliberately-corrupted copy (must be detected), so a predicate
   * that always returns `[]` cannot pass this test.
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

    // ── BLOCKING ARM (the invariant) ──────────────────────────────────────
    expect(blockingGatesAfterCompletion(steps)).toEqual([]);
    // The blocking gates that DO exist all precede completion.
    const gateSteps = steps.filter((s) => s.gate?.blocking === true);
    expect(gateSteps.length).toBeGreaterThan(0);

    // ── NEGATIVE TWIN (the detector really detects) ───────────────────────
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
   * The tier's own anti-stub invariant. Asserting the RETURNED LIST matters:
   * the check only inspects composites already loaded in this process, so an
   * empty list would make it vacuous.
   */
  it('Governance_GateTier_DrivesRealCompositeHandlers', async () => {
    verifiedComposites = await assertNoStubbedCompositeHandlers();
    expect(verifiedComposites).toContain('exarchos_orchestrate');
    expect(verifiedComposites).toContain('exarchos_workflow');
    expect(harness.reachedActionIds()).toContain('exarchos_orchestrate.task_complete');
    expect(harness.reachedActionIds()).toContain('exarchos_orchestrate.check_static_analysis');
  });
});
