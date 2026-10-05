// What the secondary views take from telemetry.
//
// @oracle-sources: ../../../src/events/partition/view-dependence.ts, ../../../src/projections/views/handlers/materializer.ts
//
// The canonical differential bounds one fold. A secondary view can still derive a
// verdict from a telemetry event. This file measures that dependence for each view.
// The `telemetry` view folds telemetry by design, so a read is not a failure.
// Each measured dependence must have a declaration of kind `display` or `verdict`.
//
// The suite fails on a dependent view with no declaration and on a declared path that
// does not differ. It also fails on a declared view that is independent.
// The suite pins the `verdict` rows so that their set can only shrink.

import { describe, it, expect, vi } from 'vitest';
import { TELEMETRY_EVENTS } from '../../../src/events/partition/event-authority.js';
import {
  CLOCK_DEPENDENT_VIEW_PATHS,
  CORPUS_BLIND_READERS,
  VERDICT_BEARING_VIEWS,
  VIEW_TELEMETRY_DEPENDENCE,
} from '../../../src/events/partition/view-dependence.js';
import { EventTypes, type WorkflowEvent } from '../../../src/events/schemas.js';
import { REGISTERED_VIEWS } from '../../../src/projections/views/handlers/materializer.js';
import { buildAuthorityCorpus } from '../../../tools/test-helpers/authority-corpus.js';

const CORPUS = buildAuthorityCorpus('feat-view-dependence-corpus');
const GOVERNANCE_ONLY = CORPUS.filter((event) => !TELEMETRY_EVENTS.has(event.type));

/**
 * Returns the deepest state paths on which two folds differ.
 * A path names the field that changed, which a whole-state inequality cannot do.
 * A mismatch that is not between two plain objects stops the descent.
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
 * Folds with the wall clock held at a fixed instant.
 * A projection that reads `Date.now()` in `init()` makes its fold depend on the run time.
 * With the clock fixed, a path differs only because of the events.
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
 * Returns the paths whose value changes when only the clock changes.
 * The corpus is the same on both sides, and the two instants are fixed.
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

  /**
   * The denominator. With an empty partition, an empty roster, or a corpus that does not
   * discriminate, the differential measures no dependence.
   * An empty measurement equals an empty declaration table and proves nothing.
   */
  it('SecondaryViews_TheDifferentialCanSeeSomething_IsAsserted', () => {
    expect(TELEMETRY_EVENTS.size).toBeGreaterThan(0);
    expect(REGISTERED_VIEWS.length).toBeGreaterThan(0);
    expect(CORPUS).toHaveLength(EventTypes.length);
    expect(GOVERNANCE_ONLY.length).toBeLessThan(CORPUS.length);
    expect([...MEASURED.values()].filter((paths) => paths.length > 0).length).toBeGreaterThan(0);
  });

  /**
   * A `display` row claims that nothing gates on the value. This suite cannot check that claim.
   * It checks that each row carries a kind, a reason, and at least one path.
   */
  it.each(Object.entries(VIEW_TELEMETRY_DEPENDENCE))(
    'SecondaryViews_%sDeclaresAKindAndAReason',
    (_viewId, declared) => {
      expect(['display', 'verdict']).toContain(declared.kind);
      expect(declared.because.trim().length).toBeGreaterThan(0);
      expect(declared.paths.length).toBeGreaterThan(0);
    },
  );

  /**
   * The pinned `verdict` backlog. The list can only shrink.
   * To retire a verdict, re-source the view off the telemetry type. Do not relabel the row `display`.
   * The assertion reads the set that the partition derives, so the backlog has one definition.
   */
  it('SecondaryViews_TheVerdictBacklog_MayOnlyShrink', () => {
    expect([...VERDICT_BEARING_VIEWS].sort()).toEqual([
      'shepherd-status',
      'synthesis-readiness',
    ]);
  });

  /**
   * A blind row claims that the corpus cannot see a dependence that the source has.
   * If the view differs, the corpus has the correlation, and the row must become a declaration.
   */
  it.each(Object.keys(CORPUS_BLIND_READERS))(
    'SecondaryViews_%sIsStillBlindToTheCorpusNotIndependentOfTelemetry',
    (viewId) => {
      expect(MEASURED.get(viewId)).toEqual([]);
      expect(VIEW_TELEMETRY_DEPENDENCE[viewId]).toBeUndefined();
    },
  );

  /** Folds the same corpus at two instants. The paths that differ must equal the declared clock-dependent paths. */
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
