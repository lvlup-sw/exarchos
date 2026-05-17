# Correlation Tuple — Indexed Columns + Telemetry Filters

**Feature ID:** `correlation-indexed-columns`
**Issues:** [#1437](https://github.com/lvlup-sw/exarchos/issues/1437) (storage layer + telemetry filters) bundled with [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) (`_meta` preserve + `batchAppend` cache-hit `operationId`)
**Epic:** [#1441](https://github.com/lvlup-sw/exarchos/issues/1441) — v2.10.0-preview.4 polish + post-bundle follow-ups
**Milestone:** v2.10.0 — Agent Output Contract (delivers acceptance criteria #1291 promised but did not ship)
**Date:** 2026-05-16
**PR shape:** single bundled PR (Approach A — user choice)

## Problem

PR [#1428](https://github.com/lvlup-sw/exarchos/pull/1428) (preview.4 Wave B1, closes #1291) shipped the TypeScript-side three-field correlation primitive: `DispatchContext`, `AsyncLocalStorage` threading, `stampWithDispatchContext` on every `append`/`appendBatched`, and `_meta.{operationId,correlationId,causationId}` on the envelope. The TS substrate is complete.

What #1291's acceptance list promised but #1428 did not deliver:

> Three new typed columns on the events table (storage layer) — `operation_id`, `correlation_id`, `causation_id`. Indexed for telemetry-view queries. Lands as part of the same #1259 schema migration if possible; otherwise as a follow-on schema bump.
>
> Telemetry views accept optional filters for all three fields.

The current `events` table schema (`servers/exarchos-mcp/src/storage/sqlite-backend.ts:57-65`) keeps the three correlation fields inside the `payload` JSON blob. A query like "all events for `correlationId = X`" requires `json_extract(payload, '$.correlationId') = ?` over a full scan. At post-#1272 EventSourcedTaskStore volumes (thousands of events per workflow under the 250 ms poll cadence) this is a measurable cost, and it forecloses index-supported telemetry queries that the preview.4 design's acceptance list promised.

Bundled because both touch the same correlation pipeline at adjacent layers (`store.ts` appender consumers + `sqlite-backend.ts` event INSERTs + dispatch `_meta` thread): [#1414](https://github.com/lvlup-sw/exarchos/issues/1414) — two CodeRabbit findings dismissed at admin-merge on #1413: F1 (built-in tool dispatch dropping inbound `_meta` before correlation extraction) and F2 (`batchAppend` cache-hit response omitting `operationId`).

### #1414 verification — inline fix already present

A careful trace of current `main` finds **both #1414 findings already addressed inline** by #1428's post-merge hardening:

- **F1.** `dispatch.ts:604` derives `incoming` from `args._meta` *before* any normalization. Line 543 strips only the `task` augmentation key; per-action validation at `:801` operates on a separate `cleanedRest`; args is rebound only at `:867`, well after the derivation. The order #1414 asked for is in place.
- **F2.** `store.ts:467-471` includes the `operationId` passthrough on the `batchAppend` cache-hit branch with a comment citing "#1291 — three-field correlation passthrough. Mirror delegateAppend's cache-hit branch so a retry surfaces the same operationId chain."

What's missing for #1414 is **regression test coverage** locking in those behaviors. Treated as TDD task 1 in this bundle: write the two tests, run against current main. Green → close #1414 as `fixed-by-#1428-hardening + test coverage now in`. Red → the test becomes the genuine RED for whatever inline gap the trace missed.

## Scope and non-scope

| In scope | Out of scope |
|---|---|
| Schema bump V5 → V6 (three TEXT NULL columns + 2 indexes) | TaskStore FINDING-4..8 (covered by remaining #1438 follow-ups) |
| Transactional, idempotent backfill from `payload` JSON | Removing `correlation_id`/`operation_id` from the `payload` blob — the payload stays the source of truth (INV-1) |
| Writer-path update in `atomic-appender.ts` + `sqlite-backend.ts` | Memory-backend indexing — InMemoryBackend keeps post-fetch filter parity (capability-equivalent, performance-different) |
| EventStore filter API (`operationId` / `correlationId` / `causationId` query filters) with backend-aware fast path | New event types — correlation columns are an indexing layer, not a new emission surface |
| Six telemetry view actions accept the three filter args (`telemetry`, `delegation_timeline`, `code_quality`, `quality_correlation`, `quality_attribution`, `eval_results`) | `exarchos_event query` extending its filter surface — out of scope; the `event_query` tool already accepts schema-shaped filters and a separate decision deserves its own design |
| `exarchos_view.describe` projection surfaces the new filter args | SSE / push subscriptions — orthogonal axis tracked under #1440 Opportunity 5 |
| Two regression tests for #1414's F1 + F2 paths (TDD task 1) | Cross-language metadata index parity (basileus-side) — INV-3 deferred to v2.11 substrate work |
| Three integration tests from #1291's acceptance list (correlation propagation across orchestrator → subagent A/B; causation chains via auto-dispatch; operationId uniqueness property test) | Removing the JSON payload `correlationId`/`operationId`/`causationId` fields — backwards compat: payload stays canonical |

## Architecture

### Data model — events table V6

```sql
CREATE TABLE IF NOT EXISTS events (
  streamId       TEXT NOT NULL,
  sequence       INTEGER NOT NULL,
  type           TEXT NOT NULL,
  timestamp      TEXT NOT NULL,
  data           TEXT,
  payload        TEXT,
  operation_id   TEXT,            -- new (V6)
  correlation_id TEXT,            -- new (V6)
  causation_id   TEXT,            -- new (V6)
  PRIMARY KEY (streamId, sequence)
);

CREATE INDEX IF NOT EXISTS idx_events_correlation
  ON events(correlation_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_causation
  ON events(causation_id);
-- Superseded by shipped implementation (PR #1447, post-#1448 review):
-- idx_events_operation IS created. The original "stream-scoped queries
-- only" assumption didn't hold once cross-stream `operation_id`-only
-- filtering landed via `EventStore.queryByType` (#1437 + #1448 consumer
-- wiring), which would otherwise full-scan without an index. The final
-- shipped index set is three indexes:
CREATE INDEX IF NOT EXISTS idx_events_operation
  ON events(operation_id);
```

Column names use `snake_case` to match the existing schema convention (`projection_snapshots.stream_id`, `idempotency_claims.idempotencyKey` is the lone outlier preserved for back-compat). The values stored in the columns are read from the canonical JSON-payload fields `correlationId`, `operationId`, `causationId` — both writer and backfill use the same JSON keys.

### Write path

`AtomicAppender` is the sole appender; both single-event and batch paths converge in `SqliteBackend.atomicAppend(...)`. The change is local to `prepareStatements.insertEventStrict` (and the legacy `insertEvent` used by the V3→V4 migration emit path):

```ts
// before
insertEventStrict: this.db.prepare(
  'INSERT INTO events (streamId, sequence, type, timestamp, data, payload) VALUES (?, ?, ?, ?, ?, ?)',
),

// after
insertEventStrict: this.db.prepare(
  'INSERT INTO events (streamId, sequence, type, timestamp, data, payload, operation_id, correlation_id, causation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
),
```

The appender's stamped `AtomicAppendEvent` already carries the three IDs (they're in the `payload` JSON via `stampWithDispatchContext`). The change is structural — read the three IDs from the appender's stamped event and pass them as the new positional bind args. No new responsibilities for callers.

Cost: 3 extra `TEXT NULL` columns written per row. SQLite stores `NULL` columns as a single byte each, so the marginal storage cost is negligible. The two indexes add `O(log n)` write cost per INSERT, which the schema already pays for `idx_events_type` and `idx_events_time`.

### Read path — payload as truth, columns as index

This is the load-bearing invariant. `rowToEvent` (the JSON-payload-driven deserializer) stays unchanged: every consumer that reads an event's data gets it from `payload`, never from the column. The columns serve a single purpose — predicate evaluation in `WHERE` clauses.

```ts
// rowToEvent (unchanged)
function rowToEvent(row: EventRow): WorkflowEvent {
  const persisted = JSON.parse(row.payload) as PublicPersistedEvent;
  return { /* ...rehydrated from payload only */ };
}
```

No consumer should ever write `SELECT correlation_id FROM events WHERE streamId = ?` and use that value as the event's correlationId. If that data is needed, query the row and rehydrate from `payload`. The column is a denormalized projection of payload; the column → payload direction is forbidden by construction.

### Filter API — backend-aware fast path with post-fetch fallback

EventStore extends `QueryFilters` with three optional fields:

```ts
export interface QueryFilters {
  // existing
  fromSequence?: number;
  toSequence?: number;
  eventTypes?: string[];
  limit?: number;
  // new (this design)
  operationId?: string;
  correlationId?: string;
  causationId?: string;
}
```

`SqliteBackend.queryEvents` extends its dynamic-WHERE builder to honor the three filter args as indexed `WHERE column = ?` predicates. The existing prepared-statement cache (`queryStmtCache`) already handles dynamic SQL.

`MemoryBackend.queryEvents` applies the same filters post-fetch in JS — capability-equivalent, performance-different. This matches the existing two-path pattern at `store.ts:541-561` for `queryEventsByType` (backend-aware `queryEventsByType` fast path with per-stream merge fallback).

The EventStore API publishes a uniform filter contract so consumers (telemetry views, ad-hoc queries) write against the EventStore API and get index-supported filtering on SQLite while remaining correct on InMemoryBackend.

### Telemetry view wiring

Six view actions on `exarchos_view` receive the three optional filter args on their Zod input schemas:

- `telemetry`
- `delegation_timeline`
- `code_quality`
- `quality_correlation`
- `quality_attribution`
- `eval_results`

The action schemas in `registry.ts:2322-2415` extend with three optional `z.string().uuid().optional()` fields. The handlers in `views/composite.ts:170-260` pass the filter args through to `getOrCreateMaterializer` / `queryDeltaEvents` so the materializer's underlying `EventStore.queryEvents` call receives the filters. The materializer's projection fold is untouched — filters apply at fetch time, not in the fold.

`exarchos_view.describe` projects the new args automatically via the existing schema-introspection path; no manual registry edit needed.

## Migration: V5 → V6

### Schema bump

`SCHEMA_VERSION` increments from 5 to 6 in `sqlite-backend.ts:54`. A new `migrateV5ToV6` helper follows the V3→V4 / V4→V5 pattern:

1. Single transaction wraps DDL + backfill + version-stamp ledger insert (Sentry #14058246 — atomicity guard).
2. Inside the transaction:
   - `ALTER TABLE events ADD COLUMN operation_id TEXT`
   - `ALTER TABLE events ADD COLUMN correlation_id TEXT`
   - `ALTER TABLE events ADD COLUMN causation_id TEXT`
   - `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id, sequence)`
   - `CREATE INDEX IF NOT EXISTS idx_events_causation ON events(causation_id)`
   - Backfill (see below)
   - `INSERT OR IGNORE INTO schema_version (version, appliedAt) VALUES (6, ?)`

The `SCHEMA_DDL` block updates so fresh DBs land on V6 directly. Migration gate at `sqlite-backend.ts:472` adds the V5 → V6 step.

### Backfill semantics

Idempotent and deterministic: for each row where `correlation_id IS NULL`, parse `payload`, extract the three fields, write them. Re-running yields the same column values from the same payload — no drift surface.

```sql
-- conceptual; actual implementation iterates rows in TS to avoid
-- json_extract performance traps and to surface decode failures
UPDATE events
SET
  operation_id   = json_extract(payload, '$.operationId'),
  correlation_id = json_extract(payload, '$.correlationId'),
  causation_id   = json_extract(payload, '$.causationId')
WHERE correlation_id IS NULL;
```

Backfill is bounded by total event count. For the v2.10 EventStore DBs in the wild (thousand-event scale), the backfill window is sub-second. Larger DBs (the EventSourcedTaskStore can generate thousands of `task.polled` events per workflow) need a paginated approach — chunk by 1,000 rows, stamping a `migration.correlation_backfill_progress` observability event per chunk.

If a row's `payload` is unparseable or lacks the fields, the columns stay `NULL`. This is the correct fallback: NULL means "this row predates correlation threading" and matches the natural state of pre-#1428 events. No need for a "tolerate-and-warn" surface here — the data is genuinely absent, not malformed.

### Failure modes & rollback

| Failure | Detection | Recovery |
|---|---|---|
| Backfill UPDATE hits SQLITE_BUSY past retry budget | `SqliteBusyExhaustedError` propagates from the migration transaction | Operator retries the open; the V5→V6 step is idempotent (gated by ledger version 6 absent) |
| Backfill chunk crashes mid-loop | Transaction-per-chunk ensures partial chunks roll back; ledger insert deferred until last chunk commits | Operator retries the open; backfill resumes from the first NULL row |
| ALTER TABLE fails (concurrent reader holds lock) | Migration transaction surfaces SQLite error | The two-tier BUSY retry policy already handles this; operator-fatal only if WAL mode degrades |
| Schema bump deployed to a DB that hasn't received #1428's stamped events yet | All rows backfill to NULL; queries with filters return empty | Correct behavior — there were no correlation-tagged events to query. Filters become populated as new appends land. |

No rollback path: SQLite doesn't support `DROP COLUMN` cleanly pre-3.35, and the columns are additive. Rolling back means reverting to V5 in code while leaving the columns in place — they get ignored by V5 SCHEMA_DDL on next open.

### #1414 inline-fix proof — TDD task 1

The first two tasks in the implementation plan are regression tests for the two #1414 paths. Both should go green against current `main`:

```ts
// dispatch.test.ts — F1 regression
it('Dispatch_BuiltInTool_PreservesInbound_meta', async () => {
  const result = await dispatch('exarchos_workflow', {
    action: 'get',
    featureId: 'test-feature',
    _meta: { correlationId: 'corr-from-caller-7', causationId: 'event-upstream-3' },
  }, ctx);

  expect(result._meta?.correlationId).toBe('corr-from-caller-7');
  expect(result._meta?.causationId).toBe('event-upstream-3');
  // operationId is freshly minted per dispatch — caller's not preserved
  expect(result._meta?.operationId).toMatch(UUID_RE);
});
```

```ts
// store.batchAppend.test.ts — F2 regression
it('BatchAppend_CacheHit_ReturnsOperationId', async () => {
  // first append under a dispatch context: events get stamped
  const first = await runWithDispatchContext({ operationId: 'op-xyz', correlationId: 'cor-xyz' },
    () => store.batchAppend('s1', [{ type: 't.created', idempotencyKey: 'k1', data: { id: 1 } }])
  );
  expect(first[0].operationId).toBe('op-xyz');

  // second append with same key: cache hit branch — must preserve operationId
  const replay = await store.batchAppend('s1', [
    { type: 't.created', idempotencyKey: 'k1', data: { id: 1 } },
  ]);
  expect(replay[0].operationId).toBe('op-xyz');
});
```

Decision tree on day 1:

- **Both green** → close #1414 with link to test commits; continue with the V5→V6 work.
- **Either red** → that test becomes the genuine RED for an inline gap I missed in the code-trace. Adjust scope: write the production fix as task 1.5 before continuing.

## Design-invariants analysis

Walks the project-specific Exarchos invariants. Format: `[invariant] — verdict — rationale`.

### INV-1 Event-Sourcing Integrity — PASS

The events table's `payload` column remains the sole source of truth for event data. The new columns are a denormalized index over payload, written atomically in the same INSERT (no temporal window where they diverge), and read only as predicate filters (never as value sources). This matches the existing relationship between `payload.type` and `idx_events_type`.

Risk surface to watch in review: if a future consumer reads `SELECT correlation_id FROM events WHERE …` and uses that value AS the correlationId (rather than as a row filter), the column would become a parallel source of truth and INV-1 would be at risk. The design treats this as "forbidden by construction" — no such consumer is introduced here. A `scripts/lint-correlation-column-read.mjs` advisory could be added later if drift becomes a concern; not in scope for this PR.

Snapshot of the existing acceptance question checklist (from `references/INV-1-event-sourcing.md`):

1. *Does the surface read from the event store?* — Yes: telemetry views call `EventStore.queryEvents` with the new filters; the data is rehydrated from payload via the unchanged `rowToEvent`.
2. *Does the surface write to the event store?* — Yes: `atomic-appender.ts` `INSERT`s the three columns alongside payload, atomically.
3. *Does the surface stream from the event store?* — No new subscription surfaces.
4. *Can the output be reconstructed from events alone?* — Yes: the columns are a pure projection of payload; replaying the event stream into a fresh DB and re-running backfill yields identical columns.

The backfill itself is a one-time migration write to the events table. It does NOT mutate any event payload — only writes the new columns from already-present JSON values. This is structurally an "expand the row representation" operation, not an event mutation, and falls outside the "events are immutable facts" rule the way schema migrations always do.

### INV-2 Facade Equivalence — PASS

CLI and MCP both consume the same EventStore API. Filter results are computed at the EventStore layer (not in the adapter), so the byte-identical CLI/MCP envelope-parity invariant holds. The six telemetry view actions get the new filter args identically on both facades.

### INV-3 Basileus-Forward — N/A (PASS)

The scope is local-storage-only. Remote MCP servers (basileus) operate on their own event stores; the schema bump is per-store, not cross-tier. INV-3 will re-engage when basileus adopts a compatible schema-evolution policy; deferred under the existing v3.0+ remote-MCP roadmap.

### INV-4 Platform-Agnosticity — PASS with caveat

`SqliteBackend` and `InMemoryBackend` are the two production backend implementations. Both honor the new filter contract — SqliteBackend via indexed WHERE, InMemoryBackend via post-fetch JS filter. Capability is equivalent across backends; performance differs by design.

Caveat: third-party storage backends (none in tree today, but the abstraction exists) would need to implement the filter semantics. The `StorageBackend` interface's TypeScript type already requires `QueryFilters` to be respected; new fields are optional, so type-wise they're additive. A backend that ignores the new filters would silently return un-filtered results — that's the standard cost of an extension to a permissive interface.

### INV-5 Agent-First Interface Design

- **INV-5a Input Ergonomics** — PASS. Three optional fields named identically to the envelope `_meta` keys. Agents already see these IDs in result envelopes; using the same names in input filters keeps the round-trip mental model coherent.
- **INV-5b Output Contract** — PASS. The telemetry view's result shape doesn't change; filtering reduces the row count but the per-row schema is identical. `next_actions` semantics unchanged.
- **INV-5c Aspire-Inspired Verbs** — N/A. No new verb; existing query-shaped actions get optional filter args.
- **INV-5d Action Discriminator** — N/A. No new action.

### INV-6 Workflow-Agnosticism — N/A

Storage / EventStore filter contract is workflow-neutral by construction.

## Axiom backend-quality analysis

Dimension walk (DIM-1 .. DIM-8). Format: `[dimension] — verdict — rationale`.

### DIM-1 Topology — PASS

Lifecycle ownership clear: `SqliteBackend` owns column persistence; `EventStore` owns the filter API contract; backends implement it. No new module-globals, no lazy fallbacks. The new index lives in the events table — single source — and consumers must access it through the `EventStore.queryEvents` interface, never bypassing into raw SQL. Dependency graph stays directed: backends → EventStore → views → composite handlers.

### DIM-2 Observability — PASS with one note

Backfill emits a `migration.correlation_backfill_progress` observability event per chunk so operators can see migration progress on large DBs. Existing schema migrations follow the same pattern (e.g. V3→V4 emits `migration.workflow_type_unknown`).

Note: post-fetch filter on MemoryBackend is silent — no log when a filter applies. For test workloads this is fine, but if MemoryBackend ever appears on a hot production path the filter should log at debug level. Not introduced here; consider as a follow-up if MemoryBackend posture changes.

### DIM-3 Contracts — PASS

Schema additions are additive (`TEXT NULL` columns), no breaking change. The `QueryFilters` interface gets three optional fields; consumers that don't supply them see unchanged behavior. Zod schemas on the six view actions add `.optional()` fields — same.

Type-assertion surface: the row read at backfill time uses `as { payload: string }` — already-standard pattern in `sqlite-backend.ts`. No new unguarded assertions.

### DIM-4 Test Fidelity — PASS

Production wiring uses `SqliteBackend` in deployed contexts and `InMemoryBackend` in tests; the design's two-path filter implementation means tests exercise both code paths naturally. The three integration tests promised by #1291's acceptance list (correlation propagation, causation chains, operationId uniqueness) run against `EventStore` API, not mock surfaces — they fail if the SQLite path or the Memory path returns divergent results.

Skip discipline: no `.skip` introduced.

### DIM-5 Hygiene — PASS

No new exports beyond the three filter fields on `QueryFilters`. The action schema field additions are localized to `registry.ts`. No feature flags. No dead code.

### DIM-6 Architecture — PASS

Dependency direction unchanged: backends provide storage primitives, EventStore composes them into a filter contract, views consume that contract. No circular dependency surface. Each module retains its existing single responsibility.

Change surface for this design: 8-10 files (sqlite-backend.ts, atomic-appender.ts adapter, store.ts QueryFilters + queryEvents merge logic, memory-backend.ts post-fetch filter, registry.ts six action schemas, composite.ts six handler wirings, plus the regression-test files). Under the DIM-6 shotgun-surgery threshold.

### DIM-7 Resilience — PASS

The two new indexes are bounded by the existing events-table size; no unbounded growth surface. The backfill chunks at 1,000 rows so memory usage stays bounded regardless of total event count.

Backfill on a fresh DB is a no-op (`UPDATE … WHERE correlation_id IS NULL` against zero rows). Backfill on a DB stamped at V5 but with no correlation-tagged events writes `NULL` columns to all rows — also bounded.

### DIM-8 Prose Quality — N/A

This is a design doc. The shipped code changes are mechanical (SQL + JS) and add no narrative prose.

## Implementation plan outline

Detailed task breakdown belongs to `/exarchos:plan`. Outline for sequencing:

1. **#1414 regression coverage (RED → assert GREEN)**
   1.1 Write `Dispatch_BuiltInTool_PreservesInbound_meta` regression test.
   1.2 Write `BatchAppend_CacheHit_ReturnsOperationId` regression test.
   1.3 Run both. If green, close #1414 with link to the test commits. If red, write the inline fix.

2. **Schema V5 → V6**
   2.1 Bump `SCHEMA_VERSION` to 6 and extend `SCHEMA_DDL` with the three columns + two indexes.
   2.2 Add `migrateV5ToV6` helper following the V3→V4 transactional + idempotent pattern.
   2.3 Wire `migrateSchema` to call it.
   2.4 Schema-migration test (new entry in `__tests__/schema-migration.test.ts`): legacy V5 DB upgrades to V6 with columns populated from payload.

3. **Writer path**
   3.1 Update `prepareStatements.insertEvent` and `insertEventStrict` to bind nine positional args (six existing + three new).
   3.2 Update `appendEvent` and the `atomic-appender.ts` SQLite body to read the three IDs off the stamped event and pass them in.
   3.3 Update the V3→V4 migration emit path (`emitWorkflowTypeUnknownEvents`) for parity — migration events get NULL correlation columns explicitly.

4. **Backfill**
   4.1 Implement chunked backfill (1,000 rows per chunk) inside `migrateV5ToV6` transaction.
   4.2 Emit `migration.correlation_backfill_progress` per chunk with `{rowsBackfilled, totalRowsRemaining}` payload.
   4.3 Register the new event type in `event-store/schemas.ts` per INV-1.

5. **Filter API**
   5.1 Extend `QueryFilters` interface in `event-store/store.ts` with three optional fields.
   5.2 Extend `SqliteBackend.queryEvents` dynamic-WHERE builder.
   5.3 Extend `MemoryBackend.queryEvents` with post-fetch filter.
   5.4 Backend contract test extension (`__tests__/backend-contract.test.ts`) covers both implementations.

6. **Telemetry view filters**
   6.1 Add the three optional fields to six action schemas in `registry.ts`.
   6.2 Thread filter args through the six handlers in `views/composite.ts`.
   6.3 Update `telemetry-queries.ts` and `telemetry-projection.ts` to honor the filters on the underlying `queryDeltaEvents` call.
   6.4 Verify `exarchos_view.describe` surfaces the new fields (existing schema-introspection path should handle this without code change; test asserts).

7. **#1291 acceptance integration tests**
   7.1 Dispatch a wave (orchestrator → subagent A, subagent B); assert all six events share `correlationId`, distinct `operationId`s. Filter via `EventStore.queryEvents({correlationId})` to retrieve the wave.
   7.2 Auto-dispatch via `next_actions` carries `causationId` referencing the upstream event. Filter via `{causationId}` to walk the chain.
   7.3 Property test: across 100 random dispatches, all `operationId`s unique; all events tagged with their parent's operationId.

8. **Documentation**
   8.1 Update `docs/architecture/invariants.md` INV-1 entry (if appropriate, after the audit in #1439) to reference the columns-as-projection pattern as an explicit example.
   8.2 CHANGELOG entry under v2.10.0-RC1 / next-preview.

## Acceptance criteria (from #1437)

- [ ] Three new columns + indexes present in `SCHEMA_DDL`
- [ ] Schema migration runs cleanly + populates from JSON for existing rows
- [ ] `atomic-appender.ts` writes new columns on every append
- [ ] Three named telemetry view actions accept the three filters (this design extends to six — over-delivers)
- [ ] All three integration / property tests from the #1291 acceptance list exist and pass
- [ ] No regression in `view telemetry.errors` performance
- [ ] **#1414** scope shipped as part of the same PR (regression tests + close issue)

## Open questions

None at design time. The verification-first framing folds the only meaningful uncertainty (#1414's actual inline-fix status) into task 1 of the implementation plan, where it resolves empirically.

## References

- Issue #1437 — storage layer + telemetry filters acceptance
- Issue #1414 — `_meta` preserve + batchAppend cache-hit operationId
- Issue #1441 — parent epic (preview.4 polish)
- PR #1428 — landed the three-field correlation primitive (TS-side only)
- Bundle audit: `docs/research/2026-05-16-v2-10-0-preview-4-bundle-audit.md` Wave B §"#1291"
- Marten lessons: `docs/research/2026-05-08-marten-event-store-lessons.md` §R-3 — metadata-as-queryable-columns pattern
- Azure ES pattern: https://learn.microsoft.com/azure/architecture/patterns/event-sourcing
- Invariants catalog: `docs/architecture/invariants.md` (entries INV-1, INV-2, INV-4)
- Schema migration runner: `servers/exarchos-mcp/src/storage/sqlite-backend.ts:54-810`
- Filter surface: `servers/exarchos-mcp/src/event-store/store.ts` (`QueryFilters`, `queryEvents`, `queryEventsByType` two-path pattern)
- Telemetry handlers: `servers/exarchos-mcp/src/views/composite.ts:170-260`; `servers/exarchos-mcp/src/registry.ts:2322-2415`
