import { describe, it, expect } from 'vitest';
import { guards } from './guards.js';
import type { GuardFailure } from './guards.js';

// ─── teamDisbandedEmitted Guard Tests ───────────────────────────────────────

describe('teamDisbandedEmitted', () => {
  it('teamDisbandedEmitted_EventExists_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [
        { type: 'team.spawned' },
        { type: 'team.disbanded', data: { totalDurationMs: 5000, tasksCompleted: 3, tasksFailed: 0 } },
      ],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).toBe(true);
  });

  it('teamDisbandedEmitted_NoEvent_ReturnsGuardFailure', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [
        { type: 'team.spawned' },
        { type: 'team.task.completed' },
      ],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('team-disbanded-emitted');
  });

  it('teamDisbandedEmitted_GuardFailure_IncludesExpectedShapeAndSuggestedFix', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [
        { type: 'team.spawned' },
      ],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);

    // expectedShape should describe the team.disbanded event structure
    expect(failure.expectedShape).toBeDefined();
    expect(failure.expectedShape!.type).toBe('team.disbanded');
    const data = failure.expectedShape!.data as Record<string, string>;
    expect(data.totalDurationMs).toBe('number');
    expect(data.tasksCompleted).toBe('number');
    expect(data.tasksFailed).toBe('number');

    // suggestedFix should point to the exarchos_event tool
    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_event');
    expect(failure.suggestedFix!.params.action).toBe('append');
  });

  // ─── #786: Subagent-mode tests (no team spawned) ────────────────────────

  it('teamDisbandedEmitted_NoTeamSpawned_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [
        { type: 'workflow.started' },
        { type: 'workflow.transition' },
      ],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).toBe(true);
  });

  it('teamDisbandedEmitted_EmptyEvents_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).toBe(true);
  });

  it('teamDisbandedEmitted_UndefinedEvents_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).toBe(true);
  });

  it('teamDisbandedEmitted_TeamSpawnedButNotDisbanded_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      _events: [
        { type: 'team.spawned' },
        { type: 'team.task.completed' },
      ],
    };

    const result = guards.teamDisbandedEmitted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('team-disbanded-emitted');
  });
});

// ─── Task 3: escalationRequired Guard Tests ─────────────────────────────────

describe('escalationRequired', () => {
  it('escalationRequired_EscalateTrue_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      investigation: { escalate: true, rootCause: 'architectural issue' },
    };

    const result = guards.escalationRequired.evaluate(state);

    expect(result).toBe(true);
  });

  it('escalationRequired_EscalateMissing_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      investigation: { rootCause: 'simple bug' },
    };

    const result = guards.escalationRequired.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('escalation-required');
    expect(failure.expectedShape).toEqual({ investigation: { escalate: true } });
  });

  it('escalationRequired_NoInvestigation_ReturnsFailure', () => {
    const state: Record<string, unknown> = {};

    const result = guards.escalationRequired.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('escalation-required');
  });

  it('escalationRequired_EscalateFalse_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      investigation: { escalate: false },
    };

    const result = guards.escalationRequired.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });
});

// ─── Task 4: revisionsExhausted Guard Tests ─────────────────────────────────

