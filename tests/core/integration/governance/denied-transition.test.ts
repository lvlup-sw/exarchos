/**
 * Governance tier: the chain from admission to transition, and what a denial can leave behind.
 *
 * Each test drives the real `dispatch()` against the production composition root.
 * After a denial, each test reads the phase back through the public root.
 * It does not trust the return value of the refusal.
 *
 * Each criterion has a BLOCKING ARM and its NEGATIVE TWIN:
 * - A bare boolean cannot satisfy an artifact guard.
 * - Exactly one path mutates the phase.
 * - No caller force-writes a guard input.
 * - `next_actions` comes from admission.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createPublicRootHarness,
  assertNoStubbedCompositeHandlers,
  type PublicRootHarness,
  type DispatchObservation,
} from '../_harness.js';

type Rec = Record<string, unknown>;

interface NextAction {
  readonly verb?: string;
  readonly reason?: string;
  readonly validTargets?: readonly string[];
}

let harness: PublicRootHarness;

function data(obs: DispatchObservation): Rec {
  return (obs.result?.data ?? {}) as Rec;
}

function nextActions(obs: DispatchObservation): readonly NextAction[] {
  const env = obs.envelope as { next_actions?: readonly NextAction[] } | undefined;
  return env?.next_actions ?? [];
}

/** Reads the phase back through the public root, which is the only trusted oracle. */
async function phaseOf(featureId: string): Promise<unknown> {
  const got = await harness.runAction('exarchos_workflow', 'get', { featureId });
  expect(got.result?.success).toBe(true);
  return data(got).phase;
}

async function eventTypes(featureId: string): Promise<readonly string[]> {
  return (await harness.events(featureId)).map((e) => e.type);
}

async function initFeature(featureId: string): Promise<void> {
  const init = await harness.runAction('exarchos_workflow', 'init', {
    featureId,
    workflowType: 'feature',
  });
  expect(init.result?.success).toBe(true);
}

beforeAll(async () => {
  harness = await createPublicRootHarness();
}, 120_000);

afterAll(async () => {
  await harness?.dispose();
});

