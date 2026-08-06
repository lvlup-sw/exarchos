/**
 * T2 governance tier — the *admission → transition* chain, and what a DENIAL
 * is allowed to leave behind.
 *
 * DR-28: driven through the REAL public root (`dispatch()`) against the
 * production composition root. Phase non-mutation is asserted by READING THE
 * STATE BACK through the public root after the denial — never by trusting the
 * refusal's own return value.
 *
 * Criteria covered here (each with a BLOCKING arm and its NEGATIVE TWIN):
 *   DR-5  a bare boolean cannot satisfy an artifact guard
 *   DR-7  exactly one phase-mutation path
 *   DR-8  no force-write of guard inputs
 *   DR-9  `next_actions` derived from admission
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

/** Read the phase back through the public root — the only trusted oracle. */
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
   * NAMED ACCEPTANCE TEST (DR-28 acceptance criterion 2).
   *
   * BLOCKING arm: a transition whose guard is unsatisfied is refused with the
   * SPECIFIC `GUARD_FAILED` / named-guard contract, and the phase read back
   * through the public root afterwards is byte-identical to the phase before —
   * no `workflow.transition`, no `phase.exited`, no `phase.entered`.
   * NEGATIVE TWIN: satisfy the guard and the SAME transition moves the phase,
   * so the non-mutation above is attributable to the denial.
   */
  it('Governance_DeniedTransition_DoesNotMutatePhase', async () => {
    const featureId = 'gov-t2-denied-phase';
    await initFeature(featureId);

    const before = await phaseOf(featureId);
    expect(before).toBe('plan');
    const typesBefore = await eventTypes(featureId);

    // ── BLOCKING ARM ──────────────────────────────────────────────────────
    const denied = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(denied.result?.success).toBe(false);
    expect(denied.errorCode).toBe('GUARD_FAILED');
    expect(String(denied.result?.error?.message)).toContain("Guard 'plan-artifact-exists' failed");

    // PHASE NON-MUTATION, read back through the public root AFTER the denial.
    // Asserted FIRST, before any other property of the refusal, so a denial
    // path that mutates phase reddens on the phase itself.
    expect(await phaseOf(featureId)).toBe(before);

    // The refusal is *informative*, not merely negative.
    expect(denied.result?.error?.validTargets).toContain('plan-review');
    expect(
      ((denied.result?.error?.expectedShape as Rec | undefined)?.requiredState as Rec | undefined)
        ?.artifacts,
    ).toEqual({ plan: '<path-or-content>' });

    // …and durably: the denial produced a guard-failure record, but none of
    // the three events that constitute an actual phase mutation.
    const typesAfter = await eventTypes(featureId);
    expect(typesAfter).toContain('workflow.guard-failed');
    expect(typesAfter).not.toContain('workflow.transition');
    expect(typesAfter).not.toContain('phase.exited');
    expect(typesAfter.filter((t) => t === 'phase.entered')).toEqual(
      typesBefore.filter((t) => t === 'phase.entered'),
    );

    // ── NEGATIVE TWIN ─────────────────────────────────────────────────────
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
   * DR-5: an artifact guard demands a TYPED artifact reference. A bare boolean
   * — the classic "I set the flag, let me through" bypass — cannot satisfy it,
   * and neither can a whitespace-only string that is technically a `string`.
   *
   * BLOCKING arm has two layers, both asserted:
   *   (a) `artifacts.plan = true` is refused at the write boundary
   *       (`INVALID_INPUT`, "expected string, received boolean") so the bare
   *       boolean never even lands in state;
   *   (b) `artifacts.plan = '   '` DOES land (it is a string) and is still
   *       refused by the guard with the specific "not a bare
   *       boolean/object/whitespace" reason.
   * NEGATIVE TWIN: a real path string satisfies the same guard.
   */
  it('Governance_Dr5_BareBooleanCannotSatisfyArtifactGuard', async () => {
    const featureId = 'gov-t2-artifact-guard';
    await initFeature(featureId);

    // ── BLOCKING ARM (a): the write boundary rejects the boolean ──────────
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

    // ── BLOCKING ARM (b): a whitespace string is a string, and still fails ─
    const wsWrite = await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: '   ' } },
    });
    expect(wsWrite.result?.success).toBe(true); // the WRITE succeeded …

    const afterWs = await harness.runAction('exarchos_workflow', 'get', { featureId });
    expect((data(afterWs).artifacts as Rec | undefined)?.plan).toBe('   ');

    const deniedWs = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(deniedWs.errorCode).toBe('GUARD_FAILED'); // … the GUARD did not.
    expect(String(deniedWs.result?.error?.message)).toContain(
      'artifacts.plan must be a non-empty string',
    );
    expect(String(deniedWs.result?.error?.message)).toContain(
      'not a bare boolean/object/whitespace',
    );
    expect(await phaseOf(featureId)).toBe('plan');

    // ── NEGATIVE TWIN: a typed artifact reference ─────────────────────────
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
   * DR-7: there is exactly ONE path that mutates phase — the HSM-guarded
   * `transition` action.
   *
   * BLOCKING arm: the two plausible side doors are both closed, each with its
   * own specific refusal —
   *   (a) `update { phase }` is refused with the "phase changes go through the
   *       HSM-guarded transition action" contract;
   *   (b) hand-forging the phase-mutation events through `exarchos_event.append`
   *       is refused by event-data validation;
   * and the phase read back after both attempts is unchanged.
   * NEGATIVE TWIN: the one sanctioned path moves the phase and emits the full
   * canonical trail.
   */
  it('Governance_Dr7_PhaseMutation_OnlyThroughGuardedTransition', async () => {
    const featureId = 'gov-t2-single-mutation-path';
    await initFeature(featureId);
    const before = await phaseOf(featureId);

    // ── BLOCKING ARM (a): update cannot move phase ────────────────────────
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
    // It even redirects the caller to the single sanctioned path.
    expect((viaUpdate.result?.error?.suggestedFix as Rec | undefined)?.tool).toBe(
      'exarchos_workflow',
    );
    expect(
      ((viaUpdate.result?.error?.suggestedFix as Rec | undefined)?.params as Rec | undefined)
        ?.action,
    ).toBe('transition');
    expect(await phaseOf(featureId)).toBe(before);

    // ── BLOCKING ARM (b): the mutation events cannot be hand-forged ───────
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

    // ── NEGATIVE TWIN: the one sanctioned path ────────────────────────────
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

    // Every phase mutation leaves the SAME canonical trail — which is what
    // makes "exactly one path" auditable after the fact.
    const types = await eventTypes(featureId);
    expect(types).toContain('workflow.transition');
    expect(types).toContain('phase.exited');
    expect(types).toContain('phase.entered');
    expect(types.filter((t) => t === 'workflow.transition')).toHaveLength(1);

    // `cancel` is the other action that moves phase. It must not be a SECOND
    // write surface: it leaves the same canonical trail, and the phase it
    // produces is readable through the same public root.
    const cancelId = 'gov-t2-cancel-path';
    await initFeature(cancelId);
    const cancelled = await harness.runAction('exarchos_workflow', 'cancel', {
      featureId: cancelId,
      reason: 'T2 governance tier: single-mutation-path check',
    });
    expect(cancelled.result?.success).toBe(true);
    expect(await phaseOf(cancelId)).toBe('cancelled');
    const cancelTypes = await eventTypes(cancelId);
    // ── DR-7 criterion 1, `cancel` half: CHARACTERIZATION OF A KNOWN GAP ──
    // Driven from the public root, `cancel` DOES move phase (asserted above:
    // the read-back says `cancelled`) but emits NO phase-boundary trail at
    // all — no `workflow.transition`, no `phase.exited`, no `phase.entered`.
    // It is therefore a SECOND phase-mutation path, and DR-7 criterion 1 is
    // NOT met on the shipped code. T-37 is a test tier and does not patch
    // production; the gap is pinned here so that consolidating `cancel` onto
    // the single guarded primitive REDDENS this block and forces the
    // expectations to be flipped deliberately rather than drifting.
    expect(cancelTypes).toContain('workflow.cancel');
    expect(cancelTypes).not.toContain('workflow.transition'); // KNOWN GAP
    expect(cancelTypes).not.toContain('phase.exited'); //        KNOWN GAP
    expect(cancelTypes).not.toContain('phase.entered'); //       KNOWN GAP
  }, 120_000);

  /**
   * DR-8: guard inputs are DERIVED from state, never force-written by the
   * caller. `cleanup` takes a caller-supplied `mergeVerified: true` flag, and
   * that flag must not become the guard's answer.
   *
   * BLOCKING arm: `mergeVerified: true` with unapproved reviews is refused
   * with the specific "cleanup evidence insufficient" reason; reading the
   * state back afterwards shows the review status was NOT rewritten to
   * `approved`, the phase did not move, and no `workflow.cleanup` was emitted.
   * NEGATIVE TWIN: approve the review through its own path and the identical
   * `cleanup` call succeeds.
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

    // ── BLOCKING ARM ──────────────────────────────────────────────────────
    const denied = await harness.runAction('exarchos_workflow', 'cleanup', {
      featureId,
      mergeVerified: true, // the caller asserts the fact …
    });
    expect(denied.result?.success).toBe(false);
    expect(denied.errorCode).toBe('GUARD_FAILED');
    expect(String(denied.result?.error?.message)).toContain('cleanup evidence insufficient');
    expect(String(denied.result?.error?.message)).toContain('reviews are not approved: code');

    // … and the fact was NOT written into the guard's input.
    const after = await harness.runAction('exarchos_workflow', 'get', { featureId });
    const reviews = data(after).reviews as Rec;
    expect((reviews.code as Rec).status).toBe('needs_fixes');
    expect(await phaseOf(featureId)).toBe(before);
    expect(await eventTypes(featureId)).not.toContain('workflow.cleanup');

    // A `mergeVerified: false` caller gets a DIFFERENT, earlier refusal —
    // proving the two checks are distinct and the flag is only a precondition.
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

    // ── NEGATIVE TWIN: real evidence, same call ───────────────────────────
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
   * DR-9: `next_actions` is DERIVED from admission, not from raw HSM topology.
   *
   * BLOCKING arm: with the guard unsatisfied, admission denies the `plan-review`
   * edge and the envelope for a full state read advertises it NOT AT ALL — and
   * an actual attempt on that edge is refused, so the advertisement and the
   * enforcement agree.
   * NEGATIVE TWIN: satisfy the guard and the SAME read advertises the edge with
   * its admission-derived reason, and the attempt is admitted.
   */
  it('Governance_Dr9_NextActions_DerivedFromAdmission', async () => {
    const featureId = 'gov-t2-next-actions';
    await initFeature(featureId);
    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: '   ' } },
    });

    // ── BLOCKING ARM ──────────────────────────────────────────────────────
    const deniedRead = await harness.runAction('exarchos_workflow', 'get', { featureId });
    expect(deniedRead.result?.success).toBe(true);
    // The read really is the admission-bearing shape (full state), so the
    // empty list is a DECISION and not a missing-facts fallback.
    expect(typeof data(deniedRead).updatedAt).toBe('string');
    expect(data(deniedRead).artifacts).toBeTruthy();
    expect(Array.isArray(data(deniedRead).tasks)).toBe(true);
    expect(nextActions(deniedRead).map((a) => a.verb)).not.toContain('plan-review');

    // Second authority: the edge really is closed.
    const attempt = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(attempt.errorCode).toBe('GUARD_FAILED');

    // ── NEGATIVE TWIN ─────────────────────────────────────────────────────
    await harness.runAction('exarchos_workflow', 'update', {
      featureId,
      updates: { artifacts: { plan: 'docs/specs/next-actions.md' } },
    });
    const admittedRead = await harness.runAction('exarchos_workflow', 'get', { featureId });
    const advertised = nextActions(admittedRead);
    const planReview = advertised.find((a) => a.verb === 'plan-review');
    expect(planReview).toBeDefined();
    // Admission-derived, not topology-derived: it carries the guard's reason.
    expect(planReview?.reason).toBe('Plan artifact must exist');
    expect(planReview?.validTargets).toContain('plan-review');

    const admitted = await harness.runAction('exarchos_workflow', 'transition', {
      featureId,
      target: 'plan-review',
    });
    expect(admitted.result?.success).toBe(true);

    // The two authorities agreed in BOTH directions — that is the invariant.
    expect(await phaseOf(featureId)).toBe('plan-review');
  }, 120_000);

  /** The tier's own anti-stub invariant; the returned list is asserted. */
  it('Governance_TransitionTier_DrivesRealCompositeHandlers', async () => {
    // Drive both composites from THIS test so the check cannot be made vacuous
    // by an earlier test aborting before it loaded one of them.
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
