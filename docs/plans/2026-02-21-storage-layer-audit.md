# Implementation Plan: Hybrid JSONL + SQLite Storage Layer

## Source Design
Link: `docs/designs/2026-02-21-storage-layer-audit.md`

## Scope
**Target:** Full design — all 4 implementation phases (A through D)
**Excluded:** Open Questions 1-4 are resolved inline:
- Q1 (SQLite location): Same directory as JSONL (`~/.claude/workflow-state/exarchos.db`)
- Q2 (Fallback): Server starts without SQLite; surgical fixes provide baseline performance
- Q3 (SQL views): In-memory projection remains primary; SQL used for indexed event queries only
- Q4 (Telemetry separation): Telemetry uses the same `events` table but queries filter by streamId

## Summary
- Total tasks: 18
- Parallel groups: 4
- Estimated test count: ~70
- Design coverage: 7 of 7 Technical Design sections covered

## Spec Traceability

| Design Section | Key Requirements | Task(s) | Coverage |
|---|---|---|---|
| Section 1: SQLite Schema | Schema DDL, WAL mode, indexes, migrations | 7, 8 | Full |
| Section 2: StorageBackend Abstraction | Interface definition, InMemoryBackend, SqliteBackend | 5, 6, 7, 8 | Full |
| Section 3: Write Path | JSONL-first append, SQLite derived insert, outbox transaction | 9, 10 | Full |
| Section 4: Read Path | SQLite-backed event queries, view delta reads | 11, 12 | Full |
| Section 5: Startup Hydration | JSONL → SQLite hydration, warm/cold start, self-healing | 13, 14 | Full |
| Section 6: Artifact Lifecycle | Compaction, telemetry rotation, cleanup integration | 17, 18 | Full |
| Section 7: Surgical Fixes (Independent of SQLite) | sinceSequence pass-through, snapshot regression, reconcile optimization, outbox drain, atomic snapshots | 1, 2, 3, 4 | Full |
| Integration Points | Module refactoring, dependency addition, index.ts wiring | 15, 16 | Full |
| Testing Strategy | Unit tests, integration tests, benchmarks | Embedded in each task | Full |
| Backward Compatibility | Legacy file migration, fallback without SQLite | 14, 16 | Full |

## Task Breakdown

---

### Phase A: Surgical Fixes (No New Dependencies)

---

### Task 1: Pass sinceSequence to view handlers

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `handleViewWorkflowStatus_WarmCall_QueriesOnlyDeltaEvents`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Additional tests:
     - `handleViewTasks_WarmCall_QueriesOnlyDeltaEvents`
     - `handleViewPipeline_WarmCall_QueriesOnlyDeltaEvents`
     - `handleViewTeamPerformance_WarmCall_QueriesOnlyDeltaEvents`
   - Expected failure: Tests assert `store.query()` is called with `sinceSequence` filter but current code passes no filters
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modify all `handleView*` functions in `views/tools.ts` to:
   - Read materializer's cached high-water mark via `materializer.getState(streamId, viewName)?.highWaterMark`
   - Pass `{ sinceSequence: hwm }` to `store.query(streamId, filters)` when HWM > 0
   - File: `servers/exarchos-mcp/src/views/tools.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract a shared `queryDeltaEvents(store, materializer, streamId, viewName)` helper to eliminate duplication across handlers
   - Run: `npm run test:run` - MUST STAY GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, performanceSLAs: [{ operation: "view-query-warm", metric: "p99_ms", threshold: 5 }] }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Skip loadFromSnapshot on warm calls

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `handleViewWorkflowStatus_WarmCall_SkipsSnapshotLoad`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Additional test: `handleViewWorkflowStatus_ColdCall_LoadsSnapshot`
   - Expected failure: Tests assert `loadFromSnapshot` is NOT called when materializer already has cached state, but current code always calls it
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add conditional: only call `materializer.loadFromSnapshot()` when `materializer.getState(streamId, viewName)` returns undefined
   - File: `servers/exarchos-mcp/src/views/tools.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Combine with Task 1's helper into a unified `materializeView(store, materializer, streamId, viewName, events)` function
   - Run: `npm run test:run` - MUST STAY GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 1