describe('revisionsExhausted', () => {
  // DR-1: the cap is `state._maxPlanRevisions` (injected from
  // `.exarchos.yml workflow.maxPlanRevisions` in tools.ts) and falls back to
  // DEFAULT_MAX_PLAN_REVISIONS (1) when not injected. `revisionCount` is the
  // event-sourced fact; the cap is injected policy, never event-sourced (INV-1).

  // ── Default cap (no `_maxPlanRevisions` injected) = 1 ──
  it('revisionsExhausted_DefaultCap_CountAtOne_ReturnsTrue', () => {
    // Flagged behavior change: default cap is now 1 (was 3), so one revision
    // reaches the cap.
    const state: Record<string, unknown> = { planReview: { revisionCount: 1 } };
    expect(guards.revisionsExhausted.evaluate(state)).toBe(true);
  });

  it('revisionsExhausted_DefaultCap_CountAboveDefault_ReturnsTrue', () => {
    const state: Record<string, unknown> = { planReview: { revisionCount: 5 } };
    expect(guards.revisionsExhausted.evaluate(state)).toBe(true);
  });

  it('revisionsExhausted_DefaultCap_ZeroRevisions_ReturnsFailure', () => {
    const state: Record<string, unknown> = { planReview: { revisionCount: 0 } };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('revisions-exhausted');
    expect(failure.reason).toContain('0/1');
  });

  it('revisionsExhausted_NoRevisionCount_ReturnsFailure', () => {
    const state: Record<string, unknown> = {};

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('0/1');
  });

  // ── Injected cap (`_maxPlanRevisions`) honored — `.exarchos.yml` override ──
  it('revisionsExhausted_InjectedCap_CountBelowCap_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: 3,
    };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('1/3');
  });

  it('revisionsExhausted_InjectedCap_CountAtCap_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 3 },
      _maxPlanRevisions: 3,
    };
    expect(guards.revisionsExhausted.evaluate(state)).toBe(true);
  });

  it('revisionsExhausted_InjectedCap_BoundaryAtTwo', () => {
    // Cap 2: one revision is allowed, the second reaches the cap.
    const below: Record<string, unknown> = {
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: 2,
    };
    expect(guards.revisionsExhausted.evaluate(below)).not.toBe(true);

    const at: Record<string, unknown> = {
      planReview: { revisionCount: 2 },
      _maxPlanRevisions: 2,
    };
    expect(guards.revisionsExhausted.evaluate(at)).toBe(true);
  });

  it('revisionsExhausted_NonFiniteInjectedCap_FallsBackToDefault', () => {
    // A malformed injected cap must not disable the bound — fall back to 1.
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: Number.NaN,
    };
    expect(guards.revisionsExhausted.evaluate(state)).toBe(true);
  });
});

// ─── Task 8: prRequested Guard Tests ────────────────────────────────────────

describe('prRequested', () => {
  it('prRequested_SynthesisRequestedTrue_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      synthesis: { requested: true },
    };

    const result = guards.prRequested.evaluate(state);

    expect(result).toBe(true);
  });

  it('prRequested_SynthesisMissing_ReturnsFailure', () => {
    const state: Record<string, unknown> = {};

    const result = guards.prRequested.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('pr-requested');
    expect(failure.expectedShape).toEqual({ synthesis: { requested: true } });
  });

  it('prRequested_SynthesisRequestedFalse_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      synthesis: { requested: false },
    };

    const result = guards.prRequested.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });

  it('prRequested_SynthesisNoRequestedField_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      synthesis: { prUrl: 'https://example.com' },
    };

    const result = guards.prRequested.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });
});

// ─── synthesizeRetryable Guard Tests ─────────────────────────────────────────

describe('synthesizeRetryable', () => {
  it('synthesizeRetryable_HasErrorAndRetriesRemaining_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: 'network error',
        retryCount: 1,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).toBe(true);
  });

  it('synthesizeRetryable_EmptyStringError_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: '',
        retryCount: 0,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).toBe(true);
  });

  it('synthesizeRetryable_NoError_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        retryCount: 0,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('synthesize-retryable');
    expect(failure.reason).toContain('no lastError');
  });

  it('synthesizeRetryable_RetriesExhausted_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: 'gh pr create failed',
        retryCount: 3,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('synthesize-retryable');
    expect(failure.reason).toContain('retries exhausted');
  });

  it('synthesizeRetryable_NoSynthesisState_ReturnsFailure', () => {
    const state: Record<string, unknown> = {};

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('no lastError');
  });

  it('synthesizeRetryable_RetryCountAtMax_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: 'stack conflict',
        retryCount: 5,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });

  it('synthesizeRetryable_ZeroRetryCount_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: 'first failure',
        retryCount: 0,
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).toBe(true);
  });

  it('synthesizeRetryable_MissingRetryCount_DefaultsToZero_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      synthesis: {
        lastError: 'network timeout',
      },
    };

    const result = guards.synthesizeRetryable.evaluate(state);

    expect(result).toBe(true);
  });
});

// ─── T-16: Guards branch gap coverage ────────────────────────────────────────

