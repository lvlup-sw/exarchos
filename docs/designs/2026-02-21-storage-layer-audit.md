# Design: Hybrid JSONL + SQLite Storage Layer

**Feature ID:** `storage-layer-audit`
**Date:** 2026-02-21
**Status:** Draft
**Scope:** MCP server storage backend — event store, state store, views, outbox, telemetry

---

## Problem Statement

The Exarchos MCP server uses JSONL files as its event store, JSON files for workflow state, and JSON snapshots for view materialization. A systematic audit against the `optimize.md` guidelines reveals that while the architecture is conceptually sound (append-only events, CQRS views, high-water mark tracking), the implementation has critical I/O inefficiencies:

1. **Every view query reads the entire JSONL file** — view handlers call `store.query(streamId)` with no filters, despite the materializer tracking high-water marks that could enable incremental reads (F1)
2. **Pipeline view scales as O(streams × events)** — iterates all discovered streams, each with a full JSONL scan (F2)
3. **reconcileFromEvents issues 2-3 redundant full-stream reads** for a single reconciliation (F3)
4. **Snapshot loading regresses in-memory state** — `loadFromSnapshot` overwrites the materializer's more recent in-memory high-water mark with the older disk snapshot on every warm call (F4)
5. **Outbox uses JSON array** — every addEntry reads and rewrites the entire file; drain is O(n²) (F7, F8)
6. **Telemetry adds 2-3 event appends per tool call** — growing a dedicated stream that compounds all read-path issues (F15)
7. **14+ files per workflow** — `.events.jsonl`, `.state.json`, `.seq`, `.outbox.json`, and up to 10 `.snapshot.json` files create artifact sprawl

These issues don't cause pain today at low event counts (<100 per workflow), but they create a scaling ceiling as event counts grow and block planned features like concurrent teammate access and real-time views.

### Design Context

Exarchos is the **local-first** agent governance layer. The optional remote backend (Basileus, with Marten/PostgreSQL) provides cloud-tier persistence. The local storage layer must:

- Be **self-contained** — zero infrastructure dependencies beyond Node.js and the filesystem
- **Mirror Marten patterns** — same event sourcing + CQRS model, smaller scale
- Support **offline-first** operation — no hard dependency on a remote backend being deployed
- Provide **human-readable debugging** — developers must be able to inspect workflow state with standard Unix tools

---

## Options Evaluated

### Option 1: Surgical JSONL Fixes

**Approach:** Fix the wiring problems in the current JSONL architecture — pass `sinceSequence` to view queries, skip redundant snapshot loads, fix outbox drain. No new dependencies.

**Pros:**
- Minimal changes (~150-200 LOC), quick to ship
- No new dependencies, no native bindings
- Fixes the immediate O(n) bottlenecks

**Cons:**
- Doesn't address the structural ceiling — JSONL has no indexing, no range queries, no concurrent access safety
- Cross-stream queries still require per-stream file reads
- Artifact sprawl remains (14+ files per workflow)

**Best when:** The scaling concern is theoretical and current event counts are low.

### Option 2: Hybrid JSONL + SQLite (Selected)

**Approach:** JSONL stays as the durable append-only event log. SQLite (`better-sqlite3`) becomes the runtime query engine, hydrated from JSONL on startup. All reads go through SQLite; writes commit to JSONL first, then replicate to SQLite.

**Pros:**
- Indexed queries: O(log n) for sinceSequence, type filtering, time ranges
- Native cross-process locking (WAL mode)
- Transactional atomicity for event + outbox writes
- Artifact reduction: 14 files per workflow → 1 JSONL + 1 shared SQLite DB
- Preserves event sourcing fidelity — JSONL is the source of truth
- Human-readable debugging intact (`cat *.events.jsonl | jq .`)

**Cons:**
- Native dependency (`better-sqlite3`) requires C++ bindings
- Startup hydration adds cold-start latency (one-time JSONL scan)
- Two representations of event data (JSONL + SQLite)

**Best when:** Scaling matters, concurrent access is planned, and architectural alignment with Marten is valued.

### Option 3: SQLite-Primary with JSONL Snapshots

**Approach:** SQLite is the sole source of truth for all local operations. JSONL is demoted to periodic phase-bounded snapshots for portability and recovery.