**Parallelizable:** No (shares file with Task 1)

---

### Task 3: Fix reconcileFromEvents redundant queries

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `reconcileFromEvents_WithDeltaEvents_QueriesStreamOnce`
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Additional test: `reconcileFromEvents_PhaseReconciliation_UsesLastTransitionFromDelta`
   - Expected failure: Tests spy on `eventStore.query` and assert it's called at most once for the delta path, but current code calls it 2-3 times
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Refactor `reconcileFromEvents` to:
   - Track last `workflow.transition` event during the delta scan loop (line 617-625)
   - Remove the second `eventStore.query(featureId)` call at line 632
   - Use the tracked last-transition for phase reconciliation
   - File: `servers/exarchos-mcp/src/workflow/state-store.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] No refactoring needed — the change is already minimal

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: Fix outbox drain O(n²) and atomic snapshot writes

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `drain_BatchOfN_LoadsEntriesOnce`
   - File: `servers/exarchos-mcp/src/sync/outbox.test.ts`
   - Additional tests:
     - `drain_BatchOfN_SavesEntriesOnce`
     - `snapshotSave_CrashDuringWrite_DoesNotCorruptExistingSnapshot`
   - Expected failure: Drain test asserts single `loadEntries`/`saveEntries` per batch; current implementation calls them per entry
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Refactor `Outbox.drain()` to:
   - Load entries once at batch start
   - Process all pending entries in memory
   - Save once at batch end
   - File: `servers/exarchos-mcp/src/sync/outbox.ts`
   - Also fix `SnapshotStore.save()` to use tmp+rename:
   - File: `servers/exarchos-mcp/src/views/snapshot-store.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] No further refactoring needed

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Phase B: StorageBackend Abstraction

---