describe('planReviewComplete', () => {
  it('PlanReviewApproved_MissingPlanReviewField_ReturnsFailed', () => {
    // State without planReview field at all
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
    };

    const result = guards.planReviewComplete.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('plan-review-complete');
    expect(failure.reason).toContain('planReview.approved must be true');
    expect(failure.expectedShape).toEqual({ planReview: { approved: true } });
    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_workflow');
  });
});

describe('allTasksComplete', () => {
  it('AllTasksCompleted_MixedTaskStatuses_ReturnsFailed', () => {
    // State with tasks array containing completed + in-progress tasks
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      tasks: [
        { id: 't1', status: 'complete' },
        { id: 't2', status: 'in_progress' },
        { id: 't3', status: 'pending' },
      ],
    };

    const result = guards.allTasksComplete.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('all-tasks-complete');
    // Should list the count of incomplete tasks
    expect(failure.reason).toContain('2 task(s) incomplete');
    // Should include suggested fix
    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_workflow');
  });
});


describe('allReviewsPassed (synthesis ready)', () => {
  it('SynthesisReadyGuard_MissingReviewVerdicts_ReturnsFailed', () => {
    // State at review phase without review verdicts
    // The allReviewsPassed guard checks that all reviews have passed status
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      // reviews exists but has no entries with recognizable status fields
      reviews: {},
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    // Should indicate no recognizable review entries
    expect(failure.reason).toContain('no recognizable review entries');
    expect(failure.expectedShape).toBeDefined();
  });

  it('SynthesisReadyGuard_MissingReviewsField_ReturnsFailed', () => {
    // State without reviews field at all
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('state.reviews is missing');
  });

  it('SynthesisReadyGuard_MissingRequiredDimensions_ReturnsFailed', () => {
    // Agent sets only one review but two are required
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'pass' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('Missing required review dimensions');
    expect(failure.reason).toContain('quality-review');
    expect(failure.expectedShape).toBeDefined();
    expect(failure.suggestedFix).toBeDefined();
  });

  it('SynthesisReadyGuard_AllRequiredDimensionsPresent_Passes', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'pass' },
        'quality-review': { status: 'approved' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).toBe(true);
  });

  it('SynthesisReadyGuard_MutationAdequacySkipPassPresent_Passes_DR2a', () => {
    // DR-2a dead-lock fix: at HIGH tier mutation-adequacy is a required dimension.
    // The projection folds the mutation gate.executed (incl. a no-toolchain
    // skip-pass) into reviews['mutation-adequacy'] with status 'pass', so the
    // presence requirement is satisfied by the recorded run — review→synthesize
    // is no longer dead-locked.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        review: { status: 'pass' },
        'mutation-adequacy': { status: 'pass', skipped: true, mutationScore: 0 },
      },
      _requiredReviews: ['review', 'mutation-adequacy'],
    };

    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('SynthesisReadyGuard_MutationAdequacyRequiredButNeverRun_Blocks_DR2a', () => {
    // The complement: a toolchain-present repo where the mutation gate never ran
    // leaves the dimension absent → the guard still blocks (a required gate that
    // did not execute must not silently pass).
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: { review: { status: 'pass' } },
      _requiredReviews: ['review', 'mutation-adequacy'],
    };

    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('mutation-adequacy');
  });

  // ── DR-3: mutation score enforcement (Check 4, injected values only) ──
  const mutationBase = (
    score: number,
    inject: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    featureId: 'test-feature',
    phase: 'review',
    reviews: {
      review: { status: 'pass' },
      'mutation-adequacy': { status: 'pass', mutationScore: score, ...extra },
    },
    _requiredReviews: ['review', 'mutation-adequacy'],
    ...inject,
  });

  it('MutationEnforcement_BlockModeSubThreshold_Blocks_DR3', () => {
    const state = mutationBase(0.1, { _mutationEnforcement: 'block', _mutationThreshold: 0.4 });
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('below the enforced threshold');
  });

  it('MutationEnforcement_BlockModeAtOrAboveThreshold_Passes_DR3', () => {
    expect(
      guards.allReviewsPassed.evaluate(
        mutationBase(0.4, { _mutationEnforcement: 'block', _mutationThreshold: 0.4 }),
      ),
    ).toBe(true);
    expect(
      guards.allReviewsPassed.evaluate(
        mutationBase(0.9, { _mutationEnforcement: 'block', _mutationThreshold: 0.4 }),
      ),
    ).toBe(true);
  });

  it('MutationEnforcement_AdvisoryDefault_SubThresholdNeverBlocks_DR3', () => {
    // No injected mode (advisory default) → a sub-threshold score does not block.
    expect(guards.allReviewsPassed.evaluate(mutationBase(0.01, {}))).toBe(true);
    expect(
      guards.allReviewsPassed.evaluate(
        mutationBase(0.01, { _mutationEnforcement: 'advisory', _mutationThreshold: 0.4 }),
      ),
    ).toBe(true);
  });

  it('MutationEnforcement_SkipPassRun_NeverEnforced_DR3', () => {
    // A no-toolchain skip-pass carries no real score → not enforced even in block mode.
    const state = mutationBase(0, { _mutationEnforcement: 'block', _mutationThreshold: 0.4 }, { skipped: true });
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('MutationEnforcement_BlockModeButNoThresholdInjected_NotEnforced_DR3', () => {
    // Guard reads injected values only: mode without a finite threshold is inert.
    const state = mutationBase(0.01, { _mutationEnforcement: 'block' });
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('MutationEnforcement_BlockModeDegradedRun_Blocks_RVC_R1', () => {
    // RVC-R1: a DEGRADED run (toolchain present but the runner crashed or emitted
    // an unparseable report) carries skipped:true AND degraded:true. It produced
    // no verifiable score, so under block enforcement it must fail CLOSED —
    // distinct from the no-toolchain skip-pass (below), which stays advisory. The
    // shared skipped:true marker alone must NOT be read as "score verified".
    const state = mutationBase(
      0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4 },
      { skipped: true, degraded: true },
    );
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('degraded');
  });

  it('MutationEnforcement_BlockModeNonFiniteScore_Blocks_RVC_R6', () => {
    // RVC-R6 (CodeRabbit): a present-but-non-finite score (NaN from a 0/0 mutation
    // ratio when every mutant was uncovered) is unverifiable. `NaN < threshold` is
    // always false, which would silently pass under block — fail it closed.
    const state = mutationBase(Number.NaN, {
      _mutationEnforcement: 'block',
      _mutationThreshold: 0.4,
    });
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('non-finite');
  });

  it('MutationEnforcement_DegradedRun_AdvisoryDefault_NeverBlocks_RVC_R1', () => {
    // The fail-closed behavior is scoped to block enforcement. Under advisory
    // (the default, and explicit) a degraded run still satisfies the presence
    // requirement and does not block — no secondary dead-lock.
    expect(
      guards.allReviewsPassed.evaluate(mutationBase(0, {}, { skipped: true, degraded: true })),
    ).toBe(true);
    expect(
      guards.allReviewsPassed.evaluate(
        mutationBase(
          0,
          { _mutationEnforcement: 'advisory', _mutationThreshold: 0.4 },
          { skipped: true, degraded: true },
        ),
      ),
    ).toBe(true);
  });

  // ── DR-6: mutation NoCoverage enforcement (Check 4b — orthogonal axis) ──
  // Reads the pre-resolved `_maxNoCoverage` injection and the folded dimension's
  // `noCoverage` count. Blocks under block mode when noCoverage exceeds the
  // budget — independently of the score axis (Check 4a). `mutationScore` stays
  // untouched (INV-5b).

  it('GuardCheckFour_NoCoverageExceedsBudget_BlocksUnderEnforcement', () => {
    // Score PASSES (1.0 >= 0.4) yet 2 uncovered mutants exceed the budget of 0 —
    // the orthogonal axis blocks the transition anyway (the exact 5-killed +
    // NoCoverage-at-1.0 hole DR-6 closes).
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: 0 },
      { noCoverage: 2 },
    );
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    const reason = (result as GuardFailure).reason;
    expect(reason).toContain('NoCoverage');
    expect(reason).toContain('budget');
  });

  it('GuardCheckFour_AllCovered_PassesUnchanged', () => {
    // Same passing score, zero NoCoverage → the transition passes (both axes ok).
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: 0 },
      { noCoverage: 0 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('GuardCheckFour_NoCoverageAxisIsOrthogonalToScore', () => {
    // With NO threshold injected the score axis (4a) is inert, so a block here can
    // ONLY come from the NoCoverage axis (4b) — proving orthogonality.
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _maxNoCoverage: 0 },
      { noCoverage: 3 },
    );
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('NoCoverage');
  });

  it('GuardCheckFour_NoCoverageWithinExplicitBudget_Passes', () => {
    // Budget of 5 with 3 uncovered mutants → within budget → passes.
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: 5 },
      { noCoverage: 3 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('GuardCheckFour_AdvisoryMode_NoCoverageNeverBlocks', () => {
    // NoCoverage enforcement is scoped to block mode. Under advisory a diff with
    // uncovered mutants still passes review→synthesize (no secondary dead-lock).
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'advisory', _maxNoCoverage: 0 },
      { noCoverage: 9 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('GuardCheckFour_NoBudgetInjected_NoCoverageNotEnforced', () => {
    // The guard reads injected values only: block mode without a `_maxNoCoverage`
    // injection leaves the NoCoverage axis inert (mirrors the threshold contract).
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block' },
      { noCoverage: 4 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('GuardCheckFour_SkipPassWithNoCoverage_NotEnforced', () => {
    // A skip-pass run carries no verifiable NoCoverage count — the axis reads only
    // a real run, so a skipped dimension is never blocked by 4b.
    const state = mutationBase(
      0,
      { _mutationEnforcement: 'block', _maxNoCoverage: 0 },
      { skipped: true, noCoverage: 4 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  it('SynthesisReadyGuard_RequiredDimensionPresentButFailed_ReturnsFailed', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'pass' },
        'quality-review': { status: 'fail' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('Reviews not passed');
    expect(failure.reason).toContain('quality-review');
  });

  it('SynthesisReadyGuard_NoRequiredReviewsConfigured_FallsBackToExistingBehavior', () => {
    // Without _requiredReviews, any passing reviews should satisfy the guard
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'arbitrary-review': { status: 'pass' },
      },
    };

    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).toBe(true);
  });

  // ─── Regression: #1075 case-insensitive verdict handling ───────────────
  // Reviewer agents copy check_review_verdict's uppercase return values
  // ('APPROVED' | 'NEEDS_FIXES' | 'BLOCKED') directly into state. The guard
  // must normalize case before set-membership check so uppercase verdicts
  // don't silently fail.
  it('SynthesisReadyGuard_UppercaseVerdictPass_Accepts', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { verdict: 'PASS', reviewer: 'exarchos-reviewer' },
        'quality-review': { verdict: 'APPROVED', reviewer: 'exarchos-reviewer' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).toBe(true);
  });

  it('SynthesisReadyGuard_UppercaseStatusApproved_Accepts', () => {
    // Even when the field is `status` (not `verdict`), uppercase must be accepted.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'APPROVED' },
        'quality-review': { status: 'Pass' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).toBe(true);
  });

  // ─── Regression: #1074 aggregated failure reporting ────────────────────
  // When multiple contract violations exist, the guard must report all of
  // them in a single error message so agents can fix everything in one
  // retry instead of peeling failures one layer at a time.
  it('SynthesisReadyGuard_MissingDimensionsAndFailedStatus_AggregatesIntoSingleError', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        // Stray entry from earlier round — legitimately failing
        'stray-review': { status: 'fail' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    // Both failure modes must appear in the same reason string
    expect(failure.reason).toContain('Missing required review dimensions');
    expect(failure.reason).toContain('spec-review');
    expect(failure.reason).toContain('quality-review');
    expect(failure.reason).toContain('Reviews not passed');
    expect(failure.reason).toContain('stray-review');
  });

  // ─── Regression: empty review object must be treated as missing.
  // Before the hardening, `!reviews[key]` treated `{}` as present (truthy),
  // silently satisfying the missing-dimensions check. The guard then
  // skipped the empty entry in collectReviewStatuses and returned true.
  // CodeRabbit finding on PR #1076.
  it('SynthesisReadyGuard_RequiredDimensionPresentButEmptyObject_TreatedAsMissing', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': {}, // present key but no status / verdict / passed
        'quality-review': { status: 'pass' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.reason).toContain('Missing required review dimensions');
    expect(failure.reason).toContain('spec-review');
  });

  // ─── Regression: prototype-pollution keys must not satisfy the check.
  // If a caller passes `_requiredReviews: ['__proto__']` and no actual
  // reviews are set, the `__proto__` key is inherited on every object
  // and would previously have tricked `reviews[key]` into returning a
  // truthy value. Guard must skip UNSAFE_KEYS and treat them as missing.
  it('SynthesisReadyGuard_RequiredDimensionIsProtoPollution_TreatedAsMissing', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'pass' },
      },
      _requiredReviews: ['spec-review', '__proto__'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.reason).toContain('Missing required review dimensions');
    // __proto__ is an unsafe key — guard must treat it as missing
    expect(failure.reason).toContain('__proto__');

    // ALSO: the emitted expectedShape and suggestedFix must NOT contain
    // `__proto__` (or any UNSAFE_KEY) as an own property. Even though
    // the reason reports the missing dim, an agent blindly applying
    // suggestedFix.params.updates must not be tricked into assigning
    // `reviews.__proto__.status = 'pass'` — that's prototype pollution.
    const reviewsShape = (failure.expectedShape?.reviews ?? {}) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(reviewsShape, '__proto__')).toBe(false);

    const updates = (failure.suggestedFix?.params.updates ?? {}) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(updates, 'reviews.__proto__.status')).toBe(false);
    for (const key of Object.keys(updates)) {
      expect(key).not.toContain('__proto__');
      expect(key).not.toContain('constructor');
      expect(key).not.toContain('prototype');
    }
  });

  // ─── Regression: suggestedFix must cover BOTH missing and failing reviews.
  // An agent applying the fix should be able to resolve the guard in ONE
  // retry for mixed states (some missing, some present-but-failing).
  // CodeRabbit finding on PR #1076.
  it('SynthesisReadyGuard_MixedFailures_SuggestedFixCoversMissingAndFailing', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        // One required dim present but failing
        'spec-review': { status: 'fail' },
        // One stray that's also failing (not required, but guard sees it)
        'stray-review': { status: 'needs_fixes' },
        // quality-review is missing
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.suggestedFix).toBeDefined();
    const updates = failure.suggestedFix!.params.updates as Record<string, unknown>;
    // Missing dimension patch
    expect(updates['reviews.quality-review.status']).toBe('pass');
    // Failing dimension patches (both required and stray)
    expect(updates['reviews.spec-review.status']).toBe('pass');
    expect(updates['reviews.stray-review.status']).toBe('pass');
  });
});

