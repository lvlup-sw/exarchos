import { describe, it, expect } from 'vitest';
import { guards, PASSED_STATUSES, FAILED_STATUSES, type GuardResult, type GuardFailure } from '../../workflow/guards.js';

// ─── Task 1: GuardFailure type extension ─────────────────────────────────────

describe('GuardFailure Type', () => {
  describe('GuardFailure_WithExpectedShape_IncludesFieldInResult', () => {
    it('GuardFailure_WithExpectedShape_IncludesFieldInResult', () => {
      const failure: GuardFailure = {
        passed: false,
        reason: 'test guard failed',
        expectedShape: { tasks: [{ id: '<task-id>', status: 'complete' }] },
      };
      const result: GuardResult = failure;
      expect(result).toEqual({
        passed: false,
        reason: 'test guard failed',
        expectedShape: { tasks: [{ id: '<task-id>', status: 'complete' }] },
      });
    });
  });

  describe('GuardFailure_WithSuggestedFix_IncludesFieldInResult', () => {
    it('GuardFailure_WithSuggestedFix_IncludesFieldInResult', () => {
      const failure: GuardFailure = {
        passed: false,
        reason: 'test guard failed',
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'set', featureId: 'f1' },
        },
      };
      const result: GuardResult = failure;
      expect(result).toEqual({
        passed: false,
        reason: 'test guard failed',
        suggestedFix: {
          tool: 'exarchos_workflow',
          params: { action: 'set', featureId: 'f1' },
        },
      });
    });
  });
});

// ─── Task 2: allTasksComplete structured failure ─────────────────────────────

describe('AllTasksComplete Structured Failure', () => {
  describe('AllTasksComplete_WithIncompleteTasks_ReturnsSuggestedFix', () => {
    it('AllTasksComplete_WithIncompleteTasks_ReturnsSuggestedFix', () => {
      const state = {
        featureId: 'feat-123',
        tasks: [
          { id: '1', status: 'complete' },
          { id: '2', status: 'pending' },
          { id: '3', status: 'in-progress' },
        ],
      } as Record<string, unknown>;

      const result = guards.allTasksComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toEqual({
        tasks: [{ id: '<task-id>', status: 'complete' }],
      });
      expect(obj.suggestedFix).toBeDefined();
      expect(obj.suggestedFix!.tool).toBe('exarchos_workflow');
      const params = obj.suggestedFix!.params as Record<string, unknown>;
      expect(params.action).toBe('set');
      expect(params.featureId).toBe('feat-123');
      const updates = params.updates as { tasks: Array<{ id: string; status: string }> };
      expect(updates.tasks).toHaveLength(2);
      expect(updates.tasks.map((t) => t.id).sort()).toEqual(['2', '3']);
      expect(updates.tasks.every((t) => t.status === 'complete')).toBe(true);
    });
  });

  describe('AllTasksComplete_NoFeatureId_UsesFallback', () => {
    it('AllTasksComplete_NoFeatureId_UsesFallbackPlaceholder', () => {
      const state = {
        tasks: [{ id: '1', status: 'pending' }],
      } as Record<string, unknown>;

      const result = guards.allTasksComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      const params = obj.suggestedFix!.params as Record<string, unknown>;
      expect(params.featureId).toBe('<featureId>');
    });
  });
});

// ─── Task 3: allReviewsPassed / anyReviewFailed expectedShape ────────────────

describe('AllReviewsPassed Expected Shape', () => {
  describe('AllReviewsPassed_NoReviews_ReturnsExpectedShape', () => {
    it('AllReviewsPassed_MissingReviews_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toEqual({
        reviews: { '<name>': { status: 'pass (or verdict: "pass")' } },
      });
    });

    it('AllReviewsPassed_NullReviews_ReturnsExpectedShape', () => {
      const state = { reviews: null } as unknown as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        reviews: { '<name>': { status: 'pass (or verdict: "pass")' } },
      });
    });
  });

  describe('AllReviewsPassed_FailedReviews_ListsFailedPaths', () => {
    it('AllReviewsPassed_FailedReviews_ListsFailedPaths', () => {
      const state = {
        reviews: {
          codeReview: { status: 'pass' },
          secReview: { status: 'fail' },
          perfReview: { status: 'needs_fixes' },
        },
      } as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toBeDefined();
      const shape = obj.expectedShape as Record<string, unknown>;
      const reviews = shape.reviews as Record<string, unknown>;
      expect(reviews['secReview']).toEqual({ status: 'pass' });
      expect(reviews['perfReview']).toEqual({ status: 'pass' });
    });
  });
});

