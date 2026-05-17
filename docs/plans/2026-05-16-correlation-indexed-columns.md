# Implementation Plan — Correlation Indexed Columns + Telemetry Filters

**Design:** [`docs/designs/2026-05-16-correlation-indexed-columns.md`](../designs/2026-05-16-correlation-indexed-columns.md)
**Feature ID:** `correlation-indexed-columns`
**Issues:** [#1437](https://github.com/lvlup-sw/exarchos/issues/1437) (storage + view filters) bundled with [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) (`_meta` preserve + cache-hit `operationId`)
**Epic:** [#1441](https://github.com/lvlup-sw/exarchos/issues/1441)
**PR shape:** single bundled PR off `main` → `feature/correlation-indexed-columns`
**Date:** 2026-05-16
**Total tasks:** 19, organized into 7 waves

## Iron Law

> NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
>
> Every task that modifies production behavior begins with a RED test (assert the new behavior; assert it fails for the right reason). GREEN is the minimum production change to flip RED green. REFACTOR is optional — only if duplication or cohesion suffers.

## Wave overview

| Wave | Theme | Tasks | Parallel? | Depends on |
|---|---|---|---|---|
| 1 | #1414 regression coverage (verification-first) | 1-2 | Yes (within wave) | — |
| 2 | Schema substrate V5 → V6 | 3-6 | Sequential chain | Wave 1 (any) |
| 3 | Writer path | 7-8 | Sequential chain | Wave 2 |
| 4 | Filter API | 9-12 | Mostly parallel (within wave) | Wave 3 |
| 5 | Telemetry view wiring | 13-15 | Two parallel groups + a derived assertion | Wave 4 |
| 6 | #1291 acceptance integration tests | 16-18 | Yes (within wave) | Wave 5 |
| 7 | Documentation | 19 | — | Wave 6 |

Wave-2 must finish before Wave-3 starts (writer path needs the columns to exist). Wave-3 must finish before Wave-4 starts (filter path needs columns populated on new appends so its tests are meaningful). Wave-5 depends on Wave-4 (view actions thread filters through `EventStore.queryEvents`). Wave-6 exercises the whole stack end-to-end.

Branch strategy: single `feature/correlation-indexed-columns` off `main`. Subagent worktrees branch from this integration branch (per `feedback_subagent_nested_worktrees`).

---

## Wave 1 — #1414 regression coverage (verification-first)

Both tasks should go **GREEN on the first run** if the design's code-trace conclusion (inline fix already present in #1428's post-merge hardening) is correct. If either goes RED, that test becomes the genuine RED for an inline gap missed in the trace — add a `Task 1.5` production fix before continuing to Wave 2.

### Task 1: F1 regression test — dispatch preserves inbound `_meta`

**Phase:** RED → assert GREEN

1. **[RED]** Write test: `Dispatch_BuiltInTool_PreservesInbound_meta`
   - **File:** `servers/exarchos-mcp/src/core/dispatch.test.ts` (append to existing suite)
   - **Test body:** Construct a `DispatchContext` minimally (memory backend, no MCP roots, no elicitation). Call `dispatch('exarchos_workflow', { action: 'get', featureId: 'test', _meta: { correlationId: 'corr-from-caller-7', causationId: 'event-upstream-3' } }, ctx)`. Assert `result._meta.correlationId === 'corr-from-caller-7'`, `result._meta.causationId === 'event-upstream-3'`, `result._meta.operationId` matches UUID regex (freshly minted, not the caller's).
   - **Expected outcome:** GREEN on first run (the inline fix at `dispatch.ts:604` is present in current main).

2. **[GREEN-IF-RED]** If the test fails, inspect the actual `result._meta`. The likely cause would be `_meta` being stripped between `args = rest` (line 543) and the `incoming` derivation (line 604) — investigate before patching. Do NOT change the test to fit current behavior; fix the production code to satisfy the test as written.

**Dependencies:** None
**Parallelizable:** Yes (with Task 2)

---

### Task 2: F2 regression test — batchAppend cache-hit returns `operationId`

**Phase:** RED → assert GREEN

1. **[RED]** Write test: `BatchAppend_CacheHit_ReturnsOperationId`
   - **File:** `servers/exarchos-mcp/src/event-store/tools.test.ts` (append to existing suite that already covers batchAppend cache-hit corner cases at line 360)
   - **Test body:** Inside `runWithDispatchContext({ operationId: 'op-xyz', correlationId: 'cor-xyz' }, ...)`, call `store.batchAppend('s1', [{ type: 't.created', idempotencyKey: 'k1', data: { id: 1 } }])`. Capture first result; assert `first[0].operationId === 'op-xyz'`. Call batchAppend again with the same key (cache-hit branch); assert `replay[0].operationId === 'op-xyz'`.
   - **Expected outcome:** GREEN on first run (the inline fix at `store.ts:467-471` is present in current main).

2. **[GREEN-IF-RED]** If the test fails, inspect the cache-hit mapping. The likely cause would be the `operationId` passthrough at lines 467-471 not being reached or the field name differing — investigate before patching.

**Dependencies:** None
**Parallelizable:** Yes (with Task 1)

---

## Wave 2 — Schema substrate V5 → V6

Strict sequential chain: each task changes a piece of `sqlite-backend.ts` that the next one builds on.

### Task 3: V6 SCHEMA_DDL + SCHEMA_VERSION bump

**Phase:** RED → GREEN

1. **[RED]** Write test: `SqliteBackend_FreshDb_SchemaV6_HasCorrelationColumnsAndIndexes`
   - **File:** `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - **Test body:** Open a fresh tmp DB via `new SqliteBackend(...)` + `initialize()`. Query `PRAGMA table_info(events)` and assert columns include `operation_id`, `correlation_id`, `causation_id` (all `TEXT NULL`). Query `sqlite_master WHERE type='index'` and assert `idx_events_correlation`, `idx_events_causation`, and `idx_events_operation` all exist. Query `schema_version` and assert the max stamped version is `6`.
   - **Expected failure:** Columns absent; max schema_version is 5.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Bump `SCHEMA_VERSION` from 5 to 6 at line 54.
   - Extend `SCHEMA_DDL` events table (lines 57-65) with three `TEXT` columns (`operation_id`, `correlation_id`, `causation_id`) before the `PRIMARY KEY` line.
   - Extend `SCHEMA_DDL` index block (lines 66-67) with `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence)`, `CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id)`, and `CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id)`.
   - Update the `migrateSchema` JSDoc (lines 409-431) with the new `V5 -> V6` summary line.

3. **[REFACTOR]** None needed.

**Dependencies:** Wave 1 (sequencing — verification-first principle)
**Parallelizable:** No (other Wave-2 tasks build on this)

---

### Task 4: `migrateV5ToV6` helper — DDL portion (legacy V5 DB upgrade)

**Phase:** RED → GREEN

1. **[RED]** Write test: `MigrateV5ToV6_LegacyV5Db_AddsCorrelationColumnsAndStampsLedger`
   - **File:** `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - **Test body:** Set up a V5 DB manually — `CREATE TABLE events (...)` with V5 columns only, `INSERT INTO schema_version (version, appliedAt) VALUES (5, ?)`. Close, reopen via `SqliteBackend.initialize()`. Assert PRAGMA `table_info(events)` shows the new three columns; assert `schema_version` contains a `6` entry; assert the existing events still exist (UPDATE did not corrupt rows).
   - **Expected failure:** Test crashes during `initialize()` because `SCHEMA_DDL`'s `CREATE TABLE IF NOT EXISTS` won't re-add columns to an existing table.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Add `private migrateV5ToV6(): void` after `migrateV4ToV5` (modelled on V3→V4 transactional pattern, lines 522-595). Inside one `db.transaction(...)`:
     - `ALTER TABLE events ADD COLUMN operation_id TEXT`
     - `ALTER TABLE events ADD COLUMN correlation_id TEXT`
     - `ALTER TABLE events ADD COLUMN causation_id TEXT`
     - `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence)`
     - `CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id)`
     - `CREATE INDEX IF NOT EXISTS idx_events_operation ON events(operation_id)`
     - `INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (6, ?)`
   - Wire `migrateSchema` (line 472-478 area) to gate-and-call `migrateV5ToV6` if `version=6` row absent.