**Pros:**
- Single source of truth — simplest write path
- Full SQL capability for all queries
- Simplest code — removes all JSONL parsing, streaming, and line-counting

**Cons:**
- Inverts event sourcing semantics — mutable store becomes source of truth
- Events between JSONL exports are SQLite-only; corruption causes data loss
- Debugging requires `sqlite3` CLI instead of `cat | jq`
- Breaks alignment with the Marten-mirroring design philosophy

**Best when:** Maximum simplicity is prioritized over event sourcing purity.

---

## Chosen Approach: Hybrid JSONL + SQLite

JSONL stays as the **durable append-only event log** (source of truth). SQLite (`better-sqlite3`) becomes the **runtime query engine**, hydrated from JSONL on startup and used for all reads during the session.

### Rationale

- **Event sourcing fidelity** — JSONL-as-source-of-truth preserves the append-only event log as the canonical record, mirroring how Marten uses PostgreSQL's events table
- **Debuggability** — `cat *.events.jsonl | jq .` remains available for human inspection
- **Failure mode simplicity** — SQLite corruption → delete the DB, restart, it rebuilds from JSONL in <500ms. No data loss.
- **Artifact reduction** — 14 files per workflow → 1 JSONL per workflow + 1 SQLite DB total
- **Sync alignment** — the outbox/sync engine ships from JSONL to Basileus, unchanged

### Architecture

```
JSONL files (durable, human-readable)        SQLite exarchos.db (ephemeral per-session)
┌────────────────────────────────────┐      ┌─────────────────────────────────────────┐
│ {id}.events.jsonl (append-only)    │─────▶│ events (streamId, seq, type, timestamp,  │
│                                    │      │         data JSON, indexed)              │
└────────────────────────────────────┘      │                                         │
                                            │ workflow_state (featureId, state JSON,   │
*.state.json → MIGRATED INTO ──────────────▶│                 version, CAS)           │
                                            │                                         │
*.outbox.json → MIGRATED INTO ─────────────▶│ outbox (id, streamId, event JSON,       │
                                            │         status, attempts)               │
                                            │                                         │
*.snapshot.json → REPLACED BY ─────────────▶│ view_cache (streamId, viewName,         │
                                            │            state JSON, hwm)             │
                                            │                                         │
*.seq → REPLACED BY ───────────────────────▶│ sequences (streamId, sequence)          │
                                            └─────────────────────────────────────────┘

Write path:  event → JSONL appendFile (durable commit) → SQLite INSERT (derived index)
Read path:   query → SQLite SELECT (indexed, <1ms) → return
Startup:     JSONL scan → hydrate SQLite (one-time, <500ms for 5K events)
```

---

## Technical Design

### Section 1: SQLite Schema

```sql
-- Event index (mirrors JSONL, not the source of truth)
CREATE TABLE events (
  streamId  TEXT NOT NULL,
  sequence  INTEGER NOT NULL,
  type      TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  data      TEXT,  -- JSON blob
  PRIMARY KEY (streamId, sequence)
);
CREATE INDEX idx_events_type ON events(streamId, type);
CREATE INDEX idx_events_time ON events(streamId, timestamp);

-- Workflow state (replaces .state.json files)
CREATE TABLE workflow_state (
  featureId TEXT PRIMARY KEY,
  state     TEXT NOT NULL,  -- JSON blob
  version   INTEGER NOT NULL DEFAULT 1,
  updatedAt TEXT NOT NULL
);

-- Outbox (replaces .outbox.json files)
CREATE TABLE outbox (
  id          TEXT PRIMARY KEY,
  streamId    TEXT NOT NULL,
  event       TEXT NOT NULL,  -- JSON blob
  status      TEXT NOT NULL DEFAULT 'pending',
  attempts    INTEGER NOT NULL DEFAULT 0,
  createdAt   TEXT NOT NULL,
  lastAttemptAt TEXT,
  nextRetryAt   TEXT,
  error       TEXT
);
CREATE INDEX idx_outbox_pending ON outbox(streamId, status) WHERE status = 'pending';

-- View cache (replaces .snapshot.json files)
CREATE TABLE view_cache (
  streamId    TEXT NOT NULL,
  viewName    TEXT NOT NULL,
  state       TEXT NOT NULL,  -- JSON blob
  highWaterMark INTEGER NOT NULL,
  savedAt     TEXT NOT NULL,
  PRIMARY KEY (streamId, viewName)
);

-- Sequence counters (replaces .seq files)
CREATE TABLE sequences (
  streamId TEXT PRIMARY KEY,
  sequence INTEGER NOT NULL
);
```

