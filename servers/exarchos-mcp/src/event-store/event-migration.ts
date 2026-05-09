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
export function migrateEvent(raw: Record<string, unknown>): Record<string, unknown> {
  const version = (raw.schemaVersion as string) ?? '1.0';
  if (version === EVENT_SCHEMA_VERSION) return raw;

  let current = { ...raw };
  let currentVersion = version;
  const maxIterations = eventMigrations.length + 1;
  let iterations = 0;

  while (currentVersion !== EVENT_SCHEMA_VERSION) {
    if (iterations >= maxIterations) {
      // No complete path — return as-is for forward compatibility
      return current;
    }

    const migration = eventMigrations.find(
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
