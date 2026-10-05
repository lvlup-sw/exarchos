import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateEvent,
  migrateEvents,
  assertMigrationCoverage,
  EVENT_SCHEMA_VERSION,
  eventMigrations,
  type EventMigration,
} from '../../../src/events/event-migration.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import type { WorkflowEvent } from '../../../src/events/schemas.js';
import { rmrf } from '../../../tools/test-helpers/temp-dir.js';

describe('Event Migration', () => {
  it('EVENT_SCHEMA_VERSION_Exported_Is1_0', () => {
    expect(EVENT_SCHEMA_VERSION).toBe('1.0');
  });

  it('MigrateEvent_CurrentVersion_ReturnsIdentity', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '1.0',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    expect(result).toBe(event);
  });

  /** A missing version defaults to '1.0', which is current, so the result is the same reference. */
  it('MigrateEvent_MissingSchemaVersion_DefaultsTo1_0', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    expect(result).toBe(event);
  });

  /**
   * Forward compatibility: an unknown later version has no migration path. The result is a copy
   * with the same fields.
   */
  it('MigrateEvent_UnknownFutureVersion_ReturnsAsIs', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '99.0',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    expect(result.streamId).toBe('test-stream');
    expect(result.schemaVersion).toBe('99.0');
  });

  describe('migrateEvents (read-time upcasting choke point)', () => {
    const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      streamId: 'stream-1',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '1.0',
      timestamp: '2025-01-15T10:00:00Z',
      ...overrides,
    });

    /**
     * With no migrations, the hot read path must not allocate: the result is the same array with
     * the same elements. The test passes `[]` explicitly, so it does not depend on an empty global
     * registry.
     */
    it('MigrateEvents_NoMigrations_ReturnsSameArrayAndElementReferences', () => {
      const a = row();
      const b = row({ sequence: 2 });
      const input = [a, b];

      const result = migrateEvents(input, []);

      expect(result).toBe(input);
      expect(result[0]).toBe(a);
      expect(result[1]).toBe(b);
    });

    /** A fixture migration from 0.9 to the current version must upcast an old row in a batch. */
    it('MigrateEvents_WithFixtureMigration_UpcastsMatchingEvents', () => {
      const fixture: EventMigration = {
        from: '0.9',
        to: EVENT_SCHEMA_VERSION,
        eventTypes: ['workflow.started'],
        migrate: (e) => ({
          ...e,
          schemaVersion: EVENT_SCHEMA_VERSION,
          data: { ...(e.data as object), upgraded: true },
        }),
      };
      const old = row({ schemaVersion: '0.9', data: { featureId: 'f1' } });

      const [result] = migrateEvents([old], [fixture]);

      expect(result.schemaVersion).toBe(EVENT_SCHEMA_VERSION);
      expect((result.data as { upgraded?: boolean }).upgraded).toBe(true);
    });

    /**
     * A migration scoped to `workflow.started` must not rewrite a `task.assigned` row of the same
     * old version. The row stays at 0.9.
     */
    it('MigrateEvents_FixtureMigration_LeavesNonMatchingTypesUntouched', () => {
      const fixture: EventMigration = {
        from: '0.9',
        to: EVENT_SCHEMA_VERSION,
        eventTypes: ['workflow.started'],
        migrate: (e) => ({ ...e, schemaVersion: EVENT_SCHEMA_VERSION, rewritten: true }),
      };
      const other = row({ schemaVersion: '0.9', type: 'task.assigned' });

      const [result] = migrateEvents([other], [fixture]);

      expect(result.schemaVersion).toBe('0.9');
      expect(result.rewritten).toBeUndefined();
    });
  });

  describe('assertMigrationCoverage (version-coverage build guard)', () => {
    /**
     * Each `from` version in the live registry must have a path to `EVENT_SCHEMA_VERSION`.
     * An empty registry has no `from` version, so the check passes whatever the current version is.
     */
    it('AssertMigrationCoverage_LiveRegistry_DoesNotThrow', () => {
      expect(() => assertMigrationCoverage(EVENT_SCHEMA_VERSION, eventMigrations)).not.toThrow();
    });

    it('AssertMigrationCoverage_CompleteChain_DoesNotThrow', () => {
      const migrations: EventMigration[] = [
        { from: '0.8', to: '0.9', eventTypes: 'all', migrate: (e) => e },
        { from: '0.9', to: '1.0', eventTypes: 'all', migrate: (e) => e },
      ];
      expect(() => assertMigrationCoverage('1.0', migrations)).not.toThrow();
    });

    /** 0.8 migrates to 0.9, and no edge leads from 0.9 to 1.0, so 0.8 has no path. */
    it('AssertMigrationCoverage_DanglingSourceVersion_Throws', () => {
      const migrations: EventMigration[] = [
        { from: '0.8', to: '0.9', eventTypes: 'all', migrate: (e) => e },
      ];
      expect(() => assertMigrationCoverage('1.0', migrations)).toThrow(/no migration path/i);
    });
  });

  /**
   * Characterization of the reader for event rows from SQLite schema version 2.
   * The payload column holds a JSON-encoded `WorkflowEvent`, and the per-event `schemaVersion` is
   * '1.0'. A change to the payload shape must keep these rows byte-equivalent, or add a migration
   * to `migrateEvent`.
   * The tests cover the `migrateEvent` registry and the `SqliteBackend.queryEvents` read path.
   */
  describe('EventReader_V3_DeserializesV2ShapedEventsUnchanged', () => {
    let tempDir: string | undefined;
    const backends: SqliteBackend[] = [];

    afterEach(() => {
      for (const b of backends) {
        try {
          b.close();
        } catch {
        }
      }
      backends.length = 0;

      if (tempDir) {
        rmrf(tempDir);
        tempDir = undefined;
      }
    });

    function createTempDb(): string {
      tempDir = mkdtempSync(join(tmpdir(), 'exarchos-v2v3-'));
      return join(tempDir, 'test.db');
    }

    function trackBackend(backend: SqliteBackend): SqliteBackend {
      backends.push(backend);
      return backend;
    }

    /**
     * The event holds the current `schemaVersion`, so `migrateEvent` must return the same reference
     * with no copy and no coercion. A reader that copies or rewrites a current event fails this test.
     */
    it('MigrateEvent_V2EraEvent_IsByteEquivalentUnderV3Reader', () => {
      const v2EraEvent = {
        streamId: 'stream-v2',
        sequence: 1,
        type: 'workflow.started',
        schemaVersion: EVENT_SCHEMA_VERSION,
        timestamp: '2024-06-01T00:00:00.000Z',
        correlationId: 'corr-pre-v3',
        agentId: 'agent-v2',
        agentRole: 'implementer',
        source: 'mcp-tool',
        data: { featureId: 'feat-pre-v3', workflowType: 'feature' as const },
      };

      const result = migrateEvent(v2EraEvent);

      expect(result).toBe(v2EraEvent);
    });

    /**
     * The test plants one row through the raw database handle. That path skips `appendEvent` and
     * fixes the stored bytes. A second row goes through the backend, so one read holds both rows.
     * The planted row must read back byte-equivalent: the read result encodes to the planted
     * payload string. The appended row has a different agent, sequence and correlation id, so a
     * reader that mixes fields between rows fails.
     */
    it('SqliteV3Reader_PlantedV2RowAndV3Row_BothRoundTripUnchanged', () => {
      const dbPath = createTempDb();

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const v2Event: WorkflowEvent = {
        streamId: 'stream-mixed',
        sequence: 1,
        type: 'workflow.started',
        timestamp: '2024-06-01T00:00:00.000Z',
        correlationId: 'corr-v2-era',
        agentId: 'agent-v2',
        source: 'mcp-tool',
        schemaVersion: '1.0',
        data: { featureId: 'feat-v2', workflowType: 'feature' },
      };
      const v2Payload = JSON.stringify(v2Event);
      const v2DataCol = JSON.stringify(v2Event.data);

      const db = (backend as unknown as { db: Database }).db;
      db.prepare(
        'INSERT INTO events (streamId, sequence, type, timestamp, data, payload) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        v2Event.streamId,
        v2Event.sequence,
        v2Event.type,
        v2Event.timestamp,
        v2DataCol,
        v2Payload,
      );
      db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?) ON CONFLICT(streamId) DO UPDATE SET sequence = excluded.sequence',
      ).run(v2Event.streamId, v2Event.sequence);

      const v3Event: WorkflowEvent = {
        streamId: 'stream-mixed',
        sequence: 2,
        type: 'task.assigned',
        timestamp: '2024-06-02T00:00:00.000Z',
        correlationId: 'corr-v3-era',
        agentId: 'agent-v3',
        source: 'mcp-tool',
        schemaVersion: '1.0',
        data: { taskId: 't1', title: 'V3 task' },
      };
      backend.appendEvent('stream-mixed', v3Event);

      const events = backend.queryEvents('stream-mixed');
      expect(events).toHaveLength(2);

      expect(JSON.stringify(events[0])).toBe(v2Payload);
      expect(events[0]).toEqual(v2Event);

      expect(events[1]).toEqual(v3Event);
    });
  });

  /**
   * The V3 to V4 migration creates the `streams` table with a mandatory `workflow_type` column.
   * V3 has no `streams` table: the `sequences` table is the implicit stream registry.
   * `seedV3Database` writes a V3 database through a raw handle, so no automatic migration runs.
   * The seed is a minimal V3 schema with a version row of 3 and two streams.
   */
  describe('Migration_V3ToV4_StreamsTable', () => {
    let tempDir: string | undefined;
    const backends: SqliteBackend[] = [];

    afterEach(() => {
      for (const b of backends) {
        try {
          b.close();
        } catch {
        }
      }
      backends.length = 0;

      if (tempDir) {
        rmrf(tempDir);
        tempDir = undefined;
      }
    });

    function createTempDb(): string {
      tempDir = mkdtempSync(join(tmpdir(), 'exarchos-v3v4-'));
      return join(tempDir, 'test.db');
    }

    function trackBackend(backend: SqliteBackend): SqliteBackend {
      backends.push(backend);
      return backend;
    }

    function seedV3Database(dbPath: string): void {
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE events (
          streamId  TEXT NOT NULL,
          sequence  INTEGER NOT NULL,
          type      TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          data      TEXT,
          payload   TEXT,
          PRIMARY KEY (streamId, sequence)
        );
        CREATE TABLE sequences (
          streamId TEXT PRIMARY KEY,
          sequence INTEGER NOT NULL
        );
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          appliedAt TEXT NOT NULL
        );
      `);
      db.prepare('INSERT INTO schema_version (version, appliedAt) VALUES (?, ?)').run(
        3,
        new Date().toISOString(),
      );
      db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?)',
      ).run('feat-alpha', 5);
      db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?)',
      ).run('feat-beta', 7);
      db.close();
    }

    /**
     * `initialize()` runs the schema migration. It must create `streams` with a NOT NULL
     * `workflow_type` column and give both existing streams the `__legacy` type.
     */
    it('Migration_V3ToV4_AddsWorkflowTypeColumnWithLegacyDefault', () => {
      const dbPath = createTempDb();
      seedV3Database(dbPath);

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      const cols = db
        .prepare('PRAGMA table_info(streams)')
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
      const wt = cols.find((c) => c.name === 'workflow_type');
      expect(wt).toBeDefined();
      expect(wt!.notnull).toBe(1);

      const rows = db
        .prepare('SELECT streamId, workflow_type FROM streams ORDER BY streamId')
        .all() as Array<{ streamId: string; workflow_type: string }>;
      expect(rows).toEqual([
        { streamId: 'feat-alpha', workflow_type: '__legacy' },
        { streamId: 'feat-beta', workflow_type: '__legacy' },
      ]);
    });

    /**
     * The migration must create both indexes on `workflow_type`. The filtered stream queries read
     * through `idx_streams_workflow_type`.
     */
    it('Migration_V3ToV4_CreatesWorkflowTypeIndexes', () => {
      const dbPath = createTempDb();
      seedV3Database(dbPath);

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      const idx = db
        .prepare('PRAGMA index_list(streams)')
        .all() as Array<{ name: string }>;
      const names = idx.map((r) => r.name);
      expect(names).toContain('idx_streams_workflow_type');
      expect(names).toContain('idx_streams_workflow_type_status');
    });

    /**
     * The migration reads state files from the directory that holds the database.
     * `feat-y` has a state file with the type `oneshot`, so the migration replaces `__legacy`.
     * A state file is the only source of a type for a pre-V4 stream. This recovery is the only
     * allowed UPDATE of `workflow_type`, and a grep gate forbids that UPDATE elsewhere.
     */
    it('Migration_V3ToV4_BackfillsFromStateFile', () => {
      const dbPath = createTempDb();
      const stateDir = tempDir!;
      const dbPathInStateDir = join(stateDir, 'exarchos.db');

      seedV3Database(dbPathInStateDir);

      const seedDb = new Database(dbPathInStateDir);
      seedDb
        .prepare('INSERT INTO sequences (streamId, sequence) VALUES (?, ?)')
        .run('feat-y', 3);
      seedDb.close();

      writeFileSync(
        join(stateDir, 'feat-y.state.json'),
        JSON.stringify({ featureId: 'feat-y', workflowType: 'oneshot' }),
        'utf-8',
      );

      const backend = trackBackend(new SqliteBackend(dbPathInStateDir));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;
      const row = db
        .prepare('SELECT workflow_type FROM streams WHERE streamId = ?')
        .get('feat-y') as { workflow_type: string } | undefined;

      expect(row).toBeDefined();
      expect(row!.workflow_type).toBe('oneshot');
    });

    /**
     * `feat-z` has no state file, so the migration cannot recover its type and the row stays
     * `__legacy`. The migration must append exactly one `migration.workflow_type_unknown` event
     * for the stream. That event lets an operator find a stream that needs manual classification.
     */
    it('Migration_V3ToV4_EmitsUnknownEventForLegacyStreams', () => {
      const stateDir = tempDir = mkdtempSync(join(tmpdir(), 'exarchos-v3v4-unknown-'));
      const dbPath = join(stateDir, 'exarchos.db');

      seedV3Database(dbPath);

      const seedDb = new Database(dbPath);
      seedDb
        .prepare('INSERT INTO sequences (streamId, sequence) VALUES (?, ?)')
        .run('feat-z', 9);
      seedDb.close();

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      const row = db
        .prepare('SELECT workflow_type FROM streams WHERE streamId = ?')
        .get('feat-z') as { workflow_type: string } | undefined;
      expect(row?.workflow_type).toBe('__legacy');

      const events = db
        .prepare(
          `SELECT streamId, type, data FROM events
           WHERE type = ? AND streamId = ?`,
        )
        .all('migration.workflow_type_unknown', 'feat-z') as Array<{
        streamId: string;
        type: string;
        data: string | null;
      }>;

      expect(events).toHaveLength(1);
      expect(events[0].data).toBeTruthy();
      const data = JSON.parse(events[0].data!) as { streamId?: string };
      expect(data.streamId).toBe('feat-z');
    });
  });
});
