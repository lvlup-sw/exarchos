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
 * Registry of event migrations. Add a migration here when the event schema
 * changes. Migrations apply in chain order, for example 1.0 → 1.1 → 1.2.
 *
 * This registry tracks the per-event payload `schemaVersion` string. It is
 * independent of the SQLite DDL `SCHEMA_VERSION` integer in `storage/sqlite/schema.ts`.
 */
export const eventMigrations: readonly EventMigration[] = [
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
      return current;
    }

    const migration = migrations.find(
      (m) =>
        m.from === currentVersion &&
        (m.eventTypes === 'all' || m.eventTypes.includes(current.type as string)),
    );

    if (!migration) {
      return current;
    }

    current = migration.migrate(current);
    currentVersion = migration.to;
    iterations++;
  }

  return current;
}

/**
 * Apply the registered migrations to a batch of rows at read time.
 *
 * `EventStore.query` and `queryByType` route every backend row through here, so
 * every reader sees the same upcast events. A CI gate checks that no reader
 * builds a `WorkflowEvent` from a raw backend row outside this function.
 *
 * With no migrations registered, it returns the same array reference, so the
 * hot read path does not allocate.
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
 * Assert that every migration source version chains to `currentVersion`. A gap
 * means a reader can see an event that it cannot upcast. A unit test runs this
 * check against the live registry, so a gap fails CI.
 *
 * @throws Error listing the version(s) with no path to `currentVersion`.
 */
export function assertMigrationCoverage(
  currentVersion: string = EVENT_SCHEMA_VERSION,
  migrations: readonly EventMigration[] = eventMigrations,
): void {
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