SQLite is opened in **WAL mode** for concurrent reader support and with `synchronous = NORMAL` for balanced durability/performance. The `better-sqlite3` synchronous API eliminates async complexity — all reads are blocking but sub-millisecond.

### Section 2: StorageBackend Abstraction

A new interface decouples storage consumers from the backing implementation:

```typescript
interface StorageBackend {
  // Event operations
  appendEvent(streamId: string, event: WorkflowEvent): void;
  queryEvents(streamId: string, filters?: QueryFilters): WorkflowEvent[];
  getSequence(streamId: string): number;

  // State operations
  getState(featureId: string): WorkflowState | null;
  setState(featureId: string, state: WorkflowState, expectedVersion?: number): void;
  listStates(): Array<{ featureId: string; state: WorkflowState }>;

  // Outbox operations
  addOutboxEntry(streamId: string, event: WorkflowEvent): string;
  drainOutbox(streamId: string, sender: EventSender, batchSize?: number): DrainResult;

  // View cache operations
  getViewCache(streamId: string, viewName: string): ViewCacheEntry | null;
  setViewCache(streamId: string, viewName: string, state: unknown, hwm: number): void;

  // Lifecycle
  initialize(): void;
  close(): void;
}
```

Two implementations:
- `SqliteBackend` — the production runtime backend using `better-sqlite3`
- `InMemoryBackend` — for tests (no disk I/O, no native dependency)

The existing `EventStore`, `StateStore`, `Outbox`, and `ViewMaterializer` classes delegate to the backend. This preserves all existing interfaces and tests — only the storage layer changes.

### Section 3: Write Path

Every event append follows this sequence:

```typescript
append(streamId, event, options?) {
  return this.withLock(streamId, () => {
    // 1. Validate (Zod on boundary only — skip for internal calls)
    const fullEvent = validateAtBoundary(event);

    // 2. JSONL commit (durable — this is the source of truth)
    fs.appendFileSync(this.getJsonlPath(streamId), JSON.stringify(fullEvent) + '\n');

    // 3. SQLite index (derived — if this fails, rebuilt on next startup)
    this.backend.appendEvent(streamId, fullEvent);

    // 4. Outbox entry (transactional with SQLite — same DB)
    if (this.outbox) {
      this.backend.addOutboxEntry(streamId, fullEvent);
    }

    return fullEvent;
  });
}
```

Key change: **JSONL append and SQLite insert are separate writes, but SQLite + outbox are in the same SQLite transaction**. This closes the atomicity gap (F9) — the outbox entry and event index are always consistent. JSONL remains the commit point for durability.

Using `better-sqlite3`'s synchronous API, steps 2-4 take <1ms combined. `appendFileSync` for JSONL is ~0.5ms. Total write path: ~1.5ms (vs current ~1ms for JSONL-only). Negligible overhead.

### Section 4: Read Path

All reads go through SQLite. No JSONL scanning during normal operation.

**View query (before):**
```
fs.access → createReadStream → readline (all N lines) → JSON.parse × N → filter by HWM → project
```

**View query (after):**
```
db.prepare('SELECT * FROM events WHERE streamId = ? AND sequence > ?').all(streamId, hwm)
```

This converts O(n) disk reads + JSON.parse to O(log n) indexed lookups. For a stream with 500 events where only 2 are new, the current path parses all 500 lines; the new path fetches exactly 2 rows.

**Pipeline view (before):** `readdir` + N × full JSONL scans
**Pipeline view (after):** `SELECT DISTINCT streamId FROM events` + N indexed queries for delta events only

**reconcileFromEvents (before):** 2-3 full stream reads
**reconcileFromEvents (after):** 1 indexed query for delta events + 1 indexed query for last transition (`SELECT * FROM events WHERE streamId = ? AND type = 'workflow.transition' ORDER BY sequence DESC LIMIT 1`)

### Section 5: Startup Hydration

