import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  migrateEvent,
  migrateEvents,
  assertMigrationCoverage,
  EVENT_SCHEMA_VERSION,
  eventMigrations,
  type EventMigration,
} from './event-migration.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';
import type { WorkflowEvent } from './schemas.js';

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

    // Should return the exact same reference (no copy needed)
    expect(result).toBe(event);
  });

  it('MigrateEvent_MissingSchemaVersion_DefaultsTo1_0', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      timestamp: '2025-01-15T10:00:00Z',
      // No schemaVersion field
    };

    const result = migrateEvent(event);

    // Missing version defaults to '1.0' which is current — identity return
    expect(result).toBe(event);
  });

  it('MigrateEvent_UnknownFutureVersion_ReturnsAsIs', () => {
    const event = {
      streamId: 'test-stream',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '99.0',
      timestamp: '2025-01-15T10:00:00Z',
    };

    const result = migrateEvent(event);

    // Forward compatibility: unknown future version returns as-is
    // Returns a copy since it enters the migration loop
    expect(result.streamId).toBe('test-stream');
    expect(result.schemaVersion).toBe('99.0');
  });

  // ─── #1556: batch read-time upcasting seam (migrateEvents) ────────────────
  describe('migrateEvents (read-time upcasting choke point)', () => {
    const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      streamId: 'stream-1',
      sequence: 1,
      type: 'workflow.started',
      schemaVersion: '1.0',
      timestamp: '2025-01-15T10:00:00Z',
      ...overrides,
    });

    it('MigrateEvents_NoMigrations_ReturnsSameArrayAndElementReferences', () => {
      // Identity fast-path: with eventMigrations === [] (today), the hot read
      // path must stay allocation-free — same array ref, same element refs.
      const a = row();
      const b = row({ sequence: 2 });
      const input = [a, b];

      const result = migrateEvents(input);

      expect(result).toBe(input);
      expect(result[0]).toBe(a);
      expect(result[1]).toBe(b);
    });

    it('MigrateEvents_WithFixtureMigration_UpcastsMatchingEvents', () => {
      // A 0.9 → current('1.0') fixture migration must fold an old-version row
      // up to the current shape when routed through the batch seam.
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

    it('MigrateEvents_FixtureMigration_LeavesNonMatchingTypesUntouched', () => {
      // eventTypes scoping is honored — a migration for 'workflow.started'
      // must not rewrite a 'task.assigned' row of the same old version.
      const fixture: EventMigration = {
        from: '0.9',
        to: EVENT_SCHEMA_VERSION,
        eventTypes: ['workflow.started'],
        migrate: (e) => ({ ...e, schemaVersion: EVENT_SCHEMA_VERSION, rewritten: true }),
      };
      const other = row({ schemaVersion: '0.9', type: 'task.assigned' });

      const [result] = migrateEvents([other], [fixture]);

      // No matching migration → forward-compat as-is (still 0.9, not rewritten).
      expect(result.schemaVersion).toBe('0.9');
      expect(result.rewritten).toBeUndefined();
    });
  });

  // ─── #1556: build-time version-coverage guard (assertMigrationCoverage) ────
  describe('assertMigrationCoverage (version-coverage build guard)', () => {
    it('AssertMigrationCoverage_LiveRegistry_DoesNotThrow', () => {
      // The real registry + EVENT_SCHEMA_VERSION must always be coverage-clean.
      // This is the build-time guard: a future Zod-shape/version change without
      // a matching migration trips it here.
      expect(() => assertMigrationCoverage(EVENT_SCHEMA_VERSION, eventMigrations)).not.toThrow();
    });

    it('AssertMigrationCoverage_CompleteChain_DoesNotThrow', () => {
      const migrations: EventMigration[] = [
        { from: '0.8', to: '0.9', eventTypes: 'all', migrate: (e) => e },
        { from: '0.9', to: '1.0', eventTypes: 'all', migrate: (e) => e },
      ];
      expect(() => assertMigrationCoverage('1.0', migrations)).not.toThrow();
    });

    it('AssertMigrationCoverage_DanglingSourceVersion_Throws', () => {
      // 0.8 → 0.9 with no edge from 0.9 to current('1.0') leaves 0.8 stranded.
      const migrations: EventMigration[] = [
        { from: '0.8', to: '0.9', eventTypes: 'all', migrate: (e) => e },
      ];
      expect(() => assertMigrationCoverage('1.0', migrations)).toThrow(/no migration path/i);
    });
  });

  // ─── DR-10 AC2: V3 reader tolerance for V2-era event rows ────────────────
  //
  // T12 — Tolerant V2->V3 deserialization. Pins the load-bearing safety
  // property of the SCHEMA_VERSION=2 -> SCHEMA_VERSION=3 SQLite DDL bump:
  // events written under V2 (i.e., before the version was bumped to 3)
  // must deserialize unchanged when the V3 reader observes them.
  //
  // T01's V2->V3 step is a no-op pass-through — the events table DDL did
  // not change between V2 and V3, and per-event `schemaVersion` is still
  // '1.0' in both eras. This is therefore a CHARACTERIZATION test (no RED
  // was constructible): we pin the existing tolerance behaviour so a
  // future task that *does* change V2/V3 payload shape (e.g., adds a
  // V3-only required field) is forced to either preserve byte-equivalence
  // for V2 rows or wire a real per-event migration through `migrateEvent`.
  //
  // Two ingestion paths are exercised:
  //   1. The per-event registry (`migrateEvent`) — relevant to the JSONL
  //      reader path in `EventStore.queryMainJsonl`.
  //   2. The SQLite reader path (`SqliteBackend.queryEvents` -> `rowToEvent`)
  //      — relevant to backend-mode reads. A V2-era row is planted by
  //      writing directly into a V3-initialized DB with the V2-style
  //      payload format (a JSON-encoded WorkflowEvent). A V3-era row is
  //      planted alongside via `appendEvent`. Both must round-trip without
  //      coercion errors.
  describe('EventReader_V3_DeserializesV2ShapedEventsUnchanged', () => {
    let tempDir: string | undefined;
    const backends: SqliteBackend[] = [];

    afterEach(() => {
      for (const b of backends) {
        try {
          b.close();
        } catch {
          // already closed
        }
      }
      backends.length = 0;

      if (tempDir) {
        rmSync(tempDir, { recursive: true });
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

    it('MigrateEvent_V2EraEvent_IsByteEquivalentUnderV3Reader', () => {
      // V2-era events carry per-event `schemaVersion: '1.0'` (unchanged
      // between V2 and V3 SQLite schema versions). The V3 reader's
      // migrateEvent invocation must return the same reference: no copy,
      // no field defaulting, no coercion.
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

      // Identity-equivalence pins the no-op contract: any future migration
      // that touches '1.0' events without bumping EVENT_SCHEMA_VERSION will
      // break this test.
      expect(result).toBe(v2EraEvent);
    });

    it('SqliteV3Reader_PlantedV2RowAndV3Row_BothRoundTripUnchanged', () => {
      const dbPath = createTempDb();

      // Open with the current SqliteBackend (SCHEMA_VERSION = 3). This
      // models the V3 reader observing a database that still contains
      // rows written under the V2 backend (which used the same payload
      // column shape T01 froze).
      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      // Plant a V2-era row directly via the underlying Database handle.
      // This bypasses appendEvent's V3 code path so we can fix the exact
      // bytes a V2 backend would have stored. The payload format under V2
      // and V3 is identical (a JSON-encoded WorkflowEvent), so the V2 row
      // is constructed from a known WorkflowEvent shape.
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

      // Append a V3-era row through the normal V3 backend path so both
      // shapes are present in a single read window.
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

      // V3 reader observes both rows. Neither path should throw, and the
      // V2 row must come back byte-equivalent (every WorkflowEvent field
      // preserved). The V3 row must also round-trip.
      const events = backend.queryEvents('stream-mixed');
      expect(events).toHaveLength(2);

      // V2 row: byte-equivalent under V3 reader. Check by JSON-canonical
      // round-trip — the payload column is JSON-decoded by rowToEvent, so
      // re-encoding the read result must equal the originally-planted
      // payload string. This is the strictest form of "deserialize
      // unchanged" the design requirement asks for.
      expect(JSON.stringify(events[0])).toBe(v2Payload);
      expect(events[0]).toEqual(v2Event);

      // V3 row: also round-trips. Different `agentId`, different sequence,
      // different correlationId — confirms the reader is not coercing or
      // shadowing fields between the two rows.
      expect(events[1]).toEqual(v3Event);
    });
  });

  // ─── R-1: V3 → V4 schema migration (Wave 1, #1313) ────────────────────────
  //
  // The V3 → V4 migration introduces a `streams` table carrying a mandatory
  // `workflow_type` column. This is the write-side foundation for v2.12's
  // filtered `ps` queries (#1090). V3 had no `streams` table — stream
  // existence was implicit in the `sequences` table. V4 materializes the
  // registry and backfills `workflow_type = '__legacy'` for every preexisting
  // stream row (later subtasks backfill from state files / emit observability
  // events for un-recoverable rows).
  describe('Migration_V3ToV4_StreamsTable', () => {
    let tempDir: string | undefined;
    const backends: SqliteBackend[] = [];

    afterEach(() => {
      for (const b of backends) {
        try {
          b.close();
        } catch {
          // already closed
        }
      }
      backends.length = 0;

      if (tempDir) {
        rmSync(tempDir, { recursive: true });
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

    /**
     * Seed a V3-shape database — schema_version=3 ledger row, sequences rows
     * for two streams, NO `streams` table. Simulates a database produced by
     * the V3 backend (which used `sequences` as the implicit stream registry).
     */
    function seedV3Database(dbPath: string): void {
      // Use a raw bun:sqlite handle so we don't trigger any auto-migration.
      const db = new Database(dbPath);
      // Minimal V3 DDL — only the tables this test cares about. The real V3
      // schema has more tables, but Wave 1's migration only touches streams
      // and references `sequences` for backfill.
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
      // Two stream rows in the implicit V3 registry.
      db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?)',
      ).run('feat-alpha', 5);
      db.prepare(
        'INSERT INTO sequences (streamId, sequence) VALUES (?, ?)',
      ).run('feat-beta', 7);
      db.close();
    }

    it('Migration_V3ToV4_AddsWorkflowTypeColumnWithLegacyDefault', () => {
      const dbPath = createTempDb();
      seedV3Database(dbPath);

      // Opening the backend triggers `initialize()` which runs migrateSchema().
      // V3 → V4 should create the `streams` table with a NOT NULL
      // `workflow_type` column and backfill `__legacy` for both pre-existing
      // sequences rows.
      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      // Column exists with the right shape.
      const cols = db
        .prepare('PRAGMA table_info(streams)')
        .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
      const wt = cols.find((c) => c.name === 'workflow_type');
      expect(wt).toBeDefined();
      expect(wt!.notnull).toBe(1);

      // Both pre-existing streams have the legacy sentinel.
      const rows = db
        .prepare('SELECT streamId, workflow_type FROM streams ORDER BY streamId')
        .all() as Array<{ streamId: string; workflow_type: string }>;
      expect(rows).toEqual([
        { streamId: 'feat-alpha', workflow_type: '__legacy' },
        { streamId: 'feat-beta', workflow_type: '__legacy' },
      ]);
    });

    it('Migration_V3ToV4_CreatesWorkflowTypeIndexes', () => {
      const dbPath = createTempDb();
      seedV3Database(dbPath);

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      // The v2.12 read-side (#1090) wires `ps`/`pipeline`/`view` filtering
      // through these two indexes. Wave 1 only enforces their existence —
      // their actual use is deferred. Asserting them today means the
      // operator-controlled filtered queries land on indexed plans the
      // moment v2.12 ships, with no separate migration window.
      const idx = db
        .prepare('PRAGMA index_list(streams)')
        .all() as Array<{ name: string }>;
      const names = idx.map((r) => r.name);
      expect(names).toContain('idx_streams_workflow_type');
      expect(names).toContain('idx_streams_workflow_type_status');
    });

    it('Migration_V3ToV4_BackfillsFromStateFile', () => {
      const dbPath = createTempDb();
      // SqliteBackend lives at <stateDir>/exarchos.db by convention — the
      // migration reads state files from the same parent directory. Use
      // tempDir as the state dir and pin a stream's workflow type in its
      // state file before the migration runs.
      const stateDir = tempDir!;
      const dbPathInStateDir = join(stateDir, 'exarchos.db');

      // Seed V3 with a stream that has a sibling state file naming oneshot.
      seedV3Database(dbPathInStateDir);

      // Append a third stream `feat-y` with a state file. The state file
      // is the only place the migration can recover a non-legacy
      // workflowType for pre-V4 streams; absent the file, the row keeps
      // '__legacy' (covered by task 1.6's observability event).
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

      // The recovered workflowType replaces '__legacy'. This is the ONLY
      // allowed UPDATE of workflow_type — task 1.7's grep gate enforces
      // immutability everywhere else.
      expect(row).toBeDefined();
      expect(row!.workflow_type).toBe('oneshot');
    });

    it('Migration_V3ToV4_EmitsUnknownEventForLegacyStreams', () => {
      const stateDir = tempDir = mkdtempSync(join(tmpdir(), 'exarchos-v3v4-unknown-'));
      const dbPath = join(stateDir, 'exarchos.db');

      seedV3Database(dbPath);

      // Insert a third stream `feat-z` with NO state file. The migration
      // cannot recover workflowType for it, so it stays at '__legacy' and
      // must emit one `migration.workflow_type_unknown` event so operators
      // can locate streams that need manual classification.
      const seedDb = new Database(dbPath);
      seedDb
        .prepare('INSERT INTO sequences (streamId, sequence) VALUES (?, ?)')
        .run('feat-z', 9);
      seedDb.close();

      const backend = trackBackend(new SqliteBackend(dbPath));
      backend.initialize();

      const db = (backend as unknown as { db: Database }).db;

      // 1. Stream row still legacy.
      const row = db
        .prepare('SELECT workflow_type FROM streams WHERE streamId = ?')
        .get('feat-z') as { workflow_type: string } | undefined;
      expect(row?.workflow_type).toBe('__legacy');

      // 2. Exactly one event of type migration.workflow_type_unknown for
      // this stream, with data.streamId = 'feat-z'. The "exactly one" part
      // matters: a re-run of the migration is gated by the V4 ledger row,
      // so this event must not be re-emitted on subsequent opens.
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