describe('AllReviewsPassed Nested Review Paths', () => {
  describe('AllReviewsPassed_NestedFailedReviews_BuildsNestedExpectedShape', () => {
    it('AllReviewsPassed_NestedFailedReviews_BuildsNestedExpectedShape', () => {
      const state = {
        reviews: {
          A1: {
            specReview: { status: 'pass' },
            qualityReview: { status: 'fail' },
          },
          A2: {
            specReview: { status: 'needs_fixes' },
          },
        },
      } as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      // The expectedShape should have nested structure, not dotted keys
      const shape = obj.expectedShape as Record<string, unknown>;
      const reviews = shape.reviews as Record<string, unknown>;
      // A1.qualityReview should be nested: { A1: { qualityReview: { status: 'pass' } } }
      const a1 = reviews['A1'] as Record<string, unknown>;
      expect(a1).toBeDefined();
      expect(a1['qualityReview']).toEqual({ status: 'pass' });
      // A2.specReview should be nested: { A2: { specReview: { status: 'pass' } } }
      const a2 = reviews['A2'] as Record<string, unknown>;
      expect(a2).toBeDefined();
      expect(a2['specReview']).toEqual({ status: 'pass' });
    });
  });
});

// ─── #1004: verdict synonym for status ─────────────────────────────────────

describe('AllReviewsPassed Verdict Synonym', () => {
  it('AllReviewsPassed_VerdictField_TreatedAsStatus', () => {
    const state = {
      reviews: {
        specReview: { verdict: 'pass' },
        qualityReview: { verdict: 'approved' },
      },
    } as Record<string, unknown>;

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).toBe(true);
  });

  it('AllReviewsPassed_MixedStatusAndVerdict_BothRecognized', () => {
    const state = {
      reviews: {
        specReview: { status: 'pass' },
        qualityReview: { verdict: 'pass' },
      },
    } as Record<string, unknown>;

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).toBe(true);
  });

  it('AllReviewsPassed_VerdictFail_FailsGuard', () => {
    const state = {
      reviews: {
        specReview: { verdict: 'fail' },
      },
    } as Record<string, unknown>;

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).not.toBe(true);
    const obj = result as GuardFailure;
    expect(obj.passed).toBe(false);
  });

  it('AllReviewsPassed_NestedVerdict_Recognized', () => {
    const state = {
      reviews: {
        A1: {
          specReview: { verdict: 'pass' },
          qualityReview: { verdict: 'approved' },
        },
      },
    } as Record<string, unknown>;

    const result = guards.allReviewsPassed.evaluate(state);

    expect(result).toBe(true);
  });
});

describe('AnyReviewFailed Expected Shape', () => {
  describe('AnyReviewFailed_NoReviews_ReturnsExpectedShape', () => {
    it('AnyReviewFailed_NoReviews_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.anyReviewFailed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toEqual({
        reviews: { '<name>': { status: 'pass (or verdict: "pass")' } },
      });
    });
  });
});

// ─── Task 4: Artifact guards and phase-specific guards ───────────────────────

describe('Artifact Guard Structured Failures', () => {
  describe('DesignArtifactExists_Missing_ReturnsSuggestedFix', () => {
    it('DesignArtifactExists_Missing_ReturnsSuggestedFix', () => {
      const state = { featureId: 'feat-42' } as Record<string, unknown>;

      const result = guards.designArtifactExists.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toEqual({
        artifacts: { design: '<path-or-content>' },
      });
      expect(obj.suggestedFix).toBeDefined();
      expect(obj.suggestedFix!.tool).toBe('exarchos_workflow');
      const params = obj.suggestedFix!.params as Record<string, unknown>;
      expect(params.action).toBe('set');
      expect(params.featureId).toBe('feat-42');
      const updates = params.updates as Record<string, unknown>;
      expect(updates.artifacts).toEqual({ design: '<path-or-content>' });
    });
  });

  describe('PlanArtifactExists_Missing_ReturnsSuggestedFix', () => {
    it('PlanArtifactExists_Missing_ReturnsSuggestedFix', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.planArtifactExists.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        artifacts: { plan: '<path-or-content>' },
      });
      expect(obj.suggestedFix!.tool).toBe('exarchos_workflow');
    });
  });

  describe('RcaDocumentComplete_Missing_ReturnsSuggestedFix', () => {
    it('RcaDocumentComplete_Missing_ReturnsSuggestedFix', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.rcaDocumentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        artifacts: { rca: '<path-or-content>' },
      });
      expect(obj.suggestedFix!.tool).toBe('exarchos_workflow');
    });
  });

  describe('FixDesignComplete_Missing_ReturnsSuggestedFix', () => {
    it('FixDesignComplete_Missing_ReturnsSuggestedFix', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.fixDesignComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        artifacts: { fixDesign: '<path-or-content>' },
      });
      expect(obj.suggestedFix!.tool).toBe('exarchos_workflow');
    });
  });
});

