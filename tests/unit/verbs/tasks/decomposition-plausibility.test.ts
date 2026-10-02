import { describe, it, expect } from 'vitest';
import {
  computeBreadth,
  countBehaviors,
  extractBoundaryTouching,
  parseOverrides,
  deriveBaseline,
  assessDecompositionPlausibility,
  DEFAULT_PLAUSIBILITY_BASELINE,
  type PlausibilityTaskInput,
  type PlausibilityBaseline,
} from '../../../../src/verbs/tasks/decomposition-plausibility.js';

describe('computeBreadth', () => {
  it('ComputeBreadth_FilesInSameDirectory_CountsOnce', () => {
    expect(computeBreadth(['src/a/x.ts', 'src/a/y.ts', 'src/a/z.test.ts'])).toBe(1);
  });

  it('ComputeBreadth_FilesAcrossDirectories_CountsDistinct', () => {
    const files = ['src/a/x.ts', 'src/b/y.ts', 'src/c/z.ts', 'src/d/w.ts', 'src/e/v.ts'];
    expect(computeBreadth(files)).toBe(5);
  });

  it('ComputeBreadth_BackslashSeparators_CollapseWithForwardSlash', () => {
    expect(computeBreadth(['src\\a\\x.ts', 'src/a/y.ts'])).toBe(1);
  });

  /** The bare names `x.ts` and `y.ts` share the `.` directory. */
  it('ComputeBreadth_BarePathAndEmpty_HandledGracefully', () => {
    expect(computeBreadth(['x.ts', '', 'y.ts'])).toBe(1);
    expect(computeBreadth([])).toBe(0);
  });
});

describe('countBehaviors', () => {
  it('CountBehaviors_DistinctBehaviorTokens_CountsEach', () => {
    const block = [
      '- [RED] `Widget_Render_DisplaysContent`',
      '- [RED] `Widget_EmptyData_ShowsPlaceholder`',
      '- [RED] `Api_Fetch_ReturnsData`',
    ].join('\n');
    expect(countBehaviors(block)).toBe(3);
  });

  /** A behavior in a `[RED]` step and in a checklist line is one behavior. */
  it('CountBehaviors_RepeatedBehaviorToken_DeduplicatesToOne', () => {
    const block = [
      '- [RED] `Widget_Render_DisplaysContent`',
      '- [ ] Test passes: `Widget_Render_DisplaysContent`',
    ].join('\n');
    expect(countBehaviors(block)).toBe(1);
  });

  it('CountBehaviors_NoBehaviorTokens_ReturnsZero', () => {
    expect(countBehaviors('**Goal:** just prose, no test names here.')).toBe(0);
  });
});

describe('extractBoundaryTouching', () => {
  it('ExtractBoundaryTouching_TitleCaseTrue_ReturnsTrue', () => {
    expect(extractBoundaryTouching('**Boundary Touching:** true')).toBe(true);
  });

  it('ExtractBoundaryTouching_CamelCaseFalse_ReturnsFalse', () => {
    expect(extractBoundaryTouching('**boundaryTouching:** false')).toBe(false);
  });

  it('ExtractBoundaryTouching_InlineDottedForm_ReturnsTrue', () => {
    expect(
      extractBoundaryTouching('**Risk Tier:** high · **Boundary Touching:** true'),
    ).toBe(true);
  });

  it('ExtractBoundaryTouching_NoStamp_ReturnsUndefined', () => {
    expect(extractBoundaryTouching('**Files:**\n- `src/a.ts`')).toBeUndefined();
  });

  /** The pattern `(?![\w-])` rejects a value that a word or hyphen character follows. */
  it('ExtractBoundaryTouching_MalformedSuffix_ReturnsUndefined', () => {
    expect(extractBoundaryTouching('**Boundary Touching:** false-ish maybe')).toBeUndefined();
  });
});

describe('parseOverrides', () => {
  it('ParseOverrides_KnownSignalWithRationale_Recorded', () => {
    const text = '**Plausibility Override:** breadth: this monorepo migration must span all packages';
    expect(parseOverrides(text)).toEqual({
      breadth: 'this monorepo migration must span all packages',
    });
  });

  it('ParseOverrides_EmptyRationale_NotRecorded', () => {
    expect(parseOverrides('**Plausibility Override:** breadth:')).toEqual({});
    expect(parseOverrides('**Plausibility Override:** breadth:    ')).toEqual({});
  });

  it('ParseOverrides_UnknownSignal_Ignored', () => {
    expect(parseOverrides('**Plausibility Override:** made-up-signal: whatever')).toEqual({});
  });

  it('ParseOverrides_MultipleSignals_AllRecorded', () => {
    const text = [
      '**Plausibility Override:** historical-size: generated client, one file per endpoint',
      '**Plausibility Override:** risk-uniformity: all tasks are doc-only copy edits',
    ].join('\n');
    expect(parseOverrides(text)).toEqual({
      'historical-size': 'generated client, one file per endpoint',
      'risk-uniformity': 'all tasks are doc-only copy edits',
    });
  });
});