On MCP server startup:

```typescript
async initialize() {
  // 1. Open or create SQLite DB
  this.db = new Database(path.join(this.stateDir, 'exarchos.db'));
  this.db.pragma('journal_mode = WAL');
  this.db.pragma('synchronous = NORMAL');

  // 2. Run schema migrations
  this.ensureSchema();

  // 3. Hydrate from JSONL
  const jsonlFiles = glob.sync('*.events.jsonl', { cwd: this.stateDir });
  for (const file of jsonlFiles) {
    const streamId = file.replace('.events.jsonl', '');
    const dbSequence = this.getSequence(streamId);  // last sequence in SQLite

    // Stream JSONL, skip lines ≤ dbSequence, INSERT remaining
    await this.hydrateStream(streamId, dbSequence);
  }

  // 4. Migrate legacy .state.json files into SQLite (one-time)
  await this.migrateLegacyStateFiles();

  // 5. Delete legacy artifacts (.seq, .snapshot.json, .outbox.json)
  await this.cleanupLegacyFiles();
}
```

Hydration uses the **same fast-skip optimization** already in the event store: `line N = sequence N`, so lines at or below `dbSequence` are skipped without JSON.parse.

**Cold start (empty SQLite):** Full JSONL scan. ~200ms for 1,000 events across 5 streams.
**Warm start (SQLite persists from last session):** Only delta events since last shutdown. ~10ms for 20 new events.
**Corrupt SQLite:** Delete DB, full cold start. Self-healing.

### Section 6: Artifact Lifecycle

**Per-workflow artifacts (after migration):**

| Artifact | Lifecycle | Cleanup Trigger |
|----------|-----------|-----------------|
| `{id}.events.jsonl` | Append-only during workflow life | Compaction after workflow completion + retention period |
| `exarchos.db` | Shared across all workflows | Rows deleted when JSONL is compacted |

**Lifecycle policy:**

```typescript
interface LifecyclePolicy {
  /** Completed workflows older than this are eligible for compaction. */
  retentionDays: number;       // default: 30

  /** Telemetry stream max events before rotation. */
  telemetryMaxEvents: number;  // default: 10_000

  /** Max total JSONL size before warning the developer. */
  maxTotalSizeMB: number;      // default: 100
}
```

**Compaction** for completed workflows:
1. Verify workflow state is `completed` and age > `retentionDays`
2. Export a summary snapshot (final state + event count + key timestamps) as `{id}.archive.json`
3. Delete the `{id}.events.jsonl` file
4. Remove corresponding rows from SQLite

**Telemetry rotation:**
1. When `telemetry.events.jsonl` exceeds `telemetryMaxEvents`, rename to `telemetry.events.jsonl.1` and start fresh
2. Keep at most 2 rotated files (current + 1 archive)
3. SQLite telemetry rows older than `retentionDays` are pruned

The `exarchos_workflow` `cleanup` action (post-merge) is the natural trigger for compaction eligibility. A background check on startup handles aged-out workflows.

### Section 7: Surgical Fixes (Independent of SQLite)

These fixes address findings F1-F4 and are valuable regardless of the SQLite migration. They should be implemented first as a prerequisite:

| Fix | Finding | Change |
|-----|---------|--------|
| Pass `sinceSequence` to `store.query()` in all view handlers | F1, F2 | ~50 LOC across `views/tools.ts` |
| Skip `loadFromSnapshot` when materializer has in-memory state | F4 | ~20 LOC in each view handler |
| Eliminate redundant third query in `reconcileFromEvents` | F3 | ~30 LOC in `state-store.ts` |
| Fix outbox `drain` to batch updates instead of per-entry load/save | F8 | ~40 LOC in `outbox.ts` |
| Atomic snapshot writes (tmp+rename) | F11 | ~10 LOC in `snapshot-store.ts` |

These ~150 LOC of surgical fixes provide immediate value and reduce the urgency of the SQLite migration. They can be shipped in a single PR before the larger migration begins.

---

## Integration Points

### Existing Module Changes