### Task 5: Define StorageBackend interface

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `StorageBackend_InterfaceContract_AllMethodsDefined`
   - File: `servers/exarchos-mcp/src/storage/backend.test.ts`
   - Additional tests:
     - `InMemoryBackend_appendEvent_IncrementsSequence`
     - `InMemoryBackend_queryEvents_FiltersBySinceSequence`
     - `InMemoryBackend_queryEvents_FiltersByType`
     - `InMemoryBackend_getSequence_ReturnsZeroForUnknownStream`
   - Expected failure: Module `storage/backend.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create:
   - `servers/exarchos-mcp/src/storage/backend.ts` — `StorageBackend` interface with event, state, outbox, view cache, and lifecycle operations
   - Include all types: `QueryFilters`, `ViewCacheEntry`, `DrainResult`, `EventSender`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure type exports align with existing `QueryFilters` in `event-store/store.ts` — re-export or consolidate

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** None
**Parallelizable:** Yes

---

### Task 6: Implement InMemoryBackend

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `InMemoryBackend_setState_GetState_Roundtrip`
   - File: `servers/exarchos-mcp/src/storage/memory-backend.test.ts`
   - Additional tests:
     - `InMemoryBackend_setState_CASConflict_Throws`
     - `InMemoryBackend_listStates_ReturnsAllStored`
     - `InMemoryBackend_addOutboxEntry_DrainOutbox_SendsAndRemoves`
     - `InMemoryBackend_getViewCache_ReturnsNullWhenEmpty`
     - `InMemoryBackend_setViewCache_GetViewCache_Roundtrip`
     - `InMemoryBackend_initialize_Close_NoOpSafely`
   - Expected failure: Module `storage/memory-backend.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `servers/exarchos-mcp/src/storage/memory-backend.ts`:
   - Map-based in-memory storage for all operations
   - CAS versioning for state operations
   - FIFO ordering for outbox entries
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract shared validation logic between backend interface and implementation

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["roundtrip: getState(setState(x)) === x for all valid states", "CAS: concurrent setState with same expectedVersion — exactly one succeeds"] }`
**Dependencies:** Task 5
**Parallelizable:** No (depends on Task 5 interface)

---

### Phase C: SQLite Implementation

---

### Task 7: Implement SqliteBackend — schema and event operations

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `SqliteBackend_initialize_CreatesAllTables`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - Additional tests:
     - `SqliteBackend_appendEvent_InsertsIntoEventsTable`
     - `SqliteBackend_queryEvents_NoFilter_ReturnsAll`
     - `SqliteBackend_queryEvents_SinceSequence_ReturnsOnlyNewer`
     - `SqliteBackend_queryEvents_ByType_FiltersCorrectly`
     - `SqliteBackend_queryEvents_ByTimeRange_FiltersCorrectly`
     - `SqliteBackend_queryEvents_WithLimitAndOffset_Paginates`
     - `SqliteBackend_getSequence_ReturnsMaxSequenceForStream`
     - `SqliteBackend_getSequence_UnknownStream_ReturnsZero`
     - `SqliteBackend_initialize_WALModeEnabled`
     - `SqliteBackend_concurrentReadWrite_WALMode_NoBlocking`
   - Expected failure: Module `storage/sqlite-backend.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `servers/exarchos-mcp/src/storage/sqlite-backend.ts`:
   - Import `Database` from `better-sqlite3`
   - `initialize()`: create DB, set `PRAGMA journal_mode = WAL`, `PRAGMA synchronous = NORMAL`, run schema DDL
   - `appendEvent()`: prepared statement INSERT into `events` + UPSERT into `sequences`
   - `queryEvents()`: SELECT with WHERE clauses for all `QueryFilters` fields
   - `getSequence()`: SELECT from `sequences` table
   - Use `:memory:` for all tests (no disk I/O)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract schema DDL into a constant, add schema version tracking table

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: true, properties: ["append-query roundtrip: queryEvents returns exactly the events appended", "sequence monotonicity: getSequence increases strictly with each append"], performanceSLAs: [{ operation: "sqlite-append", metric: "p99_ms", threshold: 2 }, { operation: "sqlite-query-by-sequence", metric: "p99_ms", threshold: 1 }] }`
**Dependencies:** Task 5
**Parallelizable:** Yes (alongside Task 6)

---

### Task 8: Implement SqliteBackend — state, outbox, and view cache operations

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `SqliteBackend_setState_GetState_Roundtrip`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - Additional tests:
     - `SqliteBackend_setState_CASConflict_ThrowsVersionConflictError`
     - `SqliteBackend_setState_AutoIncrementsVersion`
     - `SqliteBackend_listStates_ReturnsAllWorkflows`
     - `SqliteBackend_addOutboxEntry_CreatesWithPendingStatus`
     - `SqliteBackend_drainOutbox_SendsPendingAndUpdatesStatus`
     - `SqliteBackend_drainOutbox_FailedEntry_SetsRetryAndIncrementsAttempts`
     - `SqliteBackend_drainOutbox_MaxRetries_MarksDeadLetter`
     - `SqliteBackend_getViewCache_SetViewCache_Roundtrip`
     - `SqliteBackend_setViewCache_Upserts_OnConflict`
     - `SqliteBackend_appendEvent_WithOutbox_BothInSameTransaction`
   - Expected failure: State/outbox/view methods not yet implemented
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Extend `SqliteBackend`:
   - `getState/setState/listStates`: CRUD on `workflow_state` table with CAS via `version` column
   - `addOutboxEntry/drainOutbox`: INSERT/SELECT/UPDATE on `outbox` table with retry backoff
   - `getViewCache/setViewCache`: UPSERT on `view_cache` table
   - Transactional event+outbox append via `db.transaction()`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Consolidate prepared statements into a `Statements` object initialized once

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["CAS linearizability: concurrent setState with same expectedVersion — exactly one succeeds", "outbox drain idempotence: drain(drain(x)) === drain(x) for confirmed entries"] }`
**Dependencies:** Task 7
**Parallelizable:** No (extends Task 7's file)

---

### Task 9: Refactor EventStore to use StorageBackend for reads

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EventStore_query_DelegatesToBackend`
   - File: `servers/exarchos-mcp/src/event-store/store.test.ts`
   - Additional tests:
     - `EventStore_query_WithBackend_DoesNotReadJSONL`
     - `EventStore_query_WithoutBackend_FallsBackToJSONL`
     - `EventStore_append_WritesToJSONLAndBackend`
     - `EventStore_getSequence_DelegatesToBackend`
   - Expected failure: EventStore constructor does not accept a `StorageBackend` parameter
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modify `EventStore`:
   - Accept optional `StorageBackend` in constructor
   - `query()`: if backend is set, delegate to `backend.queryEvents()`; else fall back to existing JSONL scan
   - `append()`: write to JSONL first, then call `backend.appendEvent()` if set
   - `getSequence()` / `initializeSequence()`: delegate to `backend.getSequence()` if set
   - File: `servers/exarchos-mcp/src/event-store/store.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove `sequenceCounters` Map and `.seq` file logic when backend is present (the backend handles sequences)

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 5, Task 6
**Parallelizable:** No (modifies core EventStore)

---

### Task 10: Refactor Outbox to use StorageBackend

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `Outbox_addEntry_WithBackend_DelegatesToBackend`
   - File: `servers/exarchos-mcp/src/sync/outbox.test.ts`
   - Additional tests:
     - `Outbox_drain_WithBackend_DelegatesToBackend`
     - `Outbox_addEntry_WithoutBackend_UsesJSONFile`
   - Expected failure: Outbox constructor does not accept a `StorageBackend` parameter
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modify `Outbox`:
   - Accept optional `StorageBackend` in constructor
   - When backend is set, delegate `addEntry`, `drain`, `loadEntries`, `updateEntry` to backend
   - When backend is not set, use existing JSON file logic (fallback)
   - File: `servers/exarchos-mcp/src/sync/outbox.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract the JSON file logic into a private helper class for cleaner fallback separation

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 5, Task 6
**Parallelizable:** Yes (alongside Task 9)

---

### Task 11: Refactor ViewMaterializer to use StorageBackend for cache

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ViewMaterializer_loadFromSnapshot_WithBackend_ReadsFromViewCache`
   - File: `servers/exarchos-mcp/src/views/materializer.test.ts`
   - Additional tests:
     - `ViewMaterializer_materialize_WithBackend_SavesViewCacheOnInterval`
     - `ViewMaterializer_materialize_WithBackend_SkipsSnapshotStore`
   - Expected failure: ViewMaterializer does not accept a `StorageBackend` parameter
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modify `ViewMaterializer`:
   - Accept optional `StorageBackend` in `MaterializerOptions`
   - `loadFromSnapshot()`: if backend set, use `backend.getViewCache()`; else use existing `SnapshotStore`
   - `materialize()`: if backend set, use `backend.setViewCache()` for interval saves; else use `SnapshotStore`
   - File: `servers/exarchos-mcp/src/views/materializer.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] When backend is present, `SnapshotStore` is unused — make its construction conditional

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 5, Task 6
**Parallelizable:** Yes (alongside Tasks 9, 10)

---

### Task 12: Refactor view handlers to use backend-aware query path

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `handleViewWorkflowStatus_WithBackend_QueriesSQLite`
   - File: `servers/exarchos-mcp/src/views/tools.test.ts`
   - Additional tests:
     - `handleViewPipeline_WithBackend_DiscoverStreamsFromSQLite`
     - `handleViewTasks_WithBackend_QueriesSQLite`
   - Expected failure: View handlers still query JSONL via EventStore regardless of backend
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Update view handlers to leverage the refactored EventStore (Task 9):
   - Since EventStore.query now delegates to backend when available, handlers automatically benefit
   - Update `discoverStreams` to use `SELECT DISTINCT streamId FROM events` when backend is available
   - Remove redundant `loadFromSnapshot` calls (already done in Task 2, verify integration)
   - File: `servers/exarchos-mcp/src/views/tools.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove `getOrCreateEventStore` singleton pattern — EventStore is now injected via `registerViewTools`

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, performanceSLAs: [{ operation: "view-query-with-sqlite", metric: "p99_ms", threshold: 3 }] }`
**Dependencies:** Task 9, Task 11
**Parallelizable:** No (depends on Tasks 9, 11)

---

### Task 13: Implement JSONL → SQLite hydration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `hydrateStream_EmptyDB_InsertsAllEvents`
   - File: `servers/exarchos-mcp/src/storage/hydration.test.ts`
   - Additional tests:
     - `hydrateStream_PartialDB_InsertsOnlyDeltaEvents`
     - `hydrateStream_CorruptJSONLLine_SkipsAndContinues`
     - `hydrateStream_EmptyJSONL_NoOps`
     - `hydrateStream_FastSkip_SkipsLinesBeforeDBSequence`
     - `hydrateAll_MultipleStreams_HydratesEach`
   - Expected failure: Module `storage/hydration.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `servers/exarchos-mcp/src/storage/hydration.ts`:
   - `hydrateStream(backend, stateDir, streamId)`: read JSONL using readline, fast-skip lines ≤ backend.getSequence(), INSERT delta events
   - `hydrateAll(backend, stateDir)`: discover all `*.events.jsonl` files, call `hydrateStream` for each
   - Use `createReadStream` + `createInterface` for streaming (don't load full file into memory)
   - Skip corrupt lines with a warning log (don't throw)
   - File: `servers/exarchos-mcp/src/storage/hydration.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Use `better-sqlite3` transaction for batch inserts (INSERT multiple rows per transaction for speed)

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: true, properties: ["hydration idempotence: hydrateStream(hydrateStream(x)) === hydrateStream(x)", "sequence preservation: events in SQLite have same sequences as JSONL"], performanceSLAs: [{ operation: "hydrate-1000-events", metric: "p99_ms", threshold: 200 }] }`
**Dependencies:** Task 7
**Parallelizable:** Yes (alongside Tasks 8-12)

---

### Task 14: Implement legacy file migration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `migrateLegacyStateFiles_WithStateJSON_MigratesIntoSQLite`
   - File: `servers/exarchos-mcp/src/storage/migration.test.ts`
   - Additional tests:
     - `migrateLegacyStateFiles_NoLegacyFiles_NoOps`
     - `migrateLegacyStateFiles_CorruptStateJSON_SkipsWithWarning`
     - `cleanupLegacyFiles_RemovesSeqAndSnapshotAndOutboxFiles`
     - `cleanupLegacyFiles_MissingFiles_NoError`
     - `migrateLegacyOutbox_WithOutboxJSON_MigratesEntries`
   - Expected failure: Module `storage/migration.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `servers/exarchos-mcp/src/storage/migration.ts`:
   - `migrateLegacyStateFiles(backend, stateDir)`: find `*.state.json`, parse, insert into `workflow_state` table, rename original to `.state.json.migrated`
   - `migrateLegacyOutbox(backend, stateDir)`: find `*.outbox.json`, parse, insert entries into `outbox` table
   - `cleanupLegacyFiles(stateDir)`: remove `*.seq`, `*.snapshot.json`, `*.state.json.migrated`, `*.outbox.json` files
   - File: `servers/exarchos-mcp/src/storage/migration.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] No refactoring needed

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Task 7, Task 8
**Parallelizable:** Yes (alongside Task 13)

---

### Task 15: Install better-sqlite3 and wire SqliteBackend into index.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `createServer_InitializesSqliteBackend`
   - File: `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts` (extend existing)
   - Additional tests:
     - `createServer_MissingSQLiteBinary_StartsWithJSONLFallback`
     - `createServer_CorruptSQLiteDB_DeletesAndRebuildsFromJSONL`
   - Expected failure: index.ts does not instantiate SqliteBackend
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modifications:
   - `npm install better-sqlite3` + `npm install -D @types/better-sqlite3` in `servers/exarchos-mcp/`
   - Update `index.ts`:
     - Import `SqliteBackend` and `hydrateAll` and `migrateLegacyStateFiles`
     - In `createServer()`: try/catch on `SqliteBackend` initialization — if `better-sqlite3` fails to load, log warning and start with JSONL-only (surgical fixes provide baseline performance)
     - On success: call `backend.initialize()`, `hydrateAll()`, `migrateLegacyStateFiles()`
     - Handle corrupt SQLite: catch initialization errors, delete DB file, retry initialization once (self-healing from JSONL)
     - Pass backend to `EventStore`, `Outbox`, `ViewMaterializer` constructors (or `undefined` in fallback mode)
     - Register cleanup handler to call `backend.close()` on process exit
   - File: `servers/exarchos-mcp/src/index.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure `createServer` accepts an optional backend parameter for test injection

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Tasks 7-14 (all SQLite implementation tasks)
**Parallelizable:** No (final wiring)

---

### Task 16: Refactor state-store to use StorageBackend

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `readStateFile_WithBackend_ReadsFromSQLite`
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Additional tests:
     - `writeStateFile_WithBackend_WritesToSQLite`
     - `writeStateFile_WithBackend_CASConflict_Throws`
     - `initStateFile_WithBackend_InsertsIntoSQLite`
     - `listStateFiles_WithBackend_QueriesSQLite`
     - `readStateFile_WithoutBackend_FallsBackToJSONFile`
   - Expected failure: State store functions don't accept or use a StorageBackend
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Modify state-store module-level functions:
   - Accept optional `StorageBackend` parameter (or configure via module-level setter like `configureStateStoreBackend()`)
   - `readStateFile`: if backend set, use `backend.getState(featureId)`; else existing file logic
   - `writeStateFile`: if backend set, use `backend.setState()`; else existing file logic
   - `listStateFiles`: if backend set, use `backend.listStates()`; else existing dir scan
   - `initStateFile`: if backend set, use `backend.setState()` with version check; else existing file logic
   - File: `servers/exarchos-mcp/src/workflow/state-store.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove file-level CAS read-then-write pattern when backend is available (SQLite handles atomicity)

**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["CAS: concurrent writeStateFile with same expectedVersion — exactly one succeeds"] }`
**Dependencies:** Task 5, Task 6
**Parallelizable:** Yes (alongside Tasks 9-12)

---

### Phase D: Lifecycle Management

---

### Task 17: Implement workflow compaction

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `compactWorkflow_CompletedAndOlderThanRetention_ArchivesAndDeletes`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.test.ts`
   - Additional tests:
     - `compactWorkflow_ActiveWorkflow_NoOps`
     - `compactWorkflow_CompletedButTooRecent_NoOps`
     - `compactWorkflow_ArchiveContainsFinalStateAndEventCount`
     - `compactWorkflow_DeletesJSONLAndSQLiteRows`
     - `checkCompaction_OnStartup_CompactsEligibleWorkflows`
     - `checkCompaction_TotalSizeExceedsLimit_EmitsWarning`
   - Expected failure: Module `storage/lifecycle.ts` does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `servers/exarchos-mcp/src/storage/lifecycle.ts`:
   - `compactWorkflow(backend, stateDir, featureId, policy)`: verify completed + aged, export archive JSON, delete JSONL + SQLite rows
   - `checkCompaction(backend, stateDir, policy)`: list all states, find eligible, compact each
   - `LifecyclePolicy` type with defaults
   - File: `servers/exarchos-mcp/src/storage/lifecycle.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Integrate compaction trigger into `exarchos_workflow` cleanup action

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Tasks 7, 8, 15
**Parallelizable:** Yes (alongside Task 18)

---

### Task 18: Implement telemetry rotation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `rotateTelemetry_ExceedsMaxEvents_RotatesJSONL`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.test.ts`
   - Additional tests:
     - `rotateTelemetry_BelowMaxEvents_NoOps`
     - `rotateTelemetry_KeepsAtMostTwoRotatedFiles`
     - `rotateTelemetry_PrunesOldSQLiteRows`
     - `rotateTelemetry_RotatedFileIsReadableJSONL`
   - Expected failure: No `rotateTelemetry` function exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add to `servers/exarchos-mcp/src/storage/lifecycle.ts`:
   - `rotateTelemetry(backend, stateDir, policy)`:
     - Count events in telemetry stream (via `backend.getSequence('telemetry')`)
     - If > maxEvents: rename current JSONL to `.1`, delete `.2` if exists, rename `.1` to `.2`
     - Prune SQLite rows older than `retentionDays`
     - Reset sequence counter for the telemetry stream
   - File: `servers/exarchos-mcp/src/storage/lifecycle.ts`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Wire into startup sequence in `index.ts` — call `rotateTelemetry` after hydration

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`
**Dependencies:** Tasks 7, 8, 15
**Parallelizable:** Yes (alongside Task 17)

---

## Parallelization Strategy

```
Phase A (surgical fixes — no new deps):
  ┌── Task 1: sinceSequence in view handlers ─┐
  │   └── Task 2: skip loadFromSnapshot (same file) │
  ├── Task 3: reconcileFromEvents fix ─────────────┤
  └── Task 4: outbox drain + atomic snapshots ─────┘
                         │
