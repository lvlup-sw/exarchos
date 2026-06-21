/** Current event schema version. Events at this version are returned as-is. */
export const EVENT_SCHEMA_VERSION = '1.0';

/** Describes a versioned event migration. */
export interface EventMigration {
  readonly from: string;
  readonly to: string;
  /** Which event types this migration applies to, or 'all' for universal. */
  readonly eventTypes: readonly string[] | 'all';
  /** Transform a raw event from one schema version to the next. */
  migrate: (event: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Registry of event migrations. Add new migrations here when the event schema evolves.
 * Migrations are applied in chain order: 1.0 → 1.1 → 1.2, etc.
 *
 * NOTE: This registry tracks per-event payload `schemaVersion` (string,
 * e.g. '1.0'), independent of the SQLite DDL `SCHEMA_VERSION` integer in
 * `storage/sqlite-backend.ts`. The durable-substrate plan's V2 -> V3
 * migration is a SQLite DDL transition (T01) — see `migrateV2ToV3` in
 * `sqlite-backend.ts`. T12 will register the first per-event tolerant
 * deserialization migration here once new event types (T02-T04) are
 * appended under V3.
 */
export const eventMigrations: readonly EventMigration[] = [
  // Future migrations go here. Example:
  // {
  //   from: '1.0', to: '1.1',
  //   eventTypes: ['task.completed'],
  //   migrate: (e) => ({ ...e, schemaVersion: '1.1', data: { ...e.data, duration: 0 } }),
  // },
];

/**
 * Migrate a raw event to the current schema version.
 * Returns the event as-is if already at current version or if no migration path exists
 * (forward compatibility — old code tolerates new event versions by ignoring unknown fields).
 */
export function migrateEvent(
  raw: Record<string, unknown>,
  migrations: readonly EventMigration[] = eventMigrations,
): Record<string, unknown> {
  const version = (raw.schemaVersion as string) ?? '1.0';
  if (version === EVENT_SCHEMA_VERSION) return raw;

  let current = { ...raw };
  let currentVersion = version;
  const maxIterations = migrations.length + 1;
  let iterations = 0;

  while (currentVersion !== EVENT_SCHEMA_VERSION) {
    if (iterations >= maxIterations) {
      // No complete path — return as-is for forward compatibility
      return current;
    }

    const migration = migrations.find(
      (m) =>
        m.from === currentVersion &&
        (m.eventTypes === 'all' || m.eventTypes.includes(current.type as string)),
    );

    if (!migration) {
      // No migration path — return as-is (forward compat)
      return current;
    }

    current = migration.migrate(current);
    currentVersion = migration.to;
    iterations++;
  }

  return current;
}

/**
 * Batch read-time upcasting seam (#1556).
 *
 * `EventStore.query` / `queryByType` route every backend row through here so a
 * registered migration is applied uniformly to *every* reader (rehydrate,
 * reconcile, views, `resolveWorkflowState`). This is the single choke point
 * the no-bypass CI gate enforces — no reader constructs a `WorkflowEvent` from
 * a raw backend row outside it.
 *
 * Identity-preserving fast path: with no migrations registered (the state
 * today, `eventMigrations === []`), the *same array reference* and every
 * element reference are returned unchanged, so the hot read path stays
 * allocation-free until read-time schema evolution is actually needed. The
 * moment a migration registers, the map fires and old rows fold upcasted.
 */
export function migrateEvents<T extends Record<string, unknown>>(
  events: readonly T[],
  migrations: readonly EventMigration[] = eventMigrations,
): T[] {
  if (migrations.length === 0) {
    return events as T[];
  }
  return events.map((e) => migrateEvent(e, migrations) as T);
}

/**
 * Build-time version-coverage assertion (#1556 structural guard b).
 *
 * Every per-event `schemaVersion` strictly below `currentVersion` that appears
 * as a migration `from` must chain all the way to `currentVersion`; a dangling
 * source version (a migration whose `to` no version can continue from, while
 * still below current) means a reader could observe an event it cannot upcast.
 * Bumping `EVENT_SCHEMA_VERSION` or adding a migration without completing the
 * chain throws here, failing the build before the gap reaches production.
 *
 * @throws Error listing the version(s) with no path to `currentVersion`.
 */
export function assertMigrationCoverage(
  currentVersion: string = EVENT_SCHEMA_VERSION,
  migrations: readonly EventMigration[] = eventMigrations,
): void {
  // Forward edges: from -> set of reachable next versions.
  const edges = new Map<string, Set<string>>();
  for (const m of migrations) {
    if (!edges.has(m.from)) edges.set(m.from, new Set());
    edges.get(m.from)!.add(m.to);
  }

  const reaches = (from: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const v = stack.pop()!;
      if (v === currentVersion) return true;
      if (seen.has(v)) continue;
      seen.add(v);
      for (const next of edges.get(v) ?? []) stack.push(next);
    }
    return false;
  };

  // Every declared source version below current must reach current.
  const sources = new Set<string>(migrations.map((m) => m.from));
  const dangling = [...sources].filter((v) => v !== currentVersion && !reaches(v));
  if (dangling.length > 0) {
    throw new Error(
      `Event migration coverage gap: schemaVersion(s) [${dangling
        .sort()
        .join(', ')}] have no migration path to current version '${currentVersion}'. ` +
        `Register the missing migration(s) in eventMigrations or revert the EVENT_SCHEMA_VERSION bump.`,
    );
  }
}