3. **[REFACTOR]** None needed; matches existing migrator-helper pattern.

4. **[RED-SECONDARY]** Add inline test in the same file: `MigrateV5ToV6_FreshDbWithNoPriorEvents_NoOpsCleanly`
   - **Test body:** Open a fresh tmp DB (no manual V5 setup) via `new SqliteBackend(...)` + `initialize()`. Assert `schema_version` contains a `6` entry; assert `events` table is empty; assert no rows exist on the internal `__migration__` stream (`SELECT COUNT(*) FROM events WHERE streamId = '__migration__'` returns 0). This pins the no-op contract — a fresh-DB migration should not emit progress events because there's nothing to backfill.
   - **Expected outcome:** GREEN once Task 4's `migrateV5ToV6` is in place; no production code needed beyond Task 4's body.

**Dependencies:** Task 3
**Parallelizable:** No

---

### Task 5: `migrateV5ToV6` — backfill from `payload` JSON (no chunking yet)

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `MigrateV5ToV6_LegacyV5DbWithPayloadEvents_BackfillsCorrelationColumns`
   - **File:** `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - **Test body:** Set up a V5 DB. Insert events whose `payload` JSON contains `"correlationId":"corr-A","operationId":"op-A","causationId":"cause-A"`. Insert another event whose payload lacks all three (pre-#1428 event). Close, reopen, assert: tagged event row has `correlation_id='corr-A'` etc.; untagged event row has NULL columns; row count unchanged.
   - **Expected failure:** New columns exist (from Task 4) but stay NULL because no backfill ran.

2. **[GREEN]** Extend `migrateV5ToV6` inside the same transaction:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - After the ALTER statements and before the `schema_version` stamp, run:
     ```sql
     UPDATE events
       SET operation_id   = json_extract(payload, '$.operationId'),
           correlation_id = json_extract(payload, '$.correlationId'),
           causation_id   = json_extract(payload, '$.causationId')
       WHERE correlation_id IS NULL
     ```
   - Add JSDoc explaining: rows with unparseable or untagged payload keep NULL columns (pre-#1428 events have no correlation data; that's the correct fallback).

3. **[REFACTOR]** No extraction needed yet — chunking is Task 6.

**Dependencies:** Task 4
**Parallelizable:** No

---

### Task 6: Chunked backfill + `migration.correlation_backfill_progress` event

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `MigrateV5ToV6_LargeDb_ChunksBackfillAndEmitsProgressEvents`
   - **File:** `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts`
   - **Test body:** Set up a V5 DB with 2,500 events across a few streams, all carrying tagged payload. Close, reopen. Assert: every row has populated columns; query the internal `__migration__` stream and assert ≥3 `migration.correlation_backfill_progress` events landed (chunk size 1,000 → 3 chunks); assert each progress event's payload includes `{rowsBackfilled, totalRowsRemaining}`.
   - **Expected failure:** Backfill is single-shot (Task 5), no progress events.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Refactor the Task-5 single UPDATE into a chunked loop. Outer loop body: `UPDATE … WHERE correlation_id IS NULL LIMIT 1000`; capture `changes()` rows-affected. Emit `migration.correlation_backfill_progress` event on the `__migration__` stream via the existing `insertEvent`+`upsertSeq` pattern (mirrors V3→V4 `emitWorkflowTypeUnknownEvents` at lines 742-805). Loop until `rows-affected === 0`.
   - **File:** `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Register `'migration.correlation_backfill_progress'` in `EventType` union (line ~118), in `EVENT_EMISSION_REGISTRY` with `source: 'auto'` (around line 434), and in `EVENT_DATA_SCHEMAS` with `z.object({ rowsBackfilled: z.number(), totalRowsRemaining: z.number() })`. Add a JSDoc block near line 1627 modelled on `migration.workflow_type_unknown` documenting the event.