describe('deriveBaseline', () => {
  /**
   * The 90th-percentile file count is 10 and the behavior count is 9. With a slack of 2, the
   * bounds are 20 and 18, above the floors. The fields that are not derived keep the floor.
   */
  it('DeriveBaseline_LargeHistoricalSpread_RaisesThresholdAboveFloor', () => {
    const baseline = deriveBaseline({
      fileCounts: [2, 3, 4, 5, 6, 7, 8, 9, 10, 50],
      behaviorCounts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 30],
    });
    expect(baseline.maxFileCount).toBe(20);
    expect(baseline.maxBehaviorCount).toBe(18);
    expect(baseline.maxBreadth).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxBreadth);
    expect(baseline.uniformityMinTasks).toBe(DEFAULT_PLAUSIBILITY_BASELINE.uniformityMinTasks);
  });

  /**
   * The derived values are below the floor, so the floor applies. A sample of small tasks cannot
   * make a threshold too strict.
   */
  it('DeriveBaseline_TinyHistoricalTasks_FloorsAtDefault', () => {
    const baseline = deriveBaseline({
      fileCounts: [1, 1, 2, 2, 3],
      behaviorCounts: [1, 1, 1, 2, 2],
    });
    expect(baseline.maxFileCount).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxFileCount);
    expect(baseline.maxBehaviorCount).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxBehaviorCount);
  });

  it('DeriveBaseline_ExplicitOverride_Wins', () => {
    const baseline = deriveBaseline(
      { fileCounts: [2, 3, 4, 5, 6, 7, 8, 9, 10, 50], behaviorCounts: [1] },
      { maxFileCount: 7 },
    );
    expect(baseline.maxFileCount).toBe(7);
  });

  it('DeriveBaseline_EmptySample_YieldsFloor', () => {
    const baseline = deriveBaseline({ fileCounts: [], behaviorCounts: [] });
    expect(baseline).toEqual(DEFAULT_PLAUSIBILITY_BASELINE);
  });
});

/** Build a small, plausible task input with overridable fields. */
function task(overrides: Partial<PlausibilityTaskInput> = {}): PlausibilityTaskInput {
  return {
    id: overrides.id ?? 'T-01',
    files: overrides.files ?? ['src/a/x.ts', 'src/a/x.test.ts'],
    behaviorCount: overrides.behaviorCount ?? 2,
    ...(overrides.riskTier ? { riskTier: overrides.riskTier } : {}),
    ...(overrides.boundaryTouching !== undefined
      ? { boundaryTouching: overrides.boundaryTouching }
      : {}),
    ...(overrides.overrides ? { overrides: overrides.overrides } : {}),
  };
}

/** Builds `n` one-file tasks with the same risk tier and boundary stamp. */
function uniformFleet(
  n: number,
  riskTier: PlausibilityTaskInput['riskTier'],
  boundaryTouching: boolean,
): PlausibilityTaskInput[] {
  return Array.from({ length: n }, (_, i) =>
    task({
      id: `T-${String(i + 1).padStart(2, '0')}`,
      files: [`src/mod${i}/file.ts`],
      behaviorCount: 1,
      riskTier,
      boundaryTouching,
    }),
  );
}

