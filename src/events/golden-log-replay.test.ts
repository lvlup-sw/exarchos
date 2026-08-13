/**
 * Golden-log replay corpus across a schema version bump (#1556, task 1556-4).
 *
 * Pins a historical-version (`0.9`) event log and proves that, once a
 * `0.9 → current` migration is registered, replaying that log through the
 * read-time upcasting seam (`migrateEvents`) folds to the SAME golden view a
 * native current-version log would. This is the regression corpus that must
 * keep replaying green across every future `EVENT_SCHEMA_VERSION` bump.
 *
 * `diffStates` (#1555) pins the inverse property: WITHOUT the migration the
 * fold observes the un-upcast shape, and the delta between the two folds is
 * EXACTLY the field(s) the migration rewrites — nothing more leaks.
 *
 * The corpus is folded through `migrateEvents(corpus, fixtureMigrations)`
 * directly (rather than a live `EventStore.query`, whose module-const
 * `eventMigrations` is empty today) so the behavioural upcasting property is
 * provable now, before the first real migration registers.
 */
import { describe, it, expect } from 'vitest';
import { migrateEvents, EVENT_SCHEMA_VERSION, type EventMigration } from './event-migration.js';
import { diffStates } from '../projections/diff-states.js';

// ─── Pinned historical corpus (schemaVersion '0.9') ─────────────────────────
// A '0.9'-era log: task rows carry their human label under `data.name`. The
// `0.9 → current` rename moves it to `data.title`.
const GOLDEN_LOG_V09: ReadonlyArray<Record<string, unknown>> = [
  {
    streamId: 'feat-golden',
    sequence: 1,
    type: 'workflow.started',
    schemaVersion: '0.9',
    timestamp: '2025-01-01T00:00:00.000Z',
    data: { featureId: 'feat-golden', workflowType: 'feature' },
  },
  {
    streamId: 'feat-golden',
    sequence: 2,
    type: 'task.assigned',
    schemaVersion: '0.9',
    timestamp: '2025-01-01T00:01:00.000Z',
    data: { taskId: 't1', name: 'first task' },
  },
  {
    streamId: 'feat-golden',
    sequence: 3,
    type: 'task.assigned',
    schemaVersion: '0.9',
    timestamp: '2025-01-01T00:02:00.000Z',
    data: { taskId: 't2', name: 'second task' },
  },
];

// The `0.9 → current` migration: rename `data.name` → `data.title`, stamp the
// current schemaVersion.
const RENAME_NAME_TO_TITLE: EventMigration = {
  from: '0.9',
  to: EVENT_SCHEMA_VERSION,
  eventTypes: 'all',
  migrate: (e) => {
    const data = { ...(e.data as Record<string, unknown> | undefined) };
    if ('name' in data) {
      data.title = data.name;
      delete data.name;
    }
    return { ...e, schemaVersion: EVENT_SCHEMA_VERSION, data };
  },
};

// ─── A tiny reducer that reads the CURRENT (`data.title`) shape ─────────────
interface ReplayView {
  count: number;
  titles: Array<string | undefined>;
}
function foldTaskTitles(events: ReadonlyArray<Record<string, unknown>>): ReplayView {
  return events.reduce<ReplayView>(
    (view, e) => {
      if (e.type !== 'task.assigned') return view;
      const data = e.data as { title?: string } | undefined;
      return { count: view.count + 1, titles: [...view.titles, data?.title] };
    },
    { count: 0, titles: [] },
  );
}

// The golden view a native current-version log folds to.
const GOLDEN_VIEW: ReplayView = { count: 2, titles: ['first task', 'second task'] };

describe('Golden-log replay across a version bump (#1556)', () => {
  it('GoldenLogV09_ReplayedWithMigration_FoldsToGoldenView', () => {
    const migrated = migrateEvents(GOLDEN_LOG_V09, [RENAME_NAME_TO_TITLE]);
    const view = foldTaskTitles(migrated);

    expect(view).toEqual(GOLDEN_VIEW);
    // Every replayed row now carries the current schema version — a snapshot
    // taken over this fold would pass schemaVersion validation, whereas a
    // snapshot over the raw '0.9' log invalidates (snapshot-store.ts), forcing
    // a clean rebuild THROUGH the upcaster.
    for (const e of migrated) {
      expect(e.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    }
  });

  it('GoldenLogV09_WithoutMigration_FoldsToEmptyTitles', () => {
    // The un-upcast '0.9' shape carries `data.name`, not `data.title`, so a
    // current-shape reducer observes undefined titles. This is the failure the
    // migration repairs — pinned so a regression that silently drops upcasting
    // is caught.
    const raw = migrateEvents(GOLDEN_LOG_V09, []); // identity (no migrations)
    const view = foldTaskTitles(raw);

    expect(view.count).toBe(2);
    expect(view.titles).toEqual([undefined, undefined]);
  });

  it('GoldenLog_PreVsPostMigration_DiffStatesIsolatesExactlyTheTitles', () => {
    const before = foldTaskTitles(migrateEvents(GOLDEN_LOG_V09, []));
    const after = foldTaskTitles(migrateEvents(GOLDEN_LOG_V09, [RENAME_NAME_TO_TITLE]));

    const delta = diffStates(before, after);

    // The ONLY changes are the two title leaves moving from undefined → value.
    // count is unchanged; nothing else leaks.
    expect(delta.changed).toEqual({
      'titles.0': { from: undefined, to: 'first task' },
      'titles.1': { from: undefined, to: 'second task' },
    });
    expect(delta.added).toEqual({});
    expect(delta.removed).toEqual({});
  });
});
