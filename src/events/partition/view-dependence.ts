/**
 * What the secondary views take from telemetry.
 *
 * The canonical differential proves only that the canonical fold ignores telemetry. A
 * secondary view can still derive a verdict from a telemetry event. This module declares
 * each such dependence with a kind:
 *
 * - `display`: the view shows, counts, or attributes the value. Nothing gates on it.
 * - `verdict`: the value is an input to a decision that the view computes.
 *
 * The list of `verdict` rows can only shrink. An undeclared dependence fails.
 */

/** How a view's value stands to the telemetry it folds. */
export type DependenceKind = 'display' | 'verdict';

/** One view's declared dependence on the telemetry partition. */
export interface ViewTelemetryDependence {
  readonly kind: DependenceKind;
  /**
   * The state paths that differ when telemetry is dropped, exactly as the differential
   * reports them. A listed path that does not differ is dead cover, and the check names it.
   */
  readonly paths: readonly string[];
  readonly because: string;
}

/**
 * The declared dependences, keyed by view id.
 *
 * A view absent from this table must fold independently of telemetry. A view
 * present must differ on exactly these paths. Both directions are asserted, so
 * a new dependence and a stale declaration each fail by name.
 */
export const VIEW_TELEMETRY_DEPENDENCE: Readonly<
  Record<string, ViewTelemetryDependence>
> = Object.freeze({
  telemetry: {
    kind: 'display',
    paths: [
      /**
       * Per-field paths, because `tool.budget_exceeded` is governance and creates the
       * per-tool entry on both sides. `budgetExceeded` is the same on both sides. If
       * `tool.budget_exceeded` becomes telemetry, these paths collapse to `tools.sample-tool`.
       */
      'tools.sample-tool.actionErrorBreakdown.sample-errorCode',
      'tools.sample-tool.actionErrors',
      'tools.sample-tool.durations',
      'tools.sample-tool.errors',
      'tools.sample-tool.invocations',
      'tools.sample-tool.p50Bytes',
      'tools.sample-tool.p50DurationMs',
      'tools.sample-tool.p50Tokens',
      'tools.sample-tool.p95Bytes',
      'tools.sample-tool.p95DurationMs',
      'tools.sample-tool.p95Tokens',
      'tools.sample-tool.sizes',
      'tools.sample-tool.tokenEstimates',
      'tools.sample-tool.totalBytes',
      'tools.sample-tool.totalDurationMs',
      'tools.sample-tool.totalTokens',
      'totalInvocations',
      'totalTokens',
      'turns',
    ],
    because:
      'The view whose entire purpose is to fold the per-tool and per-turn records. ' +
      'Its independence would mean the telemetry partition folds nowhere at all.',
  },
  'team-performance': {
    kind: 'display',
    paths: ['teammates.sample-teammateName.subagentRuns'],
    because:
      'Token attribution per teammate. A run count and a token total, reported; ' +
      'no gate, guard or transition reads them.',
  },
  'code-quality': {
    kind: 'display',
    /**
     * One field, because `ci.check_observed` is governance and creates the skill entry
     * on both sides. The pass-rate fields survive a telemetry drop.
     */
    paths: ['skills.sample-skill.avgRemediationAttempts'],
    because:
      'Per-skill remediation metrics. Displayed by `view quality`; nothing decides on them.',
  },
  'synthesis-readiness': {
    kind: 'verdict',
    paths: [
      'blockers',
      'review.findingsBySeverity.critical',
      'tests.lastRunPassed',
      'tests.typecheckPassed',
      'tests.coveragePercent',
    ],
    because:
      '`computeReadiness` pushes "tests not passing" and "typecheck not passing" from ' +
      '`test.result` and `typecheck.result`, and "review not passed" from `review.finding` — ' +
      'all three telemetry-tier. `blockers` is the verdict, and `ready` is empty(blockers). ' +
      'Note the differential discriminates `blockers` but not `ready`: a corpus of one event ' +
      'per type never completes its tasks, so `ready` is false on both sides. The dependence ' +
      'is real either way — the content of the conclusion moves.',
  },
  'shepherd-status': {
    kind: 'verdict',
    paths: ['prs'],
    because:
      '`computeOverallStatus` reads `state.prs` through `hasBlockedPr`, `hasFailingCi` and ' +
      '`isAllHealthy`, and the per-PR counters it tests are fed by `review.finding`, ' +
      '`review.escalated`, `comment.posted` and `comment.resolved`. Dropping them reports a ' +
      'stack healthy that is not.',
  },
});

/**
 * View state paths that come from the wall clock, not from the events. Two folds of the
 * same corpus disagree on them, so every measurement subtracts them.
 *
 * A reducer that reads the clock is not a left-fold over the log, and replay cannot
 * reproduce it. This list can only SHRINK. A path leaves when an event carries its value.
 */
export const CLOCK_DEPENDENT_VIEW_PATHS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    telemetry: ['sessionStart'],
  });

/**
 * Views that read a telemetry type in source but fold independently of it under the
 * corpus of the differential. This is NOT a clean bill.
 *
 * The corpus holds one event of each type with sampled payloads, so its identifiers do
 * not correlate. A handler that resolves an id first finds no match and returns the
 * state unchanged. When the corpus builds the correlation, the view moves to
 * {@link VIEW_TELEMETRY_DEPENDENCE}.
 */
export const CORPUS_BLIND_READERS: Readonly<Record<string, string>> = Object.freeze({
  'delegation-timeline':
    'Folds `subagent.tokens_used`, whose arm resolves `data.taskId` against tasks the ' +
    'view already tracks and ignores a miss by contract ("No matching task → ignore"). ' +
    'The sampled payload names no task the corpus created.',
  'delegation-readiness':
    'Folds `worktree.baseline`, whose arm keys on a worktree the corpus never created ' +
    'under the sampled identifier.',
});

/**
 * The views whose VERDICT moves when telemetry is dropped. The set derives from
 * {@link VIEW_TELEMETRY_DEPENDENCE}, so no second list can disagree with it.
 */
export const VERDICT_BEARING_VIEWS: ReadonlySet<string> = new Set(
  Object.entries(VIEW_TELEMETRY_DEPENDENCE)
    .filter(([, declared]) => declared.kind === 'verdict')
    .map(([viewId]) => viewId),
);

/**
 * Throws at load when the declarations contradict themselves. A view in both
 * {@link VIEW_TELEMETRY_DEPENDENCE} and {@link CORPUS_BLIND_READERS} makes opposite
 * claims. A row with no paths matches an empty measurement and proves nothing.
 */
export function assertViewDependenceDeclarations(): void {
  const contradictory = Object.keys(VIEW_TELEMETRY_DEPENDENCE).filter(
    (viewId) => viewId in CORPUS_BLIND_READERS,
  );
  if (contradictory.length > 0) {
    throw new Error(
      `view-dependence: ${contradictory.join(', ')} declared BOTH a telemetry ` +
        'dependence and corpus blindness — the two claims are opposites',
    );
  }
  const pathless = Object.entries(VIEW_TELEMETRY_DEPENDENCE)
    .filter(([, declared]) => declared.paths.length === 0)
    .map(([viewId]) => viewId);
  if (pathless.length > 0) {
    throw new Error(
      `view-dependence: ${pathless.join(', ')} declared a dependence on no paths — ` +
        'an empty declaration matches an empty measurement and proves nothing',
    );
  }
}

assertViewDependenceDeclarations();
