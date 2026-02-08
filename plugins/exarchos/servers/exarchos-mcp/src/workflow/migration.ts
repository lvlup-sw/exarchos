export const CURRENT_VERSION = '1.1';

interface Migration {
  readonly from: string;
  readonly to: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

const migrations: readonly Migration[] = [
  {
    from: '1.0',
    to: '1.1',
    migrate: (state) => ({
      ...state,
      version: '1.1',
      _history: state._history ?? {},
      _events: state._events ?? [],
      _eventSequence: state._eventSequence ?? 0,
      _checkpoint: state._checkpoint ?? {
        timestamp:
          (state.updatedAt as string) ?? new Date().toISOString(),
        phase: (state.phase as string) ?? 'unknown',
        summary: '',
        operationsSince: 0,
        fixCycleCount: 0,
        lastActivityTimestamp:
          (state.updatedAt as string) ?? new Date().toISOString(),
        staleAfterMinutes: 120,
      },
    }),
  },
];

/**
 * Migrate a raw state object to the current schema version.
 * Applies migration chain from the detected version to CURRENT_VERSION.
 * Throws with 'MIGRATION_FAILED' message for unknown or missing versions.
 */
export function migrateState(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('MIGRATION_FAILED: state must be a non-null object');
  }

  const state = raw as Record<string, unknown>;
  const version = state.version as string | undefined;

  if (!version) {
    throw new Error('MIGRATION_FAILED: missing version field');
  }

  if (version === CURRENT_VERSION) {
    return state;
  }

  // Build migration chain from current version to CURRENT_VERSION
  let current = { ...state };
  let currentVersion = version;

  const maxIterations = migrations.length + 1;
  let iterations = 0;

  while (currentVersion !== CURRENT_VERSION) {
    if (iterations >= maxIterations) {
      throw new Error(
        `MIGRATION_FAILED: no migration path from version ${currentVersion} to ${CURRENT_VERSION}`
      );
    }

    const migration = migrations.find((m) => m.from === currentVersion);
    if (!migration) {
      throw new Error(
        `MIGRATION_FAILED: no migration registered for version ${currentVersion}`
      );
    }

    current = migration.migrate(current);
    currentVersion = migration.to;
    iterations++;
  }

  return current;
}
