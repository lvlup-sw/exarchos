import * as fs from 'node:fs/promises';

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
    /**
     * Maps the legacy `jules` assignee to `subagent`.
     * Removes `_events` and `_eventSequence`, because the events live in the event store.
     */
    migrate: (state) => {
      const tasks = Array.isArray(state.tasks)
        ? (state.tasks as Record<string, unknown>[]).map((task) => ({
            ...task,
            assignee:
              task.assignee === 'jules' ? 'subagent' : task.assignee,
          }))
        : state.tasks;

      const { _events, _eventSequence, ...rest } = state;

      return {
        ...rest,
        version: '1.1',
        tasks,
        _history: rest._history ?? {},
        _checkpoint: rest._checkpoint ?? {
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
      };
    },
  },
];

/** Copies the state file to `<stateFile>.bak` and returns the backup path. */
export async function backupStateFile(stateFile: string): Promise<string> {
  const backupPath = `${stateFile}.bak`;
  await fs.copyFile(stateFile, backupPath);
  return backupPath;
}

export interface MigrationRecord {
  readonly from: string;
  readonly to: string;
  readonly timestamp: string;
}

/**
 * Applies the migration chain from the state version (`1.0` when absent) to `CURRENT_VERSION`.
 * @throws an error with a `MIGRATION_FAILED` message when the input is not an object or no migration path exists.
 */
export function migrateState(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('MIGRATION_FAILED: state must be a non-null object');
  }

  const state = raw as Record<string, unknown>;
  const version = (state.version as string | undefined) ?? '1.0';

  if (version === CURRENT_VERSION) {
    return state;
  }

  let current = { ...state };
  let currentVersion = version;

  const maxIterations = migrations.length + 1;
  let iterations = 0;
  const records: MigrationRecord[] = [];

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
    records.push({ from: migration.from, to: migration.to, timestamp: new Date().toISOString() });
    currentVersion = migration.to;
    iterations++;
  }

  if (records.length > 0) {
    current._migrationHistory = records;
  }

  return current;
}
