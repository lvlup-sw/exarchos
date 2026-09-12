// ─── What the secondary views take from telemetry ───────────────────────────
//
// The canonical differential asserts one thing: drop every telemetry event and
// the canonical workflow-state fold answers the same. That bounds what a
// retention policy may drop from THAT fold, and its own header says so — a
// secondary view can derive a verdict from a telemetry event without the
// canonical fold noticing.
//
// This module is the declaration that closes the gap. A differential over every
// view would be red by design, because views like `telemetry` exist precisely to
// consume telemetry; the question is never whether a view reads telemetry, but
// whether something DECIDES on what it read.
//
// So each dependence is declared with a kind:
//
//   • `display`  — the value is shown, counted or attributed. Nothing gates on
//     it. Dropping the telemetry costs a number on a screen.
//   • `verdict`  — the value is an input to a decision the view itself computes.
//     Dropping the telemetry changes what the view CONCLUDES, and a reader of
//     that conclusion is reading a fact the partition says is droppable.
//
// `verdict` rows are the charter tension. They are not violations to fix here —
// re-sourcing `synthesis-readiness` off `test.result` is its own change — but
// they must be named, pinned, and allowed only to shrink. An undeclared
// dependence is the failure this exists to catch.

/** How a view's value stands to the telemetry it folds. */
export type DependenceKind = 'display' | 'verdict';

/** One view's declared dependence on the telemetry partition. */
export interface ViewTelemetryDependence {
  readonly kind: DependenceKind;
  /**
   * The state paths that differ when telemetry is dropped, exactly as the
   * differential reports them. Measured, then transcribed here — a path that
   * stops differing is dead cover and is named as such.
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
      // Per-FIELD rather than the whole `tools.sample-tool` object, and the
      // reason is worth keeping: `tool.budget_exceeded` is GOVERNANCE, so it
      // survives the telemetry-dropped fold and creates the per-tool entry on
      // both sides. The difference is therefore what the telemetry rows fill
      // IN that entry, which is a sharper statement than "the entry is gone".
      // `budgetExceeded` is absent from this list for the same reason — it is
      // identical on both sides. If that type is ever demoted to telemetry,
      // these collapse back to `tools.sample-tool` and this test says so.
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
    // Narrowed from the whole `skills.sample-skill` object for the same reason
    // the telemetry rows narrowed: `ci.check_observed` is governance and
    // creates the skill entry on both sides, so what remains is the one field
    // only telemetry fills. That the pass-rate fields do NOT appear is the
    // measurement worth having — the skill's outcome numbers survive a
    // telemetry drop, and only the remediation average does not.
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
 * View state paths whose value does not come from the events at all.
 *
 * A differential subtracts one fold from another, and that subtraction is only
 * meaningful if the fold is a function of its input. These paths are not: they
 * are read from the wall clock, so two folds of the SAME corpus disagree
 * whenever the millisecond turns over between them.
 *
 * They are declared, subtracted from every measurement, and pinned — because
 * the alternative is an oracle that reports a telemetry dependence at midnight
 * and none at noon. Subtracting them is a concession to a defect, not a
 * blessing of it: a reducer that reads the clock is not a left-fold over the
 * log, which every read-model must be, and a replay of the same stream
 * cannot reproduce it.
 *
 * This list may only SHRINK. A path leaves it by moving its value onto the
 * event that should have carried it.
 */
export const CLOCK_DEPENDENT_VIEW_PATHS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    telemetry: ['sessionStart'],
  });

/**
 * Views that read a telemetry type in source but fold independently of it under
 * the differential's corpus.
 *
 * This is NOT a clean bill. It is the corpus admitting what it cannot see, and
 * it is declared rather than inferred so the blindness has a name. The cause in
 * both rows below is the same: the corpus is one event of every type with
 * per-schema sampled payloads, so its identifiers do not CORRELATE. A handler
 * that resolves an id before it mutates finds nothing to match and returns the
 * state unchanged — not because the type is droppable, but because the corpus
 * never built the row it would have updated.
 *
 * A row here is a promise about the corpus, not about the view. Removing one
 * means the corpus grew the correlation, and the view then owes a declaration
 * above.
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
 * The views whose VERDICT moves when telemetry is dropped.
 *
 * Derived, never listed: the backlog shrinks by re-sourcing a view off the
 * telemetry type and changing its row, and a second hand-maintained list would
 * be free to disagree with the first.
 */
export const VERDICT_BEARING_VIEWS: ReadonlySet<string> = new Set(
  Object.entries(VIEW_TELEMETRY_DEPENDENCE)
    .filter(([, declared]) => declared.kind === 'verdict')
    .map(([viewId]) => viewId),
);

/**
 * Refuse a declaration set that contradicts itself, at load.
 *
 * The two tables make OPPOSITE claims about a view: one says the differential
 * sees a dependence, the other says it cannot. A view in both is not a stricter
 * declaration, it is an unreadable one, and the oracle would report whichever
 * assertion happened to run first.
 *
 * A row with no paths is the other shape: a dependence declared on nothing,
 * which passes the equality check against an empty measurement and so declares
 * cover it does not hold.
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