3. **[REFACTOR]** If chunk-emit pattern feels duplicated against `emitWorkflowTypeUnknownEvents`, extract a `private emitMigrationEvent(streamId, type, data)` helper. Optional — not required by the test.

**Dependencies:** Task 5
**Parallelizable:** No

---

## Wave 3 — Writer path

Sequential: prepared statements first, then atomic-appender bindings.

### Task 7: Update `insertEvent` + `insertEventStrict` prepared statements

**Phase:** RED → GREEN

1. **[RED]** Write test: `AtomicAppender_AppendEvent_PopulatesCorrelationColumnsFromPayload`
   - **File:** `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts` (or `atomic-appender-consumers.test.ts` — pick whichever already covers a similar shape)
   - **Test body:** Under `runWithDispatchContext({operationId: 'op-A', correlationId: 'cor-A', causationId: 'cause-A'})`, call `eventStore.append(stream, {type: 't.x', data: {}})`. Open the raw `events` table via direct SqliteBackend handle and `SELECT operation_id, correlation_id, causation_id FROM events WHERE streamId=? AND sequence=?`. Assert all three columns hold the dispatch context's IDs.
   - **Expected failure:** Columns exist (from Wave 2) but stay NULL because the INSERT statement still binds six args.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Update `insertEvent` prepared statement (line 809-811): add `, operation_id, correlation_id, causation_id` to the column list and `, ?, ?, ?` to the VALUES list (9 binds total). Same for `insertEventStrict` (line 883-885).
   - **Deliberately keep** the `INSERT INTO events (...)` literal inside `emitWorkflowTypeUnknownEvents` at the legacy 6-column shape: that helper is invoked from the V3 → V4 migration step (`emitWorkflowTypeUnknownEvents` runs **before** `migrateV5ToV6` adds the three correlation columns), so a 9-column INSERT against a still-V5 table would fail with `no such column: operation_id`. The shipped contract is "9-column for the V6+ writer path and the V6 backfill progress emit; 6-column for pre-V6 legacy emit paths." Inline-document the rationale at the emit-site (see `sqlite-backend.ts:1115`).
   - Inside `migrateV5ToV6`'s per-chunk progress emit (Task 6), bind 9 columns with the three correlation columns as explicit `NULL` (migration emissions aren't dispatch-context-stamped). The schema has the columns by the time this code runs because the same outer transaction's earlier `ALTER TABLE` step added them.
   - Update `appendEvent` body (line 891+ area) to pass the three IDs from `event` into the bind — the V6+ writer path always sees a V6 schema (writer paths only execute after `migrateSchema` returns).

