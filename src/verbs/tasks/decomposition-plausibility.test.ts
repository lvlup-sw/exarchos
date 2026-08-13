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
} from './decomposition-plausibility.js';

// ─── Signal primitive: breadth ────────────────────────────────────────────

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

  it('ComputeBreadth_BarePathAndEmpty_HandledGracefully', () => {
    expect(computeBreadth(['x.ts', '', 'y.ts'])).toBe(1); // both in '.'
    expect(computeBreadth([])).toBe(0);
  });
});

// ─── Signal primitive: behavior count ─────────────────────────────────────

describe('countBehaviors', () => {
  it('CountBehaviors_DistinctBehaviorTokens_CountsEach', () => {
    const block = [
      '- [RED] `Widget_Render_DisplaysContent`',
      '- [RED] `Widget_EmptyData_ShowsPlaceholder`',
      '- [RED] `Api_Fetch_ReturnsData`',
    ].join('\n');
    expect(countBehaviors(block)).toBe(3);
  });

  it('CountBehaviors_RepeatedBehaviorToken_DeduplicatesToOne', () => {
    // Same behavior appears in a [RED] step and a verification checklist line —
    // that is one behavior, not two.
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

// ─── Signal primitive: boundary-touching stamp ────────────────────────────

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

  it('ExtractBoundaryTouching_MalformedSuffix_ReturnsUndefined', () => {
    // `(?![\w-])` — a trailing word/hyphen char means it is not a clean stamp.
    expect(extractBoundaryTouching('**Boundary Touching:** false-ish maybe')).toBeUndefined();
  });
});

// ─── Signal primitive: override parsing ───────────────────────────────────

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

// ─── Baseline derivation ──────────────────────────────────────────────────

describe('deriveBaseline', () => {
  it('DeriveBaseline_LargeHistoricalSpread_RaisesThresholdAboveFloor', () => {
    const baseline = deriveBaseline({
      fileCounts: [2, 3, 4, 5, 6, 7, 8, 9, 10, 50],
      behaviorCounts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 30],
    });
    // p90 fileCount = 10, slack 2 → 20 (> floor 12)
    expect(baseline.maxFileCount).toBe(20);
    // p90 behaviorCount = 9, slack 2 → 18 (> floor 8)
    expect(baseline.maxBehaviorCount).toBe(18);
    // non-derived fields inherit the floor
    expect(baseline.maxBreadth).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxBreadth);
    expect(baseline.uniformityMinTasks).toBe(DEFAULT_PLAUSIBILITY_BASELINE.uniformityMinTasks);
  });

  it('DeriveBaseline_TinyHistoricalTasks_FloorsAtDefault', () => {
    const baseline = deriveBaseline({
      fileCounts: [1, 1, 2, 2, 3],
      behaviorCounts: [1, 1, 1, 2, 2],
    });
    // Derived values are below the floor, so the floor wins — a sample of tiny
    // tasks cannot produce an implausibly-strict threshold.
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

// ─── Assessment helpers ───────────────────────────────────────────────────

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

/** A calibrated 48-task fleet with the given uniform stamps. */
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
  // ── Per-task signals ──

  it('Assess_BroadTask_ChallengesBreadth', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts']; // breadth 5 > 4
    const result = assessDecompositionPlausibility([task({ files })]);
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toContain('breadth');
    const breadth = result.challenges.find((c) => c.signal === 'breadth');
    expect(breadth?.observed).toBe(5);
    expect(breadth?.threshold).toBe(DEFAULT_PLAUSIBILITY_BASELINE.maxBreadth);
    expect(breadth?.taskId).toBe('T-01');
  });

  it('Assess_ManyBehaviors_ChallengesBehaviorCount', () => {
    const result = assessDecompositionPlausibility([task({ behaviorCount: 9 })]); // > 8
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toContain('behavior-count');
  });

  it('Assess_OversizedTask_ChallengesHistoricalSize', () => {
    // Exit-proof (b): a task far larger than a historical task is challenged.
    const files = Array.from({ length: 20 }, (_, i) => `src/mod/file${i}.ts`); // 20 > 12
    const result = assessDecompositionPlausibility([task({ files, behaviorCount: 1 })]);
    expect(result.challenged).toBe(true);
    const size = result.challenges.find((c) => c.signal === 'historical-size');
    expect(size).toBeDefined();
    expect(size?.observed).toBe(20);
  });

  it('Assess_OversizedTask_NotChallengedUnderCalibratedBaseline', () => {
    // The historical-size signal is calibrated: a repo whose historical tasks
    // are large raises the bar, so the same 20-file task is NOT flagged.
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

  // ── Plan-level uniformity signals (exit-proof a) ──

  it('Assess_48TasksUniformLowNoBoundary_ChallengesRiskAndBoundary', () => {
    // Exit-proof (a): 48 tasks uniformly low-risk / no-boundary → structured
    // challenge on BOTH uniformity signals.
    const result = assessDecompositionPlausibility(uniformFleet(48, 'low', false));
    expect(result.challenged).toBe(true);
    const signals = result.challenges.map((c) => c.signal);
    expect(signals).toContain('risk-uniformity');
    expect(signals).toContain('boundary-uniformity');
    const risk = result.challenges.find((c) => c.signal === 'risk-uniformity');
    expect(risk?.scope).toBe('plan');
    expect(risk?.observed).toBe(48);
  });

  it('Assess_SmallUniformLowPlan_NotChallenged', () => {
    // Below the uniformity threshold: a 3-task plan legitimately can be all-low.
    const result = assessDecompositionPlausibility(uniformFleet(3, 'low', false));
    expect(result.challenges.some((c) => c.signal === 'risk-uniformity')).toBe(false);
    expect(result.challenges.some((c) => c.signal === 'boundary-uniformity')).toBe(false);
  });

  it('Assess_LargeUniformHighPlan_RiskNotChallenged', () => {
    // Blanket HIGH is conservative (over-calling risk fails safe) — only the
    // blanket-LOW under-call is challenged. Boundary=true is not the blanket
    // "nothing touches a boundary" pattern either.
    const result = assessDecompositionPlausibility(uniformFleet(48, 'high', true));
    expect(result.challenges.some((c) => c.signal === 'risk-uniformity')).toBe(false);
    expect(result.challenges.some((c) => c.signal === 'boundary-uniformity')).toBe(false);
  });

  // ── Plausible decomposition (exit-proof c) ──

  it('Assess_PlausibleMixedDecomposition_NoChallenge', () => {
    // Exit-proof (c): a well-decomposed, mixed-risk plan produces no challenge.
    const tiers = ['low', 'medium', 'high'] as const;
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `T-${String(i + 1).padStart(2, '0')}`,
        files: [`src/mod${i}/file.ts`, `src/mod${i}/file.test.ts`],
        behaviorCount: 2,
        riskTier: tiers[i % 3],
        boundaryTouching: i % 4 === 0, // some true, some false
      }),
    );
    const result = assessDecompositionPlausibility(tasks);
    expect(result.challenged).toBe(false);
    expect(result.challenges).toHaveLength(0);
  });

  // ── Override rationale (exit-proof d) ──

  it('Assess_TaskOverrideWithRationale_SuppressesChallenge', () => {
    // Exit-proof (d): an explicit non-empty rationale suppresses the specific
    // challenge but records it in `overridden` for auditability.
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts']; // breadth 5
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
    const result = assessDecompositionPlausibility([task({ files })]); // no overrides
    expect(result.challenged).toBe(true);
    expect(result.challenges.some((c) => c.signal === 'breadth')).toBe(true);
    expect(result.overridden).toHaveLength(0);
  });

  it('Assess_TaskOverrideEmptyRationale_DoesNotSuppress', () => {
    const files = ['a/1.ts', 'b/2.ts', 'c/3.ts', 'd/4.ts', 'e/5.ts'];
    const result = assessDecompositionPlausibility([
      task({ files, overrides: { breadth: '   ' } }), // whitespace-only
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

  it('Assess_PlanOverrideOnlyRisk_BoundaryStillChallenged', () => {
    // An override is per-signal: overriding risk-uniformity does NOT suppress
    // the independent boundary-uniformity challenge.
    const result = assessDecompositionPlausibility(uniformFleet(48, 'low', false), {
      planOverrides: { 'risk-uniformity': 'mechanical copy edits' },
    });
    expect(result.challenged).toBe(true);
    expect(result.challenges.map((c) => c.signal)).toEqual(['boundary-uniformity']);
    expect(result.overridden.map((c) => c.signal)).toEqual(['risk-uniformity']);
  });
});
