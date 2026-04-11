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
  it('revisionsExhausted_CountAtMax_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 3 },
    };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).toBe(true);
  });

  it('revisionsExhausted_CountAboveMax_ReturnsTrue', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 5 },
    };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).toBe(true);
  });

  it('revisionsExhausted_CountBelowMax_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 1 },
    };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('revisions-exhausted');
    expect(failure.reason).toContain('1/3');
  });

  it('revisionsExhausted_NoRevisionCount_ReturnsFailure', () => {
    const state: Record<string, unknown> = {};

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
    expect(failure.reason).toContain('revisions-exhausted');
    expect(failure.reason).toContain('0/3');
  });

  it('revisionsExhausted_ZeroRevisions_ReturnsFailure', () => {
    const state: Record<string, unknown> = {
      planReview: { revisionCount: 0 },
    };

    const result = guards.revisionsExhausted.evaluate(state);

    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
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

describe('oneshotPlanSet', () => {
  it('oneshotPlanSet_planSummarySet_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'on-request', planSummary: 'A one-page plan' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_artifactsPlanSet_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      artifacts: { plan: 'Plan contents or path' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_bothPlanSummaryAndArtifactsPlan_returnsTrue', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'always', planSummary: 'summary' },
      artifacts: { plan: 'path/to/plan.md' },
    };
    expect(guards.oneshotPlanSet.evaluate(state)).toBe(true);
  });

  it('oneshotPlanSet_emptyPlanSummary_fallsThrough', () => {
    // An empty planSummary must NOT count as set — require a non-empty string.
    // If artifacts.plan is absent, the guard fails.
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
      oneshot: { synthesisPolicy: 'on-request', planSummary: '' },
      artifacts: {},
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.passed).toBe(false);
  });

  it('oneshotPlanSet_neitherSet_returnsFailureWithSuggestedFix', () => {
    const state: Record<string, unknown> = {
      featureId: 'fix-readme',
      oneshot: { synthesisPolicy: 'on-request' },
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
  });

  it('oneshotPlanSet_missingOneshotAndArtifacts_returnsFailure', () => {
    const state: Record<string, unknown> = {
      featureId: 'test-feature',
    };
    const result = guards.oneshotPlanSet.evaluate(state);
    expect(result).not.toBe(true);
  });
});