3. **[REFACTOR]** None needed.

**Dependencies:** Wave 2 complete
**Parallelizable:** No (Task 8 depends on this)

---

### Task 8: `AtomicAppender.appendEvents` reads correlation off stamped event

**Phase:** RED → GREEN

1. **[RED]** Write test: `AtomicAppender_BatchAppendUnderDispatchContext_PopulatesAllCorrelationColumns`
   - **File:** `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
   - **Test body:** Under a dispatch context, call `eventStore.batchAppend(stream, [{type:'a'}, {type:'b'}, {type:'c'}])`. Direct-SQL query the rows; assert all three rows share the same operationId/correlationId/causationId and match the dispatch context.
   - **Expected failure:** Task 7 handled the single-append surface; batchAppend needs its own thread-through.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/event-store/atomic-appender.ts`
   - In the SQLite-body `appendEvents` path (around line 1152 where `insertEventStrict.run(...)` fires per event), read the three IDs off the `PublicPersistedEvent` being persisted and add them to the bind arguments. The stamped event already carries them — they're at `event.correlationId`, `event.operationId`, `event.causationId`.
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts` — also update the `AtomicAppendEvent` wire shape (interface at lines 21-33) to include the three optional fields, so the type-system enforces the bind alignment.

3. **[REFACTOR]** None needed; the change is structural.

**Dependencies:** Task 7
**Parallelizable:** No (Wave 4 depends on this)

---

## Wave 4 — Filter API

Mostly parallel — Task 9 (interface extension) blocks Tasks 10 + 11, which can run side-by-side in separate worktrees. Task 12 is a parity assertion that depends on both.

### Task 9: `QueryFilters` extension

**Phase:** RED → GREEN

1. **[RED]** Write test: `QueryFilters_AcceptsCorrelationTuple_TypeAndShape`
   - **File:** `servers/exarchos-mcp/src/event-store/store.test.ts` (or `store.race.test.ts` — pick the existing QueryFilters consumer)
   - **Test body:** Construct a `QueryFilters` literal `{operationId: 'op-1', correlationId: 'c-1', causationId: 'ca-1'}`. Assert via `assertType<QueryFilters>(...)` that the shape compiles, plus a runtime sanity that `JSON.stringify` round-trips the fields (defensive against the field being structurally erased by `Record<string, unknown>` looseness).
   - **Expected failure:** Type error — fields not on the interface.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/event-store/store.ts`
   - Extend the `QueryFilters` interface (search for `export interface QueryFilters`) with `operationId?: string; correlationId?: string; causationId?: string;` after the existing fields. Doc-comment each field with a one-line description.

3. **[REFACTOR]** None needed.

**Dependencies:** Wave 3 (writer must populate columns before filters can return them)
**Parallelizable:** No (Tasks 10/11 depend on this)