describe('assessDecompositionPlausibility', () => {
  /** Five directories exceed the default breadth bound of 4. */
  it('Assess_BroadTask_ChallengesBreadth', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts'];
    const result = assessDecompositionPlausibility([task({ files })]);
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toContain('breadth');
    const breadth = result.challenges.find((c) => c.signal === 'breadth');
    expect(breadth?.observed).toBe(5);
    expect(breadth?.threshold).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxBreadth);
    expect(breadth?.taskId).toBe('T-01');
  });

  /** Nine behaviors exceed the default bound of 8. */
  it('Assess_ManyBehaviors_ChallengesBehaviorCount', () => {
    const result = assessDecompositionPlausibility([task({ behaviorCount: 9 })]);
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toContain('behavior-count');
  });

  /** Twenty files exceed the default file-count bound of 12. */
  it('Assess_OversizedTask_ChallengesHistoricalSize', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/mod/file${i}.ts`);
    const result = assessDecompositionPlausibility([task({ files, behaviorCount: 1 })]);
    expect(result.challenged).toBe(true);
    const size = result.challenges.find((c) => c.signal === 'historical-size');
    expect(size).toBeDefined();
    expect(size?.observed).toBe(20);
  });

  /**
   * A repository with large historical tasks raises the file-count bound, so the same 20-file
   * task gets no challenge.
   */
  it('Assess_OversizedTask_NotChallengedUnderCalibratedBaseline', () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/mod/file${i}.ts`);
    const baseline: PlausibilityBaseline = deriveBaseline({
      fileCounts: [10, 12, 14, 16, 18, 20, 22, 24, 26, 40],
      behaviorCounts: [1],
    });
    const result = assessDecompositionPlausibility([task({ files, behaviorCount: 1 })], {
      baseline,
    });
    expect(result.challenges.some((c) => c.signal === 'historical-size')).toBe(false);
  });

  /**
   * Forty-eight tasks that are all low risk and touch no boundary get a challenge on both
   * uniformity signals.
   */
  it('Assess_48TasksUniformLowNoBoundary_ChallengesRiskAndBoundary', () => {
    const result = assessDecompositionPlausibility(uniformFleet(48, 'low', false));
    expect(result.challenged).toBe(true);
    const signals = result.challenges.map((c) => c.signal);
    expect(signals).toContain('risk-uniformity');
    expect(signals).toContain('boundary-uniformity');
    const risk = result.challenges.find((c) => c.signal === 'risk-uniformity');
    expect(risk?.scope).toBe('plan');
    expect(risk?.observed).toBe(48);
  });

  /** A 3-task plan is below the uniformity threshold of 10, so all of its tasks can be low risk. */
  it('Assess_SmallUniformLowPlan_NotChallenged', () => {
    const result = assessDecompositionPlausibility(uniformFleet(3, 'low', false));
    expect(result.challenges.some((c) => c.signal === 'risk-uniformity')).toBe(false);
    expect(result.challenges.some((c) => c.signal === 'boundary-uniformity')).toBe(false);
  });

  /**
   * An all-high plan is conservative, because a risk that is too high fails safe. Only an all-low
   * plan gets a risk challenge, and an all-true boundary stamp gets no boundary challenge.
   */
  it('Assess_LargeUniformHighPlan_RiskNotChallenged', () => {
    const result = assessDecompositionPlausibility(uniformFleet(48, 'high', true));
    expect(result.challenges.some((c) => c.signal === 'risk-uniformity')).toBe(false);
    expect(result.challenges.some((c) => c.signal === 'boundary-uniformity')).toBe(false);
  });

  /** A plan of small tasks with mixed risk tiers and mixed boundary stamps gets no challenge. */
  it('Assess_PlausibleMixedDecomposition_NoChallenge', () => {
    const tiers = ['low', 'medium', 'high'] as const;
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `T-${String(i + 1).padStart(2, '0')}`,
        files: [`src/mod${i}/file.ts`, `src/mod${i}/file.test.ts`],
        behaviorCount: 2,
        riskTier: tiers[i % 3],
        boundaryTouching: i % 4 === 0,
      }),
    );
    const result = assessDecompositionPlausibility(tasks);
    expect(result.challenged).toBe(false);
    expect(result.challenges).toHaveLength(0);
  });

  /** A non-empty rationale suppresses that one challenge and records it in `overridden` for audit. */
  it('Assess_TaskOverrideWithRationale_SuppressesChallenge', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts'];
    const result = assessDecompositionPlausibility([
      task({ files, overrides: { breadth: 'cross-cutting rename touches every module' } }),
    ]);
    expect(result.challenged).toBe(false);
    expect(result.challenges.some((c) => c.signal === 'breadth')).toBe(false);
    expect(result.overridden.map((c) => c.signal)).toContain('breadth');
    const overridden = result.overridden.find((c) => c.signal === 'breadth');
    expect(overridden?.overrideRationale).toBe('cross-cutting rename touches every module');
  });

  it('Assess_TaskOverrideMissing_DoesNotSuppress', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts'];
    const result = assessDecompositionPlausibility([task({ files })]);
    expect(result.challenged).toBe(true);
    expect(result.challenges.some((c) => c.signal === 'breadth')).toBe(true);
    expect(result.overridden).toHaveLength(0);
  });

  /** A rationale of only whitespace counts as empty. */
  it('Assess_TaskOverrideEmptyRationale_DoesNotSuppress', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts'];
    const result = assessDecompositionPlausibility([
      task({ files, overrides: { breadth: '   ' } }),
    ]);
    expect(result.challenged).toBe(true);
    expect(result.challenges.some((c) => c.signal === 'breadth')).toBe(true);
    expect(result.overridden).toHaveLength(0);
  });

  it('Assess_PlanOverrideWithRationale_SuppressesUniformityChallenge', () => {
    const result = assessDecompositionPlausibility(uniformFleet(48, 'low', false), {
      planOverrides: {
        'risk-uniformity': 'entire plan is mechanical doc-only copy edits',
        'boundary-uniformity': 'no task edits any public API surface',
      },
    });
    expect(result.challenged).toBe(false);
    expect(result.overridden.map((c) => c.signal).sort()).toEqual([
      'boundary-uniformity',
      'risk-uniformity',
    ]);
  });

  /** An override applies to one signal, so a risk-uniformity override keeps the boundary-uniformity challenge. */
  it('Assess_PlanOverrideOnlyRisk_BoundaryStillChallenged', () => {
    const result = assessDecompositionPlausibility(uniformFleet(48, 'low', false), {
      planOverrides: { 'risk-uniformity': 'mechanical copy edits' },
    });
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toEqual(['boundary-uniformity']);
    expect(result.overridden.map((c) => c.signal)).toEqual(['risk-uniformity']);
  });
});