// ─── synthesisOptedIn / synthesisOptedOut Guard Tests ───────────────────────

describe('synthesisOptedIn', () => {
  it('synthesisOptedIn_policyAlways_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'always' },
      _events: [],
    };

    const result = guards.synthesisOptedIn.evaluate(state);

    expect(result).toBe(true);
  });

  it('synthesisOptedIn_policyNever_returnsFalseWithReason', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'never' },
      _events: [{ type: 'synthesize.requested' }],
    };

    const result = guards.synthesisOptedIn.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('never');
  });

  it('synthesisOptedIn_policyOnRequestWithEvent_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [
        { type: 'phase.changed' },
        { type: 'synthesize.requested', data: { reason: 'reviewer asked for PR' } },
      ],
    };

    const result = guards.synthesisOptedIn.evaluate(state);

    expect(result).toBe(true);
  });

  it('synthesisOptedIn_policyOnRequestNoEvent_returnsFalseWithReason', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'phase.changed' }],
    };

    const result = guards.synthesisOptedIn.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('synthesize.requested');
  });

  it('synthesisOptedIn_policyDefaultsToOnRequest_whenFieldMissing', () => {
    // No `oneshot` field at all — must default to 'on-request' semantics
    const stateWithoutEvent: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      _events: [],
    };

    const resultNoEvent = guards.synthesisOptedIn.evaluate(stateWithoutEvent);
    expect(resultNoEvent).not.toBe(true);
    expect((resultNoEvent as GuardFailure).passed).toBe(false);

    const stateWithEvent: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      _events: [{ type: 'synthesize.requested' }],
    };

    const resultWithEvent = guards.synthesisOptedIn.evaluate(stateWithEvent);
    expect(resultWithEvent).toBe(true);
  });
});