---

### Task 10: `SqliteBackend.queryEvents` indexed-WHERE filter

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `SqliteBackend_QueryEvents_FiltersByCorrelationId`
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - **Test body:** Append three events under one dispatch context (correlation `cor-X`) and three more under another (`cor-Y`). Call `queryEvents(stream, {correlationId: 'cor-X'})`. Assert exactly three events returned, all carrying correlation X via the rehydrated payload (NOT via direct column read — the column is only the filter; the value comes from payload). Repeat with `operationId` and `causationId` filters in separate `it` blocks.
   - **Expected failure:** Filter ignored — all six events returned.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`
   - Find the `queryEvents` implementation that builds dynamic WHERE clauses (uses `queryStmtCache`). Extend the WHERE builder to append `AND correlation_id = ?` / `AND operation_id = ?` / `AND causation_id = ?` for each present filter field, and to bind the corresponding value.

3. **[REFACTOR]** If the WHERE builder grows past ~15 lines of conditional concat, extract `buildWhereClause(filters): {sql, binds}` helper. Optional.

**Dependencies:** Task 9
**Parallelizable:** Yes (with Task 11 — different file, different test)

---

### Task 11: `MemoryBackend.queryEvents` post-fetch filter

**Phase:** RED → GREEN

1. **[RED]** Write test: `MemoryBackend_QueryEvents_FiltersByCorrelationId`
   - **File:** `servers/exarchos-mcp/src/storage/memory-backend.test.ts`
   - **Test body:** Same shape as Task 10 but against `InMemoryBackend`. Assert the same filter semantics: exactly three events returned for each of the three correlation fields, value retrieved from payload.
   - **Expected failure:** Filter ignored.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/storage/memory-backend.ts`
   - In the `queryEvents` body, after fetching the in-memory event list and before returning, apply a `.filter(e => …)` that honors any present `operationId` / `correlationId` / `causationId` filter from the input. Read the fields off the event object directly (in-memory events carry them as top-level fields on the `WorkflowEvent`).

3. **[REFACTOR]** None needed.

**Dependencies:** Task 9
**Parallelizable:** Yes (with Task 10)

---

### Task 12: Backend contract parity test

**Phase:** RED → GREEN (no production code; pure contract assertion)

1. **[RED]** Write test: `BackendContract_QueryEventsCorrelationFilter_IdenticalAcrossBackends`
   - **File:** `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts`
   - **Test body:** Parameterize over `[InMemoryBackend, SqliteBackend]`. For each, seed the same events with the same correlation tags. Run identical `queryEvents` calls with each of the three filters; assert the returned event sequences are identical (same sequence numbers, same event types, same payloads).
   - **Expected failure:** Should already pass if Tasks 10 + 11 landed correctly; this test is the parity gate that catches drift between backends.

2. **[GREEN]** If RED, debug whichever backend diverged.

**Dependencies:** Tasks 10 + 11
**Parallelizable:** No (joins the two parallel tracks)

---

## Wave 5 — Telemetry view wiring

Two parallel groups (3 actions each) + a derived describe assertion.

### Task 13: Group A — `telemetry` + `delegation_timeline` + `code_quality` accept filter args

**Phase:** RED → GREEN

1. **[RED]** Write test: `ViewActions_GroupA_AcceptCorrelationFilters_ScopeResultsCorrectly`
   - **File:** `servers/exarchos-mcp/src/views/composite.test.ts` (extend the existing telemetry/delegation_timeline/code_quality describes)
   - **Test body:** For each of the three actions: seed events with two correlation IDs; call the action with `{correlationId: 'cor-X', workflowId: '…'}`; assert the result data reflects only the cor-X events.
   - **Expected failure:** Filter rejected as unknown field by `.strict()` Zod schemas.

2. **[GREEN]** Implement:
   - **File:** `servers/exarchos-mcp/src/registry.ts`
   - Extend the three action schemas at lines 2322-2357 with `operationId: z.string().optional(), correlationId: z.string().optional(), causationId: z.string().optional()`.
   - **File:** `servers/exarchos-mcp/src/views/composite.ts`
   - Extend the three handler call sites (around lines 170-211) to thread the three filter fields into the handler's `rest` param. Each handler signature gets the new optional fields.
   - **File:** Each handler implementation (`team-performance-view.ts`, `delegation-timeline-view.ts`, `code-quality-view.ts`)
   - Pass the filters into the underlying `EventStore.queryEvents` (or `queryDeltaEvents` via the materializer hop) call. Where the handler uses the materializer, plumb the filters through to the underlying event fetch.