| Module | Change Type | Description |
|--------|-------------|-------------|
| `event-store/store.ts` | Refactor | Delegate reads to `StorageBackend`, keep JSONL append as durable write |
| `workflow/state-store.ts` | Refactor | Delegate to `StorageBackend` for read/write, remove file-level CAS (SQLite handles it) |
| `views/materializer.ts` | Simplify | Use `StorageBackend.getViewCache/setViewCache` instead of `SnapshotStore` |
| `views/tools.ts` | Simplify | Remove snapshot loading ceremony, query delta events from backend |
| `sync/outbox.ts` | Refactor | Delegate to `StorageBackend.addOutboxEntry/drainOutbox` |
| `views/snapshot-store.ts` | Remove | Replaced by `view_cache` table in SQLite |
| `index.ts` | Update | Initialize `SqliteBackend` and pass to all module registrations |

### New Modules

| Module | Purpose |
|--------|---------|
| `storage/backend.ts` | `StorageBackend` interface |
| `storage/sqlite-backend.ts` | `better-sqlite3` implementation |
| `storage/memory-backend.ts` | In-memory implementation for tests |
| `storage/hydration.ts` | JSONL → SQLite hydration logic |
| `storage/lifecycle.ts` | Compaction, rotation, cleanup |
| `storage/migration.ts` | Legacy file → SQLite one-time migration |

### Dependency Addition

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0"
  }
}
```

`better-sqlite3` is a native dependency requiring a C++ compiler at install time. It uses prebuilt binaries for common platforms (Linux x64, macOS arm64/x64, Windows x64) so most users won't need a compiler. The package has 4M+ weekly npm downloads and is used by Drizzle ORM, Turso, and Electron.

---

## Testing Strategy

### Phase 1: StorageBackend Unit Tests

- `SqliteBackend` — test all interface methods against an in-memory SQLite (`:memory:`)
- `InMemoryBackend` — test all interface methods (trivial, used as test double)
- Migration — test legacy file detection and conversion
- Hydration — test JSONL → SQLite with various edge cases (empty, corrupt lines, gaps)

### Phase 2: Integration Tests

- Existing test suites run against `InMemoryBackend` (zero change to test behavior)
- New integration suite runs against `SqliteBackend` with real JSONL files
- Lifecycle tests — verify compaction, rotation, cleanup

### Phase 3: Performance Benchmarks

- Benchmark view query latency at 100, 500, 1000, 5000 events (before/after)
- Benchmark startup hydration time at various event counts
- Benchmark concurrent read/write (simulate teammate access patterns)

### Backward Compatibility

- First run after upgrade: legacy files auto-migrated into SQLite
- If `better-sqlite3` install fails (rare edge case): fall back to current JSONL-only behavior with surgical fixes applied
- JSONL format unchanged — no migration needed for event files

---

## Implementation Phasing

### Phase A: Surgical Fixes (1-2 tasks, no new dependencies)

Fix F1-F4, F8, F11 in the existing codebase. Immediate performance improvement. Ships independently.

### Phase B: StorageBackend Abstraction (2-3 tasks)

Introduce the `StorageBackend` interface and `InMemoryBackend`. Refactor existing modules to use the interface. All tests pass with `InMemoryBackend`. No behavioral change.

### Phase C: SQLite Implementation (3-4 tasks)

Implement `SqliteBackend`, hydration, and legacy migration. Wire into `index.ts`. Performance benchmarks.

### Phase D: Lifecycle Management (1-2 tasks)

Compaction, telemetry rotation, cleanup integration with `exarchos_workflow cleanup`.

---

## Open Questions

1. **SQLite file location** — Same directory as JSONL (`~/.claude/workflow-state/exarchos.db`) or a separate location? Same directory simplifies cleanup but mixes durable (JSONL) and derived (SQLite) artifacts.

2. **Fallback behavior** — If `better-sqlite3` fails to load (missing native binary), should the server refuse to start or fall back to JSONL-only with the surgical fixes? Fallback adds complexity but improves resilience.

3. **View projection in SQL vs in-memory** — Should some views be implemented as SQL queries directly (e.g., `SELECT COUNT(*) FROM events WHERE type = 'task.completed'`) instead of materializing in-memory? This would be simpler for aggregate views but harder for complex projections like team performance.

4. **Telemetry stream separation** — Should telemetry events go to a separate SQLite table (not the `events` table) to avoid polluting workflow event queries? The telemetry stream grows 10-100x faster than any workflow stream.