describe('Phase-Specific Guard Expected Shapes', () => {
  describe('TriageComplete_MissingSymptom_ReturnsExpectedShape', () => {
    it('TriageComplete_MissingSymptom_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.triageComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.passed).toBe(false);
      expect(obj.expectedShape).toEqual({
        triage: { symptom: '<description>' },
      });
    });
  });

  describe('RootCauseFound_Missing_ReturnsExpectedShape', () => {
    it('RootCauseFound_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.rootCauseFound.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        investigation: { rootCause: '<description>' },
      });
    });
  });

  describe('ScopeAssessmentComplete_Missing_ReturnsExpectedShape', () => {
    it('ScopeAssessmentComplete_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        explore: { scopeAssessment: '<assessment>' },
      });
    });
  });

  describe('BriefComplete_Missing_ReturnsExpectedShape', () => {
    it('BriefComplete_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.briefComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        brief: { goals: '<goals-array-or-description>' },
      });
    });
  });

  describe('DocsUpdated_Missing_ReturnsExpectedShape', () => {
    it('DocsUpdated_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.docsUpdated.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        validation: { docsUpdated: true },
      });
    });
  });

  describe('GoalsVerified_Missing_ReturnsExpectedShape', () => {
    it('GoalsVerified_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.goalsVerified.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        validation: { testsPass: true },
      });
    });
  });

  describe('ValidationPassed_Missing_ReturnsExpectedShape', () => {
    it('ValidationPassed_Missing_ReturnsExpectedShape', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.validationPassed.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj.expectedShape).toEqual({
        validation: { testsPass: true },
      });
    });
  });
});

// ─── #775: scopeAssessmentComplete guard with explore field variations ───────

describe('ScopeAssessmentComplete Guard (#775)', () => {
  describe('scopeAssessmentComplete_WithExploreSet_ReturnsTrue', () => {
    it('should return true when explore.scopeAssessment is set', () => {
      const state = { explore: { scopeAssessment: 'Assessment complete' } } as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).toBe(true);
    });
  });

  describe('scopeAssessmentComplete_WithoutExplore_ReturnsFailure', () => {
    it('should return { passed: false } when explore is missing entirely', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj).toEqual(expect.objectContaining({ passed: false }));
      expect(obj.expectedShape).toEqual({ explore: { scopeAssessment: '<assessment>' } });
    });
  });

  describe('scopeAssessmentComplete_WithEmptyExplore_ReturnsFailure', () => {
    it('should return { passed: false } when explore exists but scopeAssessment is missing', () => {
      const state = { explore: {} } as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj).toEqual(expect.objectContaining({ passed: false }));
    });
  });

  describe('scopeAssessmentComplete_WithNullExplore_ReturnsFailure', () => {
    it('should return { passed: false } when explore is null', () => {
      const state = { explore: null } as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj).toEqual(expect.objectContaining({ passed: false }));
    });
  });

  describe('scopeAssessmentComplete_WithNullScopeAssessment_ReturnsFailure', () => {
    it('should return { passed: false } when explore.scopeAssessment is null', () => {
      const state = { explore: { scopeAssessment: null } } as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).not.toBe(true);
      const obj = result as GuardFailure;
      expect(obj).toEqual(expect.objectContaining({ passed: false }));
    });
  });

  describe('scopeAssessmentComplete_WithRootScopeAssessment_ReturnsTrue', () => {
    it('should return true when scopeAssessment is at root level (legacy/convenience)', () => {
      const state = { scopeAssessment: { complete: true, track: 'overhaul' } } as Record<string, unknown>;

      const result = guards.scopeAssessmentComplete.evaluate(state);

      expect(result).toBe(true);
    });
  });
});

// ─── T6: Guard null safety edge cases (ARCH-6) ──────────────────────────────