3. **[REFACTOR]** None needed; the change is mechanical.

**Dependencies:** Wave 4 complete
**Parallelizable:** Yes (with Task 14 — disjoint action sets)

---

### Task 14: Group B — `quality_correlation` + `quality_attribution` + `eval_results` accept filter args

**Phase:** RED → GREEN

1. **[RED]** Write test: `ViewActions_GroupB_AcceptCorrelationFilters_ScopeResultsCorrectly`
   - **File:** `servers/exarchos-mcp/src/views/composite.test.ts`
   - **Test body:** Same shape as Task 13, parametrized over the three Group B actions.
   - **Expected failure:** Same as Task 13.

2. **[GREEN]** Same shape as Task 13 — extend the three action schemas in `registry.ts` (find via grep for `quality_correlation`, `quality_attribution`, `eval_results`), the three handlers in `views/composite.ts`, and the underlying view files. Note: `eval_results` lives in `eval-results-view.ts`, `quality_correlation` and `quality_attribution` may live in a single `quality-views.ts` or be split — confirm at implementation time.

3. **[REFACTOR]** None needed.

**Dependencies:** Wave 4 complete
**Parallelizable:** Yes (with Task 13)

---

### Task 15: `exarchos_view.describe` surfaces new filter fields

**Phase:** RED → assert GREEN