describe('synthesisOptedOut', () => {
  it('synthesisOptedOut_isInverseOfSynthesisOptedIn', () => {
    // Table-driven: 8 combinations of (policy ∈ {always, never, on-request}) ×
    // (event present ∈ {true, false}), plus the default (no oneshot field) case.
    // For every row, exactly one of the two guards must return true.
    type Row = {
      label: string;
      oneshot: Record<string, unknown> | undefined;
      eventPresent: boolean;
    };

    const rows: Row[] = [
      { label: 'always + event',          oneshot: { synthesisPolicy: 'always' },     eventPresent: true  },
      { label: 'always + no event',       oneshot: { synthesisPolicy: 'always' },     eventPresent: false },
      { label: 'never + event',           oneshot: { synthesisPolicy: 'never' },      eventPresent: true  },
      { label: 'never + no event',        oneshot: { synthesisPolicy: 'never' },      eventPresent: false },
      { label: 'on-request + event',      oneshot: { synthesisPolicy: 'on-request' }, eventPresent: true  },
      { label: 'on-request + no event',   oneshot: { synthesisPolicy: 'on-request' }, eventPresent: false },
      { label: 'default (no oneshot) + event',    oneshot: undefined, eventPresent: true  },
      { label: 'default (no oneshot) + no event', oneshot: undefined, eventPresent: false },
    ];

    for (const row of rows) {
      const state: Record<string, unknown> = {
        featureId: 'test-feature',
        workflowType: 'oneshot',
        _events: row.eventPresent ? [{ type: 'synthesize.requested' }] : [],
      };
      if (row.oneshot !== undefined) {
        state.oneshot = row.oneshot;
      }

      const inResult = guards.synthesisOptedIn.evaluate(state);
      const outResult = guards.synthesisOptedOut.evaluate(state);

      const inPassed = inResult === true;
      const outPassed = outResult === true;

      // Mutual exclusivity: exactly one is true
      expect(
        inPassed !== outPassed,
        `row "${row.label}": expected exactly one guard to pass (in=${inPassed}, out=${outPassed})`,
      ).toBe(true);
    }
  });

  it('synthesisOptedOut_policyNever_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'never' },
      _events: [],
    };

    expect(guards.synthesisOptedOut.evaluate(state)).toBe(true);
  });

  it('synthesisOptedOut_policyAlways_returnsFalseWithReason', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'always' },
      _events: [],
    };

    const result = guards.synthesisOptedOut.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('always');
  });

  it('synthesisOptedOut_policyOnRequestNoEvent_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'phase.changed' }],
    };

    expect(guards.synthesisOptedOut.evaluate(state)).toBe(true);
  });

  it('synthesisOptedOut_policyOnRequestWithEvent_returnsFalseWithReason', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      workflowType: 'oneshot',
      oneshot: { synthesisPolicy: 'on-request' },
      _events: [{ type: 'synthesize.requested' }],
    };

    const result = guards.synthesisOptedOut.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('synthesize.requested');
  });
});