describe('Guard Null Safety', () => {
  describe('AllReviewsPassed_NullReviews_ReturnsFalseWithReason', () => {
    it('should return { passed: false, reason } when reviews is explicitly null', () => {
      const state = { reviews: null } as unknown as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);

      expect(result).not.toBe(false);
      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
      expect(typeof obj.reason).toBe('string');
      expect(obj.reason.length).toBeGreaterThan(0);
    });
  });

  describe('MergeVerified_MissingCleanup_ReturnsFalseWithReason', () => {
    it('should return { passed: false, reason } when _cleanup is missing', () => {
      const state = {} as Record<string, unknown>;

      const result = guards.mergeVerified.evaluate(state);

      expect(result).not.toBe(false);
      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
      expect(typeof obj.reason).toBe('string');
      expect(obj.reason).toContain('mergeVerified');
    });

    it('should return { passed: false, reason } when _cleanup exists but mergeVerified is false', () => {
      const state = { _cleanup: { mergeVerified: false } } as Record<string, unknown>;

      const result = guards.mergeVerified.evaluate(state);

      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
    });
  });
});

// ─── Guard Fallback: Top-level artifact fields ──────────────────────────────

describe('Guard Artifact Fallback', () => {
  describe('designArtifactExists_TopLevelDesign_Passes', () => {
    it('should pass when state.design exists but state.artifacts.design is null', () => {
      const state = {
        design: 'path/to/design.md',
        artifacts: { design: null, plan: null, pr: null },
      } as Record<string, unknown>;

      const result = guards.designArtifactExists.evaluate(state);
      expect(result).toBe(true);
    });
  });

  describe('planArtifactExists_TopLevelPlan_Passes', () => {
    it('should pass when state.plan exists but state.artifacts.plan is null', () => {
      const state = {
        plan: 'path/to/plan.md',
        artifacts: { design: null, plan: null, pr: null },
      } as Record<string, unknown>;

      const result = guards.planArtifactExists.evaluate(state);
      expect(result).toBe(true);
    });
  });

  describe('designArtifactExists_NestedArtifact_StillPasses', () => {
    it('should still pass with canonical artifacts.design path (regression check)', () => {
      const state = {
        artifacts: { design: 'path/to/design.md', plan: null, pr: null },
      } as Record<string, unknown>;

      const result = guards.designArtifactExists.evaluate(state);
      expect(result).toBe(true);
    });
  });

  describe('planArtifactExists_NestedArtifact_StillPasses', () => {
    it('should still pass with canonical artifacts.plan path (regression check)', () => {
      const state = {
        artifacts: { design: null, plan: 'path/to/plan.md', pr: null },
      } as Record<string, unknown>;

      const result = guards.planArtifactExists.evaluate(state);
      expect(result).toBe(true);
    });
  });
});

// ─── Review Status: fixes-applied ───────────────────────────────────────────

describe('Review Status fixes-applied', () => {
  describe('allReviewsPassed_FixesApplied_Passes', () => {
    it('should pass when review status is fixes-applied', () => {
      const state = {
        reviews: {
          codeReview: { status: 'fixes-applied' },
        },
      } as Record<string, unknown>;

      const result = guards.allReviewsPassed.evaluate(state);
      expect(result).toBe(true);
    });
  });

  describe('anyReviewFailed_FixesApplied_DoesNotTrigger', () => {
    it('should NOT consider fixes-applied as failed', () => {
      const state = {
        reviews: {
          codeReview: { status: 'fixes-applied' },
        },
      } as Record<string, unknown>;

      const result = guards.anyReviewFailed.evaluate(state);
      // anyReviewFailed should NOT pass — fixes-applied is not a failure
      expect(result).not.toBe(true);
      expect(typeof result).toBe('object');
      const obj = result as { passed: false; reason: string };
      expect(obj.passed).toBe(false);
    });
  });

  describe('PASSED_STATUSES_IncludesFixesApplied', () => {
    it('should include fixes-applied in PASSED_STATUSES', () => {
      expect(PASSED_STATUSES.has('fixes-applied')).toBe(true);
    });
  });

  describe('FAILED_STATUSES_ExcludesFixesApplied', () => {
    it('should NOT include fixes-applied in FAILED_STATUSES', () => {
      expect(FAILED_STATUSES.has('fixes-applied')).toBe(false);
    });
  });
});

// ─── Track & Field Guards: expectedShape and suggestedFix (#959) ─────────────