1. **[RED]** Write test: `ExarchosViewDescribe_TelemetryActions_ExposeCorrelationFilters`
   - **File:** `servers/exarchos-mcp/src/views/composite.test.ts` (or `tools.pipeline.test.ts` if that's where describe-tests live)
   - **Test body:** Call `exarchos_view describe` action listing. For each of the six telemetry actions, assert the action's input schema includes `operationId`, `correlationId`, `causationId` as optional fields.
   - **Expected outcome:** GREEN if schema introspection is automatic (it is — `describe` reads action schemas directly from registry). If GREEN, the test serves as a guard against future regressions.

2. **[GREEN-IF-RED]** If describe doesn't surface the new fields, inspect the describe handler. Most likely cause: a hand-curated allowlist of surfaced fields somewhere. Update accordingly.

**Dependencies:** Tasks 13 + 14
**Parallelizable:** No

---

## Wave 6 — #1291 acceptance integration tests

All three independent end-to-end tests. Run in parallel.

### Task 16: Correlation propagation across orchestrator → subagent wave

**Phase:** RED → GREEN

1. **[RED]** Write test: `Wave_OrchestratorDispatchesTwoSubagents_AllEventsShareCorrelationId`
   - **File:** `servers/exarchos-mcp/src/__tests__/correlation-acceptance.test.ts` (new file dedicated to #1291's acceptance trio)
   - **Test body:** Simulate an orchestrator dispatch that triggers two child dispatches (each emits 2-3 events). Use `runWithDispatchContext` to model the parent operation. After the wave, query `EventStore.queryEvents(<each stream>, {correlationId: '<parent corr>'})` and assert: 6+ events returned across streams, all carrying the parent's correlationId, but each dispatch's events carrying a distinct operationId.
   - **Expected outcome:** Should pass — Wave 4 + Wave 5 stack delivers this.

2. **[GREEN]** No new production code needed unless the test reveals a thread-through gap.

**Dependencies:** Wave 5 complete
**Parallelizable:** Yes (with Tasks 17 + 18)

---

### Task 17: `causationId` propagates through `next_actions` auto-dispatch

**Phase:** RED → GREEN

1. **[RED]** Write test: `AutoDispatch_FromNextActionsHint_CarriesCausationIdReferencingUpstreamEvent`
   - **File:** `servers/exarchos-mcp/src/__tests__/correlation-acceptance.test.ts`
   - **Test body:** Dispatch a tool that emits an event and returns a `next_actions` hint. Drive the auto-dispatch follow-up with `causationId` set to the upstream event's `eventId`. Query events on the second stream and assert: causationId matches the upstream eventId; correlationId matches the parent dispatch.
   - **Expected outcome:** Should pass.

2. **[GREEN]** No new production code unless threading gap surfaces.

**Dependencies:** Wave 5 complete
**Parallelizable:** Yes (with Tasks 16 + 18)

---

### Task 18: `operationId` uniqueness property test (100 dispatches)

**Phase:** RED → GREEN

1. **[RED]** Write test: `OperationId_AcrossManyDispatches_AllUnique_AllEventsTaggedToParent`
   - **File:** `servers/exarchos-mcp/src/__tests__/correlation-acceptance.test.ts`
   - **Test body:** Drive 100 fresh `runWithDispatchContext` calls (each minted independently, no incoming correlation). For each, emit 1-3 events and capture the dispatch's operationId. Assert: the set of 100 operationIds has cardinality 100 (no collisions); for each dispatch, every event the dispatch emitted carries that operationId.
   - **Expected outcome:** Should pass — UUID v4 collision probability is negligible.

2. **[GREEN]** No new production code unless collision surface surfaces.

**Dependencies:** Wave 5 complete
**Parallelizable:** Yes (with Tasks 16 + 17)

---

## Wave 7 — Documentation

### Task 19: CHANGELOG entry

**Phase:** No test (documentation-only)

1. **Implement:**
   - **File:** `CHANGELOG.md`
   - Add an entry under the next-RC section. One-line summary + the issue references (#1437, #1414, #1291 acceptance).

**Dependencies:** Wave 6 complete (don't write the CHANGELOG entry until the work is in place)
**Parallelizable:** No

---

## Test Naming Convention

`Method_Scenario_Outcome` (PascalCase). Examples used above:

- `Dispatch_BuiltInTool_PreservesInbound_meta`
- `MigrateV5ToV6_LegacyV5DbWithPayloadEvents_BackfillsCorrelationColumns`
- `SqliteBackend_QueryEvents_FiltersByCorrelationId`

## Parallelization Summary

| Wave | Subagent worktrees |
|---|---|
| 1 | 2 — Task 1, Task 2 (regression tests, independent) |
| 2 | 1 — sequential chain |
| 3 | 1 — sequential chain |
| 4 | 1 → 2 → 1 — Task 9 alone; then Tasks 10 + 11 parallel; then Task 12 alone |
| 5 | 2 → 1 — Tasks 13 + 14 parallel; then Task 15 |
| 6 | 3 — Tasks 16, 17, 18 all parallel |
| 7 | 1 |

Total peak parallel subagents: 3 (Wave 6).
Total serial-equivalent task count: 13 (with parallelization), 19 (without).

## Acceptance Criteria (from design)

- [ ] Three new columns + indexes present in `SCHEMA_DDL` (Task 3)
- [ ] Schema migration runs cleanly + populates from JSON for existing rows (Tasks 4-6)
- [ ] `atomic-appender.ts` writes new columns on every append (Tasks 7-8)
- [ ] Six telemetry view actions accept the three filters (Tasks 13-14; over-delivers vs. the issue's "three" minimum)
- [ ] All three integration / property tests from the #1291 acceptance list exist and pass (Tasks 16-18)
- [ ] No regression in `view telemetry.errors` performance (implicit — same code path, just an indexed predicate available; covered by existing perf tests if any)
- [ ] #1414 scope shipped as part of the same PR (Tasks 1-2 + issue close)

## Risk Notes

| Risk | Mitigation |
|---|---|
| Backfill on a large existing DB exceeds the transaction lock window | `migrateV5ToV6` uses one outer `db.transaction(...)` wrapping all DDL + every chunk UPDATE + the ledger insert (single-transaction model), so chunking caps each *iteration's* working set at 1,000 rows but does **not** shorten the lock window — locks are held for the full migration duration. Acceptable here because migration runs inside lifecycle startup before any writer is admitted (next risk row); the chunking value is observability (progress events) and bounded per-iteration memory, not lock-window reduction |
| Index creation on a busy events table contends with concurrent writers | Migration runs inside the lifecycle startup before any writer is admitted; the existing two-tier BUSY retry policy covers transient SQLITE_BUSY |
| InMemoryBackend post-fetch filter diverges from SqliteBackend indexed result | Task 12's contract parity test catches drift |
| #1414 regression test reveals an inline-fix gap | Plan explicitly carves out a `Task 1.5` slot; the verification-first framing means scope adjusts before Wave 2 starts |
| Subagent worktree gets stale w.r.t. integration branch after sibling wave merges | Per project memory `feedback_stale_worktree_after_external_push`: orchestrator force-syncs worktrees before each new wave kicks off |
