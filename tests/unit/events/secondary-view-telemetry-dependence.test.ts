// ─── What the secondary views take from telemetry, measured ─────────────────
//
// @oracle-sources: ../../../src/events/partition/view-dependence.ts, ../../../src/projections/views/handlers/materializer.ts
//
// The canonical differential bounds one fold. Its own header states the limit it
// leaves open: a secondary view can derive a verdict from a telemetry event
// without the canonical fold noticing. This closes that.
//
// The shape is a differential, not a prohibition. Running the canonical
// assertion over every view would be red by design — the `telemetry` view exists
// to fold telemetry — so the question asked here is not whether a view READS
// telemetry but whether anything DECIDES on what it read. Each measured
// dependence must be declared, and declared as `display` or `verdict`.
//
// Three ways this fails, and each names the thing that moved:
//
//   • a view that folds telemetry with no declaration — the new verdict surface
//     nobody noticed;
//   • a declaration whose paths no longer differ — dead cover;
//   • a declared view that has gone independent — the declaration outlived the
//     dependence and should be deleted.
//
// The `verdict` rows are the open charter tension, not a bug this file fixes.
// They are pinned so the set can only shrink.

import { describe, it, expect, vi } from 'vitest';
import { TELEMETRY_EVENTS } from '../../../src/events/partition/event-authority.js';
import {
  CLOCK_DEPENDENT_VIEW_PATHS,
  CORPUS_BLIND_READERS,
  VIEW_TELEMETRY_DEPENDENCE,
} from '../../../src/events/partition/view-dependence.js';
import { EventTypes, type WorkflowEvent } from '../../../src/events/schemas.js';
import { REGISTERED_VIEWS } from '../../../src/projections/views/handlers/materializer.js';
import { buildAuthorityCorpus } from '../../../tools/test-helpers/authority-corpus.js';

const CORPUS = buildAuthorityCorpus('feat-view-dependence-corpus');
const GOVERNANCE_ONLY = CORPUS.filter((event) => !TELEMETRY_EVENTS.has(event.type));

/**
 * The state paths on which two folds differ, deepest-first.
 *
 * Paths rather than a whole-state inequality, because "this view changed" is not
 * actionable and "this view's verdict field changed" is. A leaf that differs is
 * reported at its own path; a non-object mismatch stops the descent.
 */
function differingPaths(left: unknown, right: unknown, prefix = ''): readonly string[] {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  const bothPlainObjects =
    left !== null &&
    right !== null &&
    typeof left === 'object' &&
    typeof right === 'object' &&
    !Array.isArray(left) &&
    !Array.isArray(right);
  if (!bothPlainObjects) return [prefix === '' ? '<root>' : prefix];
  const keys = new Set([
    ...Object.keys(left as Record<string, unknown>),
    ...Object.keys(right as Record<string, unknown>),
  ]);
  return [...keys].flatMap((key) =>
    differingPaths(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
      prefix === '' ? key : `${prefix}.${key}`,
    ),
  );
}

/**
 * Fold with the wall clock held at a fixed instant.
 *
 * A projection that reads `Date.now()` in `init()` makes its own fold a function
 * of when it ran. Holding the clock removes that variable from the differential
 * entirely, so a path that still differs differs because of the EVENTS. Racing
 * two real-clock folds and subtracting what moved would measure the scheduler,
 * not the reducer — and would pass or fail on whether the millisecond happened
 * to turn over mid-test.
 */
function foldAt(
  instant: string,
  fold: (events: readonly WorkflowEvent[]) => unknown,
  events: readonly WorkflowEvent[],
): unknown {
  vi.useFakeTimers({ now: new Date(instant) });
  try {
    return fold(events);
  } finally {
    vi.useRealTimers();
  }
}

const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2027-06-15T12:34:56.000Z';

function measureDependence(fold: (events: readonly WorkflowEvent[]) => unknown): readonly string[] {
  return [...differingPaths(foldAt(AT, fold, CORPUS), foldAt(AT, fold, GOVERNANCE_ONLY))].sort();
}

/**
 * Paths whose value moves when only the CLOCK moves — the corpus is identical
 * on both sides. Deterministic by construction: the two instants are chosen, not
 * raced.
 */
function clockDependentPaths(
  fold: (events: readonly WorkflowEvent[]) => unknown,
): readonly string[] {
  return [...differingPaths(foldAt(AT, fold, CORPUS), foldAt(LATER, fold, CORPUS))].sort();
}