Phase B (abstraction layer):
  ┌── Task 5: StorageBackend interface ────────┐
  │   └── Task 6: InMemoryBackend ─────────────┤
  │                                             │
Phase C (SQLite impl — parallel groups):        │
  │   ┌── Task 7: SqliteBackend events ────────┤
  │   │   └── Task 8: SqliteBackend state/outbox/cache
  │   │                    │
  │   ├── Task 13: Hydration ─────────────┐    │
  │   └── Task 14: Legacy migration ──────┤    │
  │                                        │    │
  ├── Task 9: EventStore refactor ────────┤    │
  ├── Task 10: Outbox refactor ───────────┤    │
  ├── Task 11: ViewMaterializer refactor ─┤    │
  ├── Task 16: state-store refactor ──────┤    │
  │                                        │    │
  └── Task 12: View handler integration ──┤    │
                         │                 │    │
  Task 15: Wire into index.ts ────────────┘    │
                         │                      │
Phase D (lifecycle):     │                      │
  ┌── Task 17: Compaction ─────────────────────┘
  └── Task 18: Telemetry rotation ─────────────┘
```

**Parallel groups for delegation:**

| Group | Tasks | Worktree | Notes |
|-------|-------|----------|-------|
| Group 1 | 1, 2 | `wt-surgical-views` | View handler fixes (same files) |
| Group 2 | 3 | `wt-surgical-reconcile` | State store fix (independent file) |
| Group 3 | 4 | `wt-surgical-outbox` | Outbox + snapshot fix (independent files) |
| Group 4 | 5, 6 | `wt-backend-interface` | Interface + InMemoryBackend |
| Group 5 | 7, 8 | `wt-sqlite-backend` | SqliteBackend full implementation |
| Group 6 | 13, 14 | `wt-hydration-migration` | Hydration + legacy migration |
| Group 7 | 9, 10, 11, 16 | `wt-module-refactor` | All module refactors to use backend |
| Group 8 | 12 | `wt-view-integration` | View handler integration (after Group 7) |
| Group 9 | 15 | `wt-wiring` | Final index.ts wiring (after all) |
| Group 10 | 17, 18 | `wt-lifecycle` | Compaction + rotation (after Group 9) |

**Maximum parallelism:** Groups 1, 2, 3 can run simultaneously (Phase A). Groups 4, 5, 6 can run simultaneously (Phase B/C early). Groups 7 runs after 4. Group 8 after 7. Group 9 after all. Group 10 after 9.

## Deferred Items

| Item | Rationale |
|------|-----------|
| SQL-based view projections (Open Q3) | Keep in-memory projection as primary. SQL views can be explored later if specific views benefit |
| Separate telemetry SQLite table (Open Q4) | Use same `events` table with `streamId = 'telemetry'` filtering. Separate table is premature optimization |
| Performance benchmarks at scale (5000+ events) | Deferred to post-integration performance testing sprint |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Existing tests unbroken (backward compatibility)
- [ ] Legacy file migration tested with real workflow state files
- [ ] Ready for review
