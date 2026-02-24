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
        lastError: 'gt submit failed',
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