const MEASURED: ReadonlyMap<string, readonly string[]> = new Map(
  REGISTERED_VIEWS.map((view) => [view.id, measureDependence(view.fold)] as const),
);

describe('secondary-view telemetry dependence', () => {
  it('SecondaryViews_TheMeasuredDependentSet_IsExactlyTheDeclaredSet', () => {
    const measuredDependent = [...MEASURED.entries()]
      .filter(([, paths]) => paths.length > 0)
      .map(([viewId]) => viewId)
      .sort();
    expect(measuredDependent).toEqual(Object.keys(VIEW_TELEMETRY_DEPENDENCE).sort());
  });

  it.each(Object.entries(VIEW_TELEMETRY_DEPENDENCE))(
    'SecondaryViews_%sDiffersOnExactlyItsDeclaredPaths',
    (viewId, declared) => {
      expect(MEASURED.get(viewId)).toEqual([...declared.paths].sort());
    },
  );

  // The denominator. A corpus that stopped discriminating, a partition that went
  // empty, or a roster that stopped enumerating would each turn every assertion
  // above into a vacuous pass — all three sets would be empty and all three
  // equalities would hold.
  it('SecondaryViews_TheDifferentialCanSeeSomething_IsAsserted', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);
    expect(REGISTERED_VIEWS.length).toBeGreaterThan(0);
    expect(CORPUS).toHaveLength(EventTypes.length);
    expect(GOVERNANCE_ONLY.length).toBeLessThan(CORPUS.length);
    expect([...MEASURED.values()].filter((paths) => paths.length > 0).length).toBeGreaterThan(0);
  });

  // A `display` row is a claim that nothing gates on the value. That claim is
  // not machine-checkable here, so what IS checked is that the claim was made
  // deliberately: every row carries a kind and a reason.
  it.each(Object.entries(VIEW_TELEMETRY_DEPENDENCE))(
    'SecondaryViews_%sDeclaresAKindAndAReason',
    (_viewId, declared) => {
      expect(['display', 'verdict']).toContain(declared.kind);
      expect(declared.because.trim().length).toBeGreaterThan(0);
      expect(declared.paths.length).toBeGreaterThan(0);
    },
  );

  // The charter tension, pinned. This list may only SHRINK: a verdict is
  // retired by re-sourcing the view off the telemetry type, never by relabeling
  // the row `display`.
  it('SecondaryViews_TheVerdictBacklog_MayOnlyShrink', () => {
    const verdicts = Object.entries(VIEW_TELEMETRY_DEPENDENCE)
      .filter(([, declared]) => declared.kind === 'verdict')
      .map(([viewId]) => viewId)
      .sort();
    expect(verdicts).toEqual(['shepherd-status', 'synthesis-readiness']);
  });

  // A blind row claims the corpus cannot see a dependence the source plainly
  // has. If the view starts differing, the corpus grew the correlation and the
  // row is now a lie — it must move to a declaration instead.
  it.each(Object.keys(CORPUS_BLIND_READERS))(
    'SecondaryViews_%sIsStillBlindToTheCorpusNotIndependentOfTelemetry',
    (viewId) => {
      expect(MEASURED.get(viewId)).toEqual([]);
      expect(VIEW_TELEMETRY_DEPENDENCE[viewId]).toBeUndefined();
    },
  );

  // The subtraction above is only honest if the declared non-determinism is
  // real and complete. Measured directly: fold the same corpus twice.
  it('SecondaryViews_TheClockDependentPaths_AreExactlyThoseDeclared', () => {
    const measured = Object.fromEntries(
      REGISTERED_VIEWS.map((view) => [view.id, [...clockDependentPaths(view.fold)].sort()]).filter(
        ([, paths]) => (paths as string[]).length > 0,
      ),
    );
    const declared = Object.fromEntries(
      Object.entries(CLOCK_DEPENDENT_VIEW_PATHS).map(([id, paths]) => [id, [...paths].sort()]),
    );
    expect(measured).toEqual(declared);
  });

  it('SecondaryViews_EveryDeclaredAndBlindViewIsRegistered', () => {
    const registered = new Set(REGISTERED_VIEWS.map((view) => view.id));
    for (const viewId of [
      ...Object.keys(VIEW_TELEMETRY_DEPENDENCE),
      ...Object.keys(CORPUS_BLIND_READERS),
    ]) {
      expect(registered.has(viewId)).toBe(true);
    }
  });
});