describe('T2 governance — denied transitions (DR-5, DR-7, DR-8, DR-9)', () => {
  /**
   * The named acceptance test for a denied transition.
   * BLOCKING ARM: a transition with an unsatisfied guard gets `GUARD_FAILED` and the name of the guard.
   * The phase read back after the denial equals the phase before it.
   * The refusal names the valid targets and the required artifact shape.
   * The denial appends `workflow.guard-failed`, but no `workflow.transition`, `phase.exited` or new `phase.entered`.
   * NEGATIVE TWIN: with the guard satisfied, the same transition moves the phase, so the denial caused the non-mutation.
   */
  it('Governance_DeniedTransition_DoesNotMutatePhase', async () => {
    const featureId = 'gov-t2-denied-phase';
    await initFeature(featureId);

    const before = await phaseOf(featureId);
    expect(before).toBe('plan');
    const typesBefore = await eventTypes(featureId);

    const denied = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(denied.result?.success).toBe(false);
    expect(denied.errorCode).toBe('GUARD_FAILED');
    expect(String(denied.result?.error?.message)).toContain("Guard 'plan-artifact-exists' failed");

    expect(await phaseOf(featureId)).toBe(before);

    expect(denied.result?.error?.validTargets).toContain('plan-review');
    expect(
      ((denied.result?.error?.expectedShape as Rec | undefined)?.requiredState as Rec | undefined)
        ?.artifacts,
    ).toEqual({ plan: '<path-or-content>' });

    const typesAfter = await eventTypes(featureId);
    expect(typesAfter).toContain('workflow.guard-failed');
    expect(typesAfter).not.toContain('workflow.transition');
    expect(typesAfter).not.toContain('phase.exited');
    expect(typesAfter.filter((t) => t === 'phase.entered')).toEqual(
      typesBefore.filter((t) => t === 'phase.entered'),
    );

    const patch = await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: 'docs/specs/gov-t2-plan.md' } },
    });
    expect(patch.result?.success).toBe(true);

    const admitted = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(admitted.errorCode).toBeUndefined();
    expect(admitted.result?.success).toBe(true);
    expect(await phaseOf(featureId)).toBe('plan-review');

    const typesTwin = await eventTypes(featureId);
    expect(typesTwin).toContain('workflow.transition');
    expect(typesTwin).toContain('phase.exited');
    expect(typesTwin).toContain('phase.entered');
  }, 120_000);

  /**
   * An artifact guard requires a typed artifact reference.
   * BLOCKING ARM (a): the write boundary refuses `artifacts.plan = true` with `INVALID_INPUT`, so the boolean never reaches the state.
   * BLOCKING ARM (b): the write of a whitespace-only string succeeds, because it is a string, but the guard still refuses the transition.
   * NEGATIVE TWIN: a real path string satisfies the same guard.
   */
  it('Governance_Dr5_BareBooleanCannotSatisfyArtifactGuard', async () => {
    const featureId = 'gov-t2-artifact-guard';
    await initFeature(featureId);

    const boolWrite = await harness.probe('exarchos_workflow', {
      action: 'update',
      featureId,
      updates: { artifacts: { plan: true } },
    });
    expect(boolWrite.result?.success).toBe(false);
    expect(boolWrite.errorCode).toBe('INVALID_INPUT');
    expect(String(boolWrite.result?.error?.message)).toContain('Write-time validation failed');
    expect(String(boolWrite.result?.error?.message)).toContain(
      'expected string, received boolean',
    );

    const afterBool = await harness.runAction('exarchos_workflow', 'get', { featureId });
    expect((data(afterBool).artifacts as Rec | undefined)?.plan ?? null).toBeNull();

    const wsWrite = await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: '   ' } },
    });
    expect(wsWrite.result?.success).toBe(true);

    const afterWs = await harness.runAction('exarchos_workflow', 'get', { featureId });
    expect((data(afterWs).artifacts as Rec | undefined)?.plan).toBe('   ');

    const deniedWs = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(deniedWs.errorCode).toBe('GUARD_FAILED');
    expect(String(deniedWs.result?.error?.message)).toContain(
      'artifacts.plan must be a non-empty string',
    );
    expect(String(deniedWs.result?.error?.message)).toContain(
      'not a bare boolean/object/whitespace',
    );
    expect(await phaseOf(featureId)).toBe('plan');

    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: 'docs/specs/real-plan.md' } },
    });
    const admitted = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(admitted.result?.success).toBe(true);
    expect(await phaseOf(featureId)).toBe('plan-review');
  }, 120_000);

  /**
   * The criterion: only the HSM-guarded `transition` action mutates the phase.
   * BLOCKING ARM (a): the `update` action refuses a `phase` key, and the refusal suggests the `transition` action.
   * BLOCKING ARM (b): event-data validation refuses a hand-made `workflow.transition` or `phase.entered` event with an incomplete payload.
   * The phase read back after both attempts does not change.
   * NEGATIVE TWIN: the `transition` action moves the phase and appends the full trail, with exactly one `workflow.transition`.
   *
   * KNOWN GAP: `cancel` also moves the phase, but it appends `workflow.cancel` and no phase-boundary event.
   * Thus `cancel` is a second path that mutates the phase, and the shipped code does not meet the criterion.
   * The assertions pin the gap, so a fix must change them deliberately.
   */
  it('Governance_Dr7_PhaseMutation_OnlyThroughGuardedTransition', async () => {
    const featureId = 'gov-t2-single-mutation-path';
    await initFeature(featureId);
    const before = await phaseOf(featureId);

    const viaUpdate = await harness.probe('exarchos_workflow', {
      action: 'update',
      featureId,
      updates: { phase: 'delegate' },
    });
    expect(viaUpdate.result?.success).toBe(false);
    expect(viaUpdate.errorCode).toBe('INVALID_INPUT');
    expect(String(viaUpdate.result?.error?.message)).toContain(
      "Cannot mutate 'phase' through update",
    );
    expect(String(viaUpdate.result?.error?.message)).toContain('HSM-guarded transition action');
    expect((viaUpdate.result?.error?.suggestedFix as Rec | undefined)?.tool).toBe(
      'exarchos_workflow',
    );
    expect(
      ((viaUpdate.result?.error?.suggestedFix as Rec | undefined)?.params as Rec | undefined)
        ?.action,
    ).toBe('transition');
    expect(await phaseOf(featureId)).toBe(before);

    for (const type of ['workflow.transition', 'phase.entered']) {
      const forged = await harness.probe('exarchos_event', {
        action: 'append',
        stream: featureId,
        event: { type, data: { phase: 'completed', to: 'completed' } },
      });
      expect(forged.result?.success).toBe(false);
      expect(forged.errorCode).toBe('VALIDATION_ERROR');
      expect(String(forged.result?.error?.message)).toContain(
        `Event data validation failed for type '${type}'`,
      );
    }
    expect(await phaseOf(featureId)).toBe(before);
    expect(await eventTypes(featureId)).not.toContain('workflow.transition');

    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: 'docs/specs/single-path.md' } },
    });
    const viaTransition = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(viaTransition.result?.success).toBe(true);
    expect(await phaseOf(featureId)).toBe('plan-review');

    const types = await eventTypes(featureId);
    expect(types).toContain('workflow.transition');
    expect(types).toContain('phase.exited');
    expect(types).toContain('phase.entered');
    expect(types.filter((t) => t === 'workflow.transition')).toHaveLength(1);

    const cancelId = 'gov-t2-cancel-path';
    await initFeature(cancelId);
    const cancelled = await harness.runAction('exarchos_workflow', 'cancel', {
      featureId: cancelId,
      reason: 'T2 governance tier: single-mutation-path check',
    });
    expect(cancelled.result?.success).toBe(true);
    expect(await phaseOf(cancelId)).toBe('cancelled');
    const cancelTypes = await eventTypes(cancelId);
    expect(cancelTypes).toContain('workflow.cancel');
    expect(cancelTypes).not.toContain('workflow.transition');
    expect(cancelTypes).not.toContain('phase.exited');
    expect(cancelTypes).not.toContain('phase.entered');
  }, 120_000);

  /**
   * The guard derives its inputs from the state. The `mergeVerified: true` flag of the caller is only a precondition.
   * BLOCKING ARM: with a review that is not approved, `cleanup` with `mergeVerified: true` gets "cleanup evidence insufficient".
   * After the refusal, the review status is still `needs_fixes`, the phase is the same, and no `workflow.cleanup` event exists.
   * A caller with `mergeVerified: false` gets a different, earlier refusal, so the two checks are distinct.
   * NEGATIVE TWIN: after an update approves the review, the identical `cleanup` call succeeds.
   */
  it('Governance_Dr8_CallerFlag_DoesNotForceWriteGuardInputs', async () => {
    const featureId = 'gov-t2-no-force-write';
    await initFeature(featureId);
    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: {
        reviews: { code: { status: 'needs_fixes' } },
        synthesis: { prUrl: 'https://example.invalid/pr/1' },
      },
    });
    const before = await phaseOf(featureId);

    const denied = await harness.runAction('exarchos_workflow', 'cleanup', {
      featureId,
      mergeVerified: true,
    });
    expect(denied.result?.success).toBe(false);
    expect(denied.errorCode).toBe('GUARD_FAILED');
    expect(String(denied.result?.error?.message)).toContain('cleanup evidence insufficient');
    expect(String(denied.result?.error?.message)).toContain('reviews are not approved: code');

    const after = await harness.runAction('exarchos_workflow', 'get', { featureId });
    const reviews = data(after).reviews as Rec;
    expect((reviews.code as Rec).status).toBe('needs_fixes');
    expect(await phaseOf(featureId)).toBe(before);
    expect(await eventTypes(featureId)).not.toContain('workflow.cleanup');

    const featureId2 = 'gov-t2-no-force-write-b';
    await initFeature(featureId2);
    const preconditionRefusal = await harness.probe('exarchos_workflow', {
      action: 'cleanup',
      featureId: featureId2,
      mergeVerified: false,
    });
    expect(preconditionRefusal.errorCode).toBe('GUARD_FAILED');
    expect(String(preconditionRefusal.result?.error?.message)).toContain(
      'Cleanup requires mergeVerified: true',
    );

    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { reviews: { code: { status: 'approved' } } },
    });
    const allowed = await harness.runAction('exarchos_workflow', 'cleanup', {
      featureId,
      mergeVerified: true,
    });
    expect(allowed.errorCode).toBeUndefined();
    expect(allowed.result?.success).toBe(true);
    expect(await phaseOf(featureId)).toBe('completed');
    expect(await eventTypes(featureId)).toContain('workflow.cleanup');
  }, 120_000);

  /**
   * `next_actions` comes from admission, not from the raw HSM topology.
   * BLOCKING ARM: with the guard unsatisfied, a full state read does not advertise the `plan-review` edge.
   * The read returns the full state, so the absence is a decision and not a fallback for missing facts.
   * A transition attempt on that edge gets `GUARD_FAILED`, so the advertisement and the enforcement agree.
   * NEGATIVE TWIN: with the guard satisfied, the same read advertises the edge with the reason of the guard, and the attempt succeeds.
   */
  it('Governance_Dr9_NextActions_DerivedFromAdmission', async () => {
    const featureId = 'gov-t2-next-actions';
    await initFeature(featureId);
    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: '   ' } },
    });

    const deniedRead = await harness.runAction('exarchos_workflow', 'get', { featureId });
    expect(deniedRead.result?.success).toBe(true);
    expect(typeof data(deniedRead).updatedAt).toBe('string');
    expect(data(deniedRead).artifacts).toBeTruthy();
    expect(Array.isArray(data(deniedRead).tasks)).toBe(true);
    expect(nextActions(deniedRead).map((a) => a.verb)).not.toContain('plan-review');

    const attempt = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(attempt.errorCode).toBe('GUARD_FAILED');

    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: 'docs/specs/next-actions.md' } },
    });
    const admittedRead = await harness.runAction('exarchos_workflow', 'get', { featureId });
    const advertised = nextActions(admittedRead);
    const planReview = advertised.find((a) => a.verb === 'plan-review');
    expect(planReview).toBeDefined();
    expect(planReview?.reason).toBe('Plan artifact must exist');
    expect(planReview?.validTargets).toContain('plan-review');

    const admitted = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(admitted.result?.success).toBe(true);

    expect(await phaseOf(featureId)).toBe('plan-review');
  }, 120_000);

  /**
   * The anti-stub invariant of this tier. The test asserts the returned list.
   * It drives both composites itself, so an earlier test that aborts cannot make the check vacuous.
   */
  it('Governance_TransitionTier_DrivesRealCompositeHandlers', async () => {
    await harness.runAction('exarchos_workflow', 'get', { featureId: 'gov-t2-denied-phase' });
    await harness.probe('exarchos_event', {
      action: 'append',
      stream: 'gov-t2-anti-stub',
      event: { type: 'workflow.transition', data: {} },
    });

    const verified = await assertNoStubbedCompositeHandlers();
    expect(verified).toContain('exarchos_workflow');
    expect(verified).toContain('exarchos_event');
    expect(harness.reachedActionIds()).toContain('exarchos_workflow.transition');
    expect(harness.reachedActionIds()).toContain('exarchos_workflow.cleanup');
  });
});