describe('Track Selection Guards Structured Failures', () => {
  const trackGuards = [
    { key: 'polishTrackSelected', expectedTrack: 'polish' },
    { key: 'overhaulTrackSelected', expectedTrack: 'overhaul' },
    { key: 'hotfixTrackSelected', expectedTrack: 'hotfix' },
    { key: 'thoroughTrackSelected', expectedTrack: 'thorough' },
  ] as const;

  for (const { key, expectedTrack } of trackGuards) {
    describe(`${key}_WrongTrack_ReturnsExpectedShapeAndSuggestedFix`, () => {
      it(`should include expectedShape { track: '${expectedTrack}' } and suggestedFix`, () => {
        const state = { featureId: 'test-feature', track: 'wrong' };
        const result = guards[key].evaluate(state);
        expect(result).not.toBe(true);
        const failure = result as GuardFailure;
        expect(failure.passed).toBe(false);
        expect(failure.reason).toContain(expectedTrack);
        expect(failure.reason).toContain('wrong');
        expect(failure.expectedShape).toEqual({ track: expectedTrack });
        expect(failure.suggestedFix).toEqual({
          tool: 'exarchos_workflow',
          params: { action: 'set', featureId: 'test-feature', updates: { track: expectedTrack } },
        });
      });
    });
  }
});

describe('PrUrlExists Structured Failure', () => {
  it('PrUrlExists_Missing_ReturnsExpectedShapeAndSuggestedFix', () => {
    const state = { featureId: 'test-feature' };
    const result = guards.prUrlExists.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.expectedShape).toEqual({ synthesis: { prUrl: '<pr-url>' } });
    expect(failure.suggestedFix?.tool).toBe('exarchos_workflow');
    expect(failure.suggestedFix?.params.updates).toEqual({ synthesis: { prUrl: '<pr-url>' } });
  });
});

describe('HumanUnblocked Structured Failure', () => {
  it('HumanUnblocked_NotSet_ReturnsExpectedShapeAndSuggestedFix', () => {
    const state = { featureId: 'test-feature' };
    const result = guards.humanUnblocked.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.expectedShape).toEqual({ unblocked: true });
    expect(failure.suggestedFix?.tool).toBe('exarchos_workflow');
    expect(failure.suggestedFix?.params.updates).toEqual({ unblocked: true });
  });
});

describe('PlanReviewComplete Structured Failure', () => {
  it('PlanReviewComplete_NotApproved_ReturnsExpectedShapeAndSuggestedFix', () => {
    const state = { featureId: 'test-feature' };
    const result = guards.planReviewComplete.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.expectedShape).toEqual({ planReview: { approved: true } });
    expect(failure.suggestedFix?.tool).toBe('exarchos_workflow');
  });
});

describe('PlanReviewGapsFound Structured Failure', () => {
  it('PlanReviewGapsFound_NoGaps_ReturnsExpectedShape', () => {
    const state = { featureId: 'test-feature' };
    const result = guards.planReviewGapsFound.evaluate(state);
    expect(result).not.toBe(true);
    const failure = result as GuardFailure;
    expect(failure.expectedShape).toEqual({ planReview: { gapsFound: true } });
    // No suggestedFix — gaps are discovered, not forced
    expect(failure.suggestedFix).toBeUndefined();
  });
});

// ─── T7: Guard consistent return types (ARCH-6) ─────────────────────────────

describe('Guard Consistent Return Types', () => {
  describe('AllGuards_OnFailure_ReturnObjectWithReason', () => {
    it('should return { passed: false, reason } (not bare false) for all guards on failure', () => {
      // Empty state should make most guards fail
      const emptyState: Record<string, unknown> = {};

      // Guards that should fail on empty state (skip 'always' and 'implementationComplete')
      const failableGuards = Object.entries(guards).filter(
        ([key]) => key !== 'always' && key !== 'implementationComplete',
      );

      for (const [key, guard] of failableGuards) {
        const result = guard.evaluate(emptyState);

        // If the guard passed (returns true), skip — we only care about failures
        if (result === true) continue;

        // On failure, the result MUST be an object with { passed: false, reason }
        // It should NOT be bare `false`
        expect(
          typeof result,
          `Guard '${key}' returned bare false instead of { passed: false, reason }`,
        ).toBe('object');

        const obj = result as { passed: false; reason: string };
        expect(obj.passed, `Guard '${key}' missing passed: false`).toBe(false);
        expect(
          typeof obj.reason,
          `Guard '${key}' missing reason string`,
        ).toBe('string');
        expect(
          obj.reason.length,
          `Guard '${key}' has empty reason`,
        ).toBeGreaterThan(0);
      }
    });
  });
});