// ─── oneshotPlanSet Guard Tests (T9) ────────────────────────────────────────
// Tightened (post CodeRabbit review on PR #1078): the guard now requires
// `state.artifacts.plan` as the primary condition. `oneshot.planSummary`
// remains useful as a pipeline-view label but is no longer accepted as a
// plan substitute on its own. These tests are flipped accordingly.

describe('oneshotPlanSet', () => {
  it('oneshotPlanSet_planSummaryAloneIsInsufficient', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'A one-page plan' },
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('artifacts.plan');
  });

  it('oneshotPlanSet_artifactsPlanSet_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      artifacts: { plan: 'Plan contents or path' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_bothPlanSummaryAndArtifactsPlan_returnsTrue', () => {
    // artifacts.plan is sufficient; planSummary is allowed alongside as
    // a pipeline-view label but is not required. The guard passes because
    // artifacts.plan is set, not because planSummary is.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'always', planSummary: 'summary' },
      artifacts: { plan: 'path/to/plan.md' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_emptyArtifactsPlan_fallsThrough', () => {
    // An empty artifacts.plan string must NOT count as set.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'summary' },
      artifacts: { plan: '' },
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });

  it('oneshotPlanSet_planSummaryWithoutArtifacts_returnsFailureWithSuggestedFix', () => {
    const state: Record<string, unknown> = {
      featureId: 'fix-readme',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'one-liner' },
      artifacts: {},
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('oneshot-plan-set');
    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_workflow');
    expect(failure.suggestedFix!.params.featureId).toBe('fix-readme');
    // The suggested fix now points at artifacts.plan, not oneshot.planSummary.
    const updates = failure.suggestedFix!.params.updates as Record<string, unknown>;
    expect(updates).toHaveProperty('artifacts.plan');
  });

  it('oneshotPlanSet_missingOneshotAndArtifacts_returnsFailure', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
  });

  it('oneshotPlanSet_rejectsWhitespaceOnlyPlan', () => {
    // Shepherd iter 2 (CodeRabbit F3): whitespace-only plan strings are
    // not real plan artifacts. `'   '` satisfies `.length > 0` but carries
    // no content — the guard must reject it on `.trim().length > 0`.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'summary' },
      artifacts: { plan: '   ' },
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('artifacts.plan');
  });

  it('oneshotPlanSet_rejectsPlanWithOnlyNewlinesAndTabs', () => {
    // Defensive: "\n\t\n " is whitespace-only too. Same rejection.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      artifacts: { plan: '\n\t\n ' },
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
  });

  // F23 (#1213): align guard with the `delegationReadinessProjection`
  // contract — `artifacts.plan` MUST be a non-empty string (plan
  // contents or path). Non-string truthy values (true, objects,
  // numbers) used to satisfy the guard, which diverged from the
  // projection's `artifactPresent = typeof === 'string' && .length > 0`
  // narrowing. Now both surfaces enforce the same shape.
  it('oneshotPlanSet_rejectsNonStringTruthyValues', () => {
    // Patches that wrote `artifacts.plan = true` or `= 1` or `= {}`
    // previously silently advanced the workflow. None of these are
    // valid plan artifacts; all must fail the guard.
    const cases: ReadonlyArray<{ label: string; plan: unknown }> = [
      { label: 'boolean true', plan: true },
      { label: 'number 1', plan: 1 },
      { label: 'plain object', plan: {} },
      { label: 'object with path field', plan: { path: 'plan.md' } },
      { label: 'array', plan: ['plan.md'] },
    ];
    for (const { label, plan } of cases) {
      const state: Record<string, unknown> = {
        featureId: 'test-feature',
        artifacts: { plan },
      };
      const result = guards.oneshotPlanSet.evaluate(state);
      expect(
        result,
        `expected non-string plan (${label}) to fail the guard`,
      ).not.toBe(true);
      const failure = result as GuardFailure;
      expect(failure.passed).toBe(false);
      expect(failure.reason).toContain('artifacts.plan');
    }
  });
});

// ─── Discovery Workflow Guard Tests (#1080) ────────────────────────────────

describe('sourcesCollected', () => {
  it('sourcesCollected_PassesWhenArtifactsSourcesNonEmpty', () => {
    const state = { artifacts: { sources: ['doc1.md', 'doc2.md'] } };
    expect(guards.sourcesCollected.evaluate(state)).toBe(true);
  });

  it('sourcesCollected_FailsWhenArtifactsSourcesMissing', () => {
    const state = { artifacts: {} };
    const result = guards.sourcesCollected.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).passed).toBe(false);
  });

  it('sourcesCollected_FailsWhenArtifactsSourcesEmptyArray', () => {
    const state = { artifacts: { sources: [] } };
    const result = guards.sourcesCollected.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).passed).toBe(false);
  });
});

describe('reportArtifactExists', () => {
  it('reportArtifactExists_PassesWhenArtifactsReportSet', () => {
    const state = { artifacts: { report: 'docs/research/analysis.md' } };
    expect(guards.reportArtifactExists.evaluate(state)).toBe(true);
  });

  it('reportArtifactExists_FailsWhenArtifactsReportMissing', () => {
    const state = { artifacts: {} };
    const result = guards.reportArtifactExists.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).passed).toBe(false);
  });
});
