/**
 * Golden-log replay corpus across a schema version bump.
 *
 * The corpus is a pinned event log at version `0.9`. With a migration from `0.9` to the current
 * version, a replay through `migrateEvents` folds to the same view as a current-version log.
 * `diffStates` pins the inverse: with no migration, the fold sees the old shape. The delta
 * between the two folds is exactly the fields that the migration rewrites.
 *
 * The tests call `migrateEvents(corpus, fixtureMigrations)` directly, because the module registry
 * `eventMigrations` is empty. A live `EventStore.query` thus has no migration to apply.
 */
import { describe, it, expect } from 'vitest';
import { migrateEvents, EVENT_SCHEMA_VERSION, type EventMigration } from '../../../src/events/event-migration.js';
import { diffStates } from '../../../src/projections/diff-states.js';

/**
 * A log at version `0.9`: a task row holds its label in `data.name`. The migration moves the
 * label to `data.title`.
 */
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

/**
 * The migration from `0.9` to the current version. It renames `data.name` to `data.title` and
 * stamps the current `schemaVersion`.
 */
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

interface ReplayView {
  count: number;
  titles: Array<string | undefined>;
}
/** A small reducer that reads the current shape, `data.title`. */
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

/** The view that a current-version log folds to. */
const GOLDEN_VIEW: ReplayView = { count: 2, titles: ['first task', 'second task'] };

describe('Golden-log replay across a version bump (#1556)', () => {
  /** Each replayed row must also hold the current schema version. */
  it('GoldenLogV09_ReplayedWithMigration_FoldsToGoldenView', () => {
    const migrated = migrateEvents(GOLDEN_LOG_V09, [RENAME_NAME_TO_TITLE]);
    const view = foldTaskTitles(migrated);

    expect(view).toEqual(GOLDEN_VIEW);
    for (const e of migrated) {
      expect(e.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
    }
  });

  /**
   * The `0.9` shape holds `data.name` and not `data.title`, so a reducer for the current shape
   * sees undefined titles. This is the control: the golden view of the first test comes from the
   * migration and not from the reducer.
   */
  it('GoldenLogV09_WithoutMigration_FoldsToEmptyTitles', () => {
    const raw = migrateEvents(GOLDEN_LOG_V09, []);
    const view = foldTaskTitles(raw);

    expect(view.count).toBe(2);
    expect(view.titles).toEqual([undefined, undefined]);
  });

  /**
   * The only changes are the two title leaves, from `undefined` to a value. `count` does not
   * change.
   */
  it('GoldenLog_PreVsPostMigration_DiffStatesIsolatesExactlyTheTitles', () => {
    const before = foldTaskTitles(migrateEvents(GOLDEN_LOG_V09, []));
    const after = foldTaskTitles(migrateEvents(GOLDEN_LOG_V09, [RENAME_NAME_TO_TITLE]));

    const delta = diffStates(before, after);

    expect(delta.changed).toEqual({
      'titles.0': { from: undefined, to: 'first task' },
      'titles.1': { from: undefined, to: 'second task' },
    });
    expect(delta.added).toEqual({});
    expect(delta.removed).toEqual({});
  });
});
