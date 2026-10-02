import { describe, it, expect } from 'vitest';
import { collectReviewStatuses, guards } from '../../../src/workflow/guards.js';
import type { GuardFailure } from '../../../src/workflow/guards.js';

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

    expect(failure.expectedShape).toBeDefined();
    expect(failure.expectedShape!.type).toBe('team.disbanded');
    const data = failure.expectedShape!.data as Record<string, string>;
    expect(data.totalDurationMs).toBe('number');
    expect(data.tasksCompleted).toBe('number');
    expect(data.tasksFailed).toBe('number');

    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_event');
    expect(failure.suggestedFix!.params.action).toBe('append');
  });

  /** Subagent mode spawns no team, so the guard passes without `team.disbanded`. */
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

/**
 * The cap is `state._maxPlanRevisions`, which the set handler injects from config. Without it, the
 * cap is `DEFAULT_MAX_PLAN_REVISIONS` (1). `revisionCount` is an event-sourced fact, but the cap is
 * policy and is not event-sourced.
 */
describe('revisionsExhausted', () => {
  it('revisionsExhausted_DefaultCap_CountAtOne_ReturnsTrue', () => {
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

  /** With cap 2, one revision stays below the cap and the second reaches it. */
  it('revisionsExhausted_InjectedCap_BoundaryAtTwo', () => {
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

  /** A malformed injected cap must not disable the bound, so the guard falls back to 1. */
  it('revisionsExhausted_NonFiniteInjectedCap_FallsBackToDefault', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 1 },
      _maxPlanRevisions: Number.NaN,
    };
    expect(guards.revisionsExhausted.evaluate(state)).toBe(true);
  });
});

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

describe('planReviewComplete', () => {
  it('PlanReviewApproved_MissingPlanReviewField_ReturnsFailed', () => {
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
    expect(failure.reason).toContain('2 task(s) incomplete');
    expect(failure.suggestedFix).toBeDefined();
    expect(failure.suggestedFix!.tool).toBe('exarchos_workflow');
  });
});


describe('allReviewsPassed (synthesis ready)', () => {
  /** `reviews` exists but holds no entry with a known status field. */
  it('SynthesisReadyGuard_MissingReviewVerdicts_ReturnsFailed', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {},
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('no recognizable review entries');
    expect(failure.expectedShape).toBeDefined();
  });

  it('SynthesisReadyGuard_MissingReviewsField_ReturnsFailed', () => {
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

  /** The agent sets one review, but two are required. */
  it('SynthesisReadyGuard_MissingRequiredDimensions_ReturnsFailed', () => {
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

  /**
   * At the high tier, `mutation-adequacy` is a required dimension. The projection folds a
   * no-toolchain skip-pass into it with status `pass`. The recorded run satisfies the presence
   * requirement, so review to synthesize is not dead-locked.
   */
  it('SynthesisReadyGuard_MutationAdequacySkipPassPresent_Passes_DR2a', () => {
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

  /** When the mutation gate never ran, the dimension is absent. A required gate that did not run must block. */
  it('SynthesisReadyGuard_MutationAdequacyRequiredButNeverRun_Blocks_DR2a', () => {
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

  /** Without an injected mode, the default is advisory, so a low score does not block. */
  it('MutationEnforcement_AdvisoryDefault_SubThresholdNeverBlocks_DR3', () => {
    expect(guards.allReviewsPassed.evaluate(mutationBase(0.01, {}))).toBe(true);
    expect(
      guards.allReviewsPassed.evaluate(
        mutationBase(0.01, { _mutationEnforcement: 'advisory', _mutationThreshold: 0.4 }),
      ),
    ).toBe(true);
  });

  /** A no-toolchain skip-pass has no real score, so block mode does not enforce it. */
  it('MutationEnforcement_SkipPassRun_NeverEnforced_DR3', () => {
    const state = mutationBase(0, { _mutationEnforcement: 'block', _mutationThreshold: 0.4 }, { skipped: true });
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /** The guard reads only injected values. Block mode without a finite threshold does not enforce. */
  it('MutationEnforcement_BlockModeButNoThresholdInjected_NotEnforced_DR3', () => {
    const state = mutationBase(0.01, { _mutationEnforcement: 'block' });
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /**
   * A degraded run carries `skipped: true` and `degraded: true`: the toolchain is present, but the
   * runner crashed or wrote an unparseable report. The run has no verifiable score, so block mode
   * must fail closed. The no-toolchain skip-pass stays advisory.
   */
  it('MutationEnforcement_BlockModeDegradedRun_Blocks_RVC_R1', () => {
    const state = mutationBase(
      0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4 },
      { skipped: true, degraded: true },
    );
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('degraded');
  });

  /**
   * A NaN score comes from a 0/0 ratio when every mutant is uncovered, and it cannot be verified.
   * `NaN < threshold` is always false, so block mode must fail closed for it.
   */
  it('MutationEnforcement_BlockModeNonFiniteScore_Blocks_RVC_R6', () => {
    const state = mutationBase(Number.NaN, {
      _mutationEnforcement: 'block',
      _mutationThreshold: 0.4,
    });
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('non-finite');
  });

  /**
   * Fail-closed applies only in block mode. In advisory mode, default or explicit, a degraded run
   * satisfies the presence requirement and does not block.
   */
  it('MutationEnforcement_DegradedRun_AdvisoryDefault_NeverBlocks_RVC_R1', () => {
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

  /**
   * The guard compares the `noCoverage` count of the dimension with `_maxNoCoverage`. In block mode,
   * a count above the budget blocks, apart from the score check. Here the score of 1.0 passes, but
   * 2 uncovered mutants exceed the budget of 0.
   */
  it('GuardCheckFour_NoCoverageExceedsBudget_BlocksUnderEnforcement', () => {
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
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: 0 },
      { noCoverage: 0 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /** No threshold is injected, so the score check does not run. A block here comes from the NoCoverage check. */
  it('GuardCheckFour_NoCoverageAxisIsOrthogonalToScore', () => {
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
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: 5 },
      { noCoverage: 3 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /** NoCoverage enforcement applies only in block mode. In advisory mode, uncovered mutants do not block. */
  it('GuardCheckFour_AdvisoryMode_NoCoverageNeverBlocks', () => {
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'advisory', _maxNoCoverage: 0 },
      { noCoverage: 9 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /** Block mode without an injected `_maxNoCoverage` does not enforce the NoCoverage check. */
  it('GuardCheckFour_NoBudgetInjected_NoCoverageNotEnforced', () => {
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block' },
      { noCoverage: 4 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /** A skip-pass run has no verifiable NoCoverage count, so the NoCoverage check does not block it. */
  it('GuardCheckFour_SkipPassWithNoCoverage_NotEnforced', () => {
    const state = mutationBase(
      0,
      { _mutationEnforcement: 'block', _maxNoCoverage: 0 },
      { skipped: true, noCoverage: 4 },
    );
    expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
  });

  /**
   * A real run, not skipped and not degraded, has no `noCoverage` field. In block mode with a
   * budget, it must fail closed, because `undefined > budget` is false.
   */
  it('GuardCheckFour_RealRunMissingNoCoverage_FailsClosed', () => {
    const state = mutationBase(
      1.0,
      { _mutationEnforcement: 'block', _maxNoCoverage: 0 },
      {},
    );
    const result = guards.allReviewsPassed.evaluate(state);
    expect(result).not.toBe(true);
    expect((result as GuardFailure).reason).toContain('no verifiable NoCoverage count');
  });

  it('GuardCheckFour_RealRunNegativeOrFractionalNoCoverage_FailsClosed', () => {
    for (const bad of [-1, 2.5]) {
      const state = mutationBase(
        1.0,
        { _mutationEnforcement: 'block', _maxNoCoverage: 0 },
        { noCoverage: bad },
      );
      const result = guards.allReviewsPassed.evaluate(state);
      expect(result).not.toBe(true);
      expect((result as GuardFailure).reason).toContain('no verifiable NoCoverage count');
    }
  });

  /**
   * A negative budget blocks every nontrivial diff, and a fractional budget means nothing for a
   * count. The guard ignores such a budget and does not enforce the NoCoverage check.
   */
  it('GuardCheckFour_NegativeOrFractionalBudget_NotEnforced', () => {
    for (const badBudget of [-1, 1.5]) {
      const state = mutationBase(
        1.0,
        { _mutationEnforcement: 'block', _mutationThreshold: 0.4, _maxNoCoverage: badBudget },
        { noCoverage: 2 },
      );
      expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
    }
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

  /** Without `_requiredReviews`, any passing review satisfies the guard. */
  it('SynthesisReadyGuard_NoRequiredReviewsConfigured_FallsBackToExistingBehavior', () => {
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

  /**
   * Reviewer agents copy the uppercase verdicts of `check_review_verdict` into state. The guard
   * must match a verdict without regard to case.
   */
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

  /** Uppercase values must also pass in the `status` field. */
  it('SynthesisReadyGuard_UppercaseStatusApproved_Accepts', () => {
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

  /** The guard must report all violations in one message, so the agent can fix them in one retry. */
  it('SynthesisReadyGuard_MissingDimensionsAndFailedStatus_AggregatesIntoSingleError', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'stray-review': { status: 'fail' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('Missing required review dimensions');
    expect(failure.reason).toContain('spec-review');
    expect(failure.reason).toContain('quality-review');
    expect(failure.reason).toContain('Reviews not passed');
    expect(failure.reason).toContain('stray-review');
  });

  /** An empty review object has no status, so it must count as a missing dimension. */
  it('SynthesisReadyGuard_RequiredDimensionPresentButEmptyObject_TreatedAsMissing', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': {},
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

  /**
   * A required `__proto__` key must count as missing, because every object inherits it. The
   * `expectedShape` and the `suggestedFix` must hold no unsafe key, so an agent that applies the
   * fix cannot pollute the prototype.
   */
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
    expect(failure.reason).toContain('__proto__');

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

  /**
   * The `suggestedFix` must cover the missing review and both failing reviews, a required one and a
   * stray one. One retry can then satisfy the guard.
   */
  it('SynthesisReadyGuard_MixedFailures_SuggestedFixCoversMissingAndFailing', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      phase: 'review',
      reviews: {
        'spec-review': { status: 'fail' },
        'stray-review': { status: 'needs_fixes' },
      },
      _requiredReviews: ['spec-review', 'quality-review'],
    };

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.suggestedFix).toBeDefined();
    const updates = failure.suggestedFix!.params.updates as Record<string, unknown>;
    expect(updates['reviews.quality-review.status']).toBe('pass');
    expect(updates['reviews.spec-review.status']).toBe('pass');
    expect(updates['reviews.stray-review.status']).toBe('pass');
  });
});

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

  /** Without an `oneshot` field, the guard must use the `on-request` policy. */
  it('synthesisOptedIn_policyDefaultsToOnRequest_whenFieldMissing', () => {
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
  /**
   * The table holds each policy with and without the event, plus the default with no `oneshot`
   * field. For each of the 8 rows, exactly one of the two guards must pass.
   */
  it('synthesisOptedOut_isInverseOfSynthesisOptedIn', () => {
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

/**
 * The guard requires `state.artifacts.plan`. `oneshot.planSummary` is a pipeline-view label, and
 * it does not satisfy the guard alone.
 */
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

  /** The guard passes because `artifacts.plan` is set. It does not need `planSummary`. */
  it('oneshotPlanSet_bothPlanSummaryAndArtifactsPlan_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'always', planSummary: 'summary' },
      artifacts: { plan: 'path/to/plan.md' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_emptyArtifactsPlan_fallsThrough', () => {
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

  /** A whitespace-only plan has a length but no content, so the guard must reject it. */
  it('oneshotPlanSet_rejectsWhitespaceOnlyPlan', () => {
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
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      artifacts: { plan: '\n\t\n ' },
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
  });

  /**
   * `artifacts.plan` must pass `isTypedArtifactReference`, the same check that the delegation
   * readiness view uses. A boolean, a number, an object or an array must fail.
   */
  it('oneshotPlanSet_rejectsNonStringTruthyValues', () => {
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

/**
 * The guards check the shape of untyped state fields at runtime, not with a type assertion. A
 * malformed field gives a structured failure or an ignored entry, not a runtime `TypeError`.
 */
describe('guards — malformed state is narrowed, not asserted (DR-24)', () => {
  describe('allTasksComplete', () => {
    /** An array-like object has `.length` but no `.every`. The guard must reject it without a throw. */
    it('AllTasksComplete_TasksIsArrayLikeNotArray_ReturnsStructuredFailureWithoutThrowing', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        tasks: { length: 1, 0: { status: 'pending' } },
      };

      const result = guards.allTasksComplete.evaluate(state);

      expect(result).not.toBe(true);
      const failure = result as GuardFailure;
      expect(failure.passed).toBe(false);
      expect(failure.reason).toContain('must be an array');
    });

    /** Unusable `tasks` must not read as an empty list, because that turns corrupt state into a passing gate. */
    it('AllTasksComplete_TasksIsNonArrayScalar_DoesNotReadAsZeroTasksComplete', () => {
      for (const corrupt of ['pending', 7, true]) {
        const result = guards.allTasksComplete.evaluate({ featureId: 'f1', tasks: corrupt });
        expect(result).not.toBe(true);
      }
    });

    it('AllTasksComplete_TasksContainsNullEntry_ReportsIncompleteWithoutThrowing', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        tasks: [{ id: 't1', status: 'complete' }, null],
      };

      const result = guards.allTasksComplete.evaluate(state);

      expect(result).not.toBe(true);
      expect((result as GuardFailure).reason).toContain('1 task(s) incomplete');
    });

    it('AllTasksComplete_TaskStatusIsNonString_CountsAsIncomplete', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        tasks: [{ id: 't1', status: 42 }],
      };

      expect(guards.allTasksComplete.evaluate(state)).not.toBe(true);
    });

    it('AllTasksComplete_TasksAbsentOrEmpty_StillPasses', () => {
      expect(guards.allTasksComplete.evaluate({ featureId: 'f1' })).toBe(true);
      expect(guards.allTasksComplete.evaluate({ featureId: 'f1', tasks: [] })).toBe(true);
    });

    it('AllTasksComplete_NonStringTaskId_FallsBackToPlaceholderInSuggestedFix', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        tasks: [{ id: 99, status: 'pending' }],
      };

      const failure = guards.allTasksComplete.evaluate(state) as GuardFailure;

      const updates = failure.suggestedFix?.params.updates as { tasks: Array<{ id: string }> };
      expect(updates.tasks[0]?.id).toBe('<task-id>');
    });
  });

  describe('object-shaped state fields', () => {
    /** `Object.entries('pending')` gives index and character pairs, so a string must not reach the collector. */
    it('AllReviewsPassed_ReviewsIsString_ReportsMissingRatherThanMiningCharacters', () => {
      const result = guards.allReviewsPassed.evaluate({ featureId: 'f1', reviews: 'pending' });

      expect(result).not.toBe(true);
      expect((result as GuardFailure).reason).toContain('missing');
    });

    it('PrUrlExists_SynthesisIsString_DoesNotSatisfyTheGuard', () => {
      const result = guards.prUrlExists.evaluate({ featureId: 'f1', synthesis: 'https://pr' });

      expect(result).not.toBe(true);
    });

    it('PlanReviewComplete_PlanReviewIsArray_DoesNotSatisfyTheGuard', () => {
      const result = guards.planReviewComplete.evaluate({
        featureId: 'f1',
        planReview: [{ approved: true }],
      });

      expect(result).not.toBe(true);
    });
  });

  describe('collectReviewStatuses', () => {
    /** An array entry is not a review entry. The nested walk must not make an `a.0` status from it. */
    it('CollectReviewStatuses_ArrayEntry_IsIgnoredNotIndexWalked', () => {
      expect(collectReviewStatuses({ a: [{ status: 'pass' }] })).toEqual([]);
    });

    it('CollectReviewStatuses_NestedArrayValue_IsIgnored', () => {
      expect(collectReviewStatuses({ a: { inner: [{ status: 'pass' }] } })).toEqual([]);
    });

    it('CollectReviewStatuses_PlainAndNestedRecords_StillCollected', () => {
      expect(collectReviewStatuses({ a: { status: 'pass' } })).toEqual([
        { path: 'a', status: 'pass' },
      ]);
      expect(collectReviewStatuses({ a: { inner: { verdict: 'APPROVED' } } })).toEqual([
        { path: 'a.inner', status: 'approved' },
      ]);
    });
  });

  describe('list-shaped state fields', () => {
    /** A non-list `_events` holds no `team.spawned`, so the guard takes the no-team pass. */
    it('TeamDisbandedEmitted_EventsIsNonArray_DoesNotThrowAndPassesVacuously', () => {
      expect(guards.teamDisbandedEmitted.evaluate({ featureId: 'f1', _events: 'nope' })).toBe(true);
    });

    it('TeamDisbandedEmitted_EventsContainsNullEntry_DoesNotThrow', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        _events: [null, { type: 'team.spawned' }],
      };

      expect(guards.teamDisbandedEmitted.evaluate(state)).not.toBe(true);
    });

    /** A filter of non-string entries makes the requirement set smaller, and this guard must never do that. */
    it('AllReviewsPassed_RequiredReviewsHasNonStringEntry_StaysReportedAsMissing', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        reviews: { spec: { status: 'pass' } },
        _requiredReviews: ['spec', 42],
      };

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(true);
      expect((result as GuardFailure).reason).toContain('42');
    });

    it('AllReviewsPassed_RequiredReviewsIsNonArray_TreatedAsNoRequirements', () => {
      const state: Record<string, unknown> = {
        featureId: 'f1',
        reviews: { spec: { status: 'pass' } },
        _requiredReviews: 'spec',
      };

      expect(guards.allReviewsPassed.evaluate(state)).toBe(true);
    });
  });
});
