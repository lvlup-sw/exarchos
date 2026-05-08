# Implementation Plan: Durable Event-Store Substrate, Capability Posture, HSM Single-Path, Phase Contract

## Source Design

Link: [`docs/designs/2026-05-08-durable-event-store-substrate.md`](../designs/2026-05-08-durable-event-store-substrate.md)

## Scope

**Target:** Full design (Approach B — storage hard-cut, contracts gradually).
**Excluded:**
- Basileus-remote shared store (#1081) — explicit defer per spike Q3; cross-stream query primitive remains transport-agnostic.
- `exarchos watch` sideband daemon — explicit defer per spike out-of-scope.
- Multi-author concurrent-checkpoint semantics — explicit defer per spike out-of-scope.
- v2.11 shim removal — tracked under DR-14 follow-up issue, not in this plan's scope.

## Summary

- Total tasks: 61 (T01–T61; T12, T13 added in revision; T57–T61 added in revision)
- Parallel groups: 7 (P1–P7 below)
- Estimated test count: ~92 (one task = one focused behavior; some property/integration tasks generate >1 test)
- Design coverage: 14 of 14 DR requirements covered
- Revision history:
  - 2026-05-08 r1: gate.executed plan-review found 8 gaps. Added T12 (tolerant deserialization), T13 (StorageBackend wiring witness), T57 (lifecycle wires migration runner), T58 (lifecycle wires topology loader), T59 (handshake override priority), T60 (cross-process migration-lock convergence), T61 (AtomicAppender consumer enumeration). Phase 0 worktree row added to parallelization table.

## Spec Traceability

| Design DR | Requirement Summary | Acceptance Test (parent) | Inner Task IDs |
|---|---|---|---|
| DR-1 | SQLite source-of-truth + AtomicAppender body swap | T05 | T06–T11, T61 |
| DR-2 | Storage handle DI through `DispatchContext` | T14 | T13, T15–T17 |
| DR-3 | Stream ID namespacing + cross-stream query reducer | T23 | T24–T28 |
| DR-4 | `workflow.set({phase})` deprecation rerouting | T35 | T36–T41 |
| DR-5 | `workflow.transition` guard-failure error envelope | T42 | T42 |
| DR-6 | AgentPosture spec field + resolver derivation | T29 | T30–T34, T59 |
| DR-7 | Typed phase-contract loader + generic pruner scorer | T43 | T44–T48, T58 |
| DR-8 | JSONL→SQLite migration + archive + lock | T18 | T19–T22, T57 |
| DR-9 | Migration emits structured events | T20 | T20–T22 |
| DR-10 | Schema V3 + tolerant deserialization | T01 | T02–T04, T12 |
| DR-11 | `outputSchema` bumped + `describe` entries updated | T39 | T40–T41 |
| DR-12 | Substrate failure-mode coverage (busy/corrupt/lock) | T08 | T08–T11, T22, T60 |
| DR-13 | POC validates seam (parametric backend tests) | T49 | T50–T55, T61 |
| DR-14 | v2.11 cleanup follow-up issue | T56 | T56 |

## Task Breakdown

## Phase 0 — Foundation (sequential; blocks all later phases)

### Task 01: Schema V3 migration scaffolding

**Goal:** Implements design section *Schema versioning (DIM-3, INV-1)*. Adds the schema-version 3 migration scaffolding required before any new event types or storage-shape changes can be appended to the events table.

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-10
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Write test `SchemaMigration_V2ToV3_AppliesIdempotently`
   - File: `servers/exarchos-mcp/src/storage/__tests__/schema-migration.test.ts` (existing file; add case)
   - Expected failure: V3 migration step does not exist in `event-migration.ts`
2. [GREEN] Add `2 → 3` migration step in `servers/exarchos-mcp/src/event-store/event-migration.ts`; bump `SCHEMA_VERSION = 3` in `storage/sqlite-backend.ts`; ensure migration is idempotent (running twice on V3 is a no-op).
3. [REFACTOR] Extract V2→V3 migration into a named helper.

**Verification:** Witnessed RED for "no V3 migration"; passes after migration registered.
**Dependencies:** None
**Parallelizable:** No (foundation)

---

### Task 02: Register `hsm.deprecated_action_invoked` event type

**Goal:** Implements design section *Schema versioning (DIM-3, INV-1)*. Registers the `hsm.deprecated_action_invoked` event-type schema so subsequent deprecation-emitter tasks can append validated payloads.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-4, DR-10
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Write test `EventSchemas_HsmDeprecatedActionInvoked_ValidatesAndRoundtrips`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: type unknown to validator
2. [GREEN] Register schema in `servers/exarchos-mcp/src/event-store/schemas.ts` with `data: { action: string, invokedBy: string }`.
3. [REFACTOR] Co-locate with sibling deprecation events.

**Dependencies:** T01
**Parallelizable:** No (foundation)

---

### Task 03: Register `spec.legacy_capabilities_array`, `phase.contract_missing` event types

**Goal:** Implements design section *Schema versioning (DIM-3, INV-1)*. Registers the `spec.legacy_capabilities_array` and `phase.contract_missing` event-type schemas so capability-posture and phase-contract paths can emit validated events.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-6, DR-7, DR-10
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Two tests, one per event type, asserting validator acceptance.
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
2. [GREEN] Register both schemas in `schemas.ts`.

**Dependencies:** T01
**Parallelizable:** With T02

---

### Task 04: Register `migration.legacy_jsonl_imported`, `migration.completed`, `migration.failed` event types

**Goal:** Implements design section *Schema versioning (DIM-3, INV-1)*. Registers the three migration event-type schemas (`migration.legacy_jsonl_imported`, `migration.completed`, `migration.failed`) used by the JSONL→SQLite import pipeline.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-9, DR-10
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Three tests, one per event type, asserting validator acceptance.
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
2. [GREEN] Register all three schemas.

**Dependencies:** T01
**Parallelizable:** With T02, T03

---

### Task 12: Tolerant V2→V3 deserialization

**Goal:** Implements design section *Schema versioning (DIM-3, INV-1)*. Closes DR-10 AC2 — the V3 reader must observe V2-shape events unchanged. Without this, a partial migration or rollback path corrupts the event log.

**Phase:** RED → GREEN
**Test Layer:** integration
**Implements:** DR-10
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Write test `EventReader_V3_DeserializesV2ShapedEventsUnchanged`
   - File: `servers/exarchos-mcp/src/event-store/event-migration.test.ts` (existing file; add case)
   - Plant a fixture row written under V2 schema; assert V3 reader returns the same `PublicPersistedEvent` shape that V2 produced (semantic equivalence; only V3-only fields default).
   - Plant a V3 row alongside; assert both reads round-trip without coercion errors.
2. [GREEN] Implement tolerant decode in the V3 reader path; unknown V3-only fields default; unknown V2 fields are ignored.

**Verification:** Witness RED while reader assumes V3 fields are required; flips GREEN once tolerant decode is in place.
**Dependencies:** T01
**Parallelizable:** With T02, T03, T04

---

### Task 13: StorageBackend / MemoryBackend DI witness

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Closes DR-2 AC3 — verifies the existing `StorageBackend` interface and `MemoryBackend` implementation under `servers/exarchos-mcp/src/storage/` are reachable through the `DispatchContext` shape that Phase 2 will introduce. No new abstraction; this is a wiring witness.

**Phase:** RED → GREEN
**Test Layer:** unit
**Implements:** DR-2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Write test `StorageBackend_Interface_AdmitsBothSqliteAndMemoryImpls`
   - File: `servers/exarchos-mcp/src/storage/__tests__/backend-contract.test.ts` (existing file; add case)
   - Assert the `StorageBackend` type accepts both `SqliteBackend` and `MemoryBackend` instances; assert each implementation passes the existing backend contract suite.
2. [GREEN] If the contract test already covers both implementations, this becomes a documentation-only addition referencing the existing coverage. Otherwise extend the contract test to enumerate both backends.

**Verification:** Confirms the abstraction Phase 2 depends on is already in place; prevents Phase 2 from re-introducing a parallel abstraction.
**Dependencies:** T01
**Parallelizable:** With T02, T03, T04, T12

---

## Phase 1 — Storage Substrate (group P1, parallel after Phase 0)

### Task 05: ACCEPTANCE — `AtomicAppender` SQLite-backed body produces same `AppendResult` shape

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Acceptance test ensuring the SQLite-backed AtomicAppender body produces the same AppendResult shape, sequencing, and idempotency-key semantics as the JSONL backend across all seven existing call sites.

**Phase:** RED (kept RED until T06–T11 complete)
**Test Layer:** acceptance
**Implements:** DR-1
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "acceptance", properties: ["all seven existing call sites continue to work without code changes"] }`

**TDD Steps:**
1. [RED] Write acceptance test `AtomicAppender_SqliteBackend_DropsInBehindExistingInterface`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender.acceptance.test.ts`
   - Expected failure: SQLite backend not implemented
   - Test asserts: same `AppendResult` shape, same per-stream serialization, same idempotency-key cache-hit semantics, same returned `PublicPersistedEvent` shape, against the SAME fixtures as `atomic-appender.test.ts`.

**Dependencies:** T01–T04, T12, T13
**Parallelizable:** Anchor of P1

---

### Task 06: SQLite append wraps `BEGIN IMMEDIATE` transaction

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Wraps the SQLite append in a single BEGIN IMMEDIATE transaction covering idempotency claim, sequence allocation, event INSERT, and outbox INSERT for the storage primitive.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T05
**Implements:** DR-1, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `SqliteAtomicAppender_ConcurrentAppendsToSameStream_NoOverlapInSequenceAllocation`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender-sqlite.test.ts`
2. [GREEN] Implement SQLite-backed body in a sibling module; `AtomicAppender` constructor accepts `backend: 'jsonl' | 'sqlite'` arg defaulting to `'sqlite'`. Body opens `BEGIN IMMEDIATE`, INSERTs idempotency claim, INSERTs sequence row, INSERTs event row, COMMITs.
3. [REFACTOR] Extract transaction body into a private prepared-statement set.

**Dependencies:** T05
**Parallelizable:** P1

---

### Task 07: SQLite append commits idempotency-key only on successful COMMIT

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Ensures the SQLite append commits idempotency-key claims only after a successful COMMIT, preserving retry-admissibility on transaction rollback.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T05
**Implements:** DR-1, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `SqliteAtomicAppender_TransactionRollback_IdempotencyKeyNotCommitted`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender-sqlite.test.ts`
   - Inject a fault that aborts the transaction mid-flight; assert key claim is uncommitted (next attempt with same key is admissible).
2. [GREEN] Already covered if T06 implements transactional semantics; if test fails, fix to commit-on-success only.

**Dependencies:** T06
**Parallelizable:** P1

---

### Task 08: ACCEPTANCE — substrate failure modes have explicit handling

**Goal:** Implements design section *Failure-mode coverage (DIM-7, error-handling DR per skill rule)*. Acceptance test asserting all substrate failure modes (busy retry, corrupt startup, lock-claim) have explicit observable handling.

**Phase:** RED (kept RED until T09–T11 complete)
**Test Layer:** acceptance
**Implements:** DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Write acceptance test `Substrate_FailureModeCoverage_AllPathsExplicitAndObservable` covering busy retry, corrupt startup error, lock claim semantics.
   - File: `servers/exarchos-mcp/src/event-store/substrate-resilience.acceptance.test.ts`

**Dependencies:** T05
**Parallelizable:** P1

---

### Task 09: SQLite_BUSY triggers bounded retry

**Goal:** Implements design section *Failure-mode coverage (DIM-7, error-handling DR per skill rule)*. Adds bounded retry with exponential backoff for SQLITE_BUSY errors during append, returning a structured storage_busy reason on exhaustion.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T08
**Implements:** DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `SqliteAtomicAppender_SqliteBusy_RetriesUpToFiveTimesWithBackoff`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender-sqlite.test.ts`
   - Mock SQLite to throw `SQLITE_BUSY` for first 4 attempts, succeed on 5th.
2. [GREEN] Wrap append in retry loop: ≤5 attempts, exponential backoff capped at 100ms; on exhaustion return `AppendResult` failure with `Reason: 'storage_busy'`.
3. [REFACTOR] Extract retry policy to a named constant.

**Dependencies:** T08
**Parallelizable:** P1

---

### Task 10: SQLite_CORRUPT at startup raises non-recoverable structured error

**Goal:** Implements design section *Failure-mode coverage (DIM-7, error-handling DR per skill rule)*. Implements non-recoverable structured-error handling for SQLITE_CORRUPT detected at startup, refusing lifecycle start with operator remediation guidance.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T08
**Implements:** DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `SqliteBackend_StartupCorruptDb_StructuredErrorNoAutoRebuild`
   - File: `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
   - Plant a malformed `.db` file; lifecycle start must fail with a structured error referencing operator remediation steps.
2. [GREEN] Replace any auto-rebuild path in `lifecycle.ts` with a structured throw.

**Dependencies:** T08
**Parallelizable:** P1

---

### Task 11: Per-stream Promise mutex retained as second-tier guard

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Retains the per-stream Promise-mutex from v2.9 as the second-tier guard for the SQLite-backed storage primitive under concurrent appends.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T05
**Implements:** DR-1, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "integration", properties: ["linearizability: concurrent appends to one stream produce monotonically-increasing sequences"], characterizationRequired: true }`

**TDD Steps:**
1. [RED] Property test `SqliteAtomicAppender_50ConcurrentAppendsOneStream_NoDuplicateSequences`
   - File: `servers/exarchos-mcp/src/event-store/store.race.test.ts` (existing file; add case)
2. [GREEN] Confirm Promise-mutex from v2.9 still wraps the SQLite path; if the SQLite body inadvertently bypassed it, restore.

**Dependencies:** T06
**Parallelizable:** P1

---

## Phase 2 — DispatchContext Storage Handle (group P2, sequential after P1)

### Task 14: ACCEPTANCE — storage handle injected through `DispatchContext`

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Acceptance test asserting the storage handle is injected through DispatchContext and no production code outside `storage/` imports `bun:sqlite` directly.

**Phase:** RED (kept RED until T15–T17 complete)
**Test Layer:** acceptance
**Implements:** DR-2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Write acceptance test `DispatchContext_StorageHandle_InjectedNotAmbient` asserting:
   - `DispatchContext` shape includes `storage: StorageBackend`.
   - Production code under `servers/exarchos-mcp/src/` (excluding `storage/` and `__tests__/`) imports zero `Database` from `bun:sqlite`.
   - Test-doubles use `MemoryBackend`.
   - File: `servers/exarchos-mcp/src/core/dispatch-context.acceptance.test.ts`

**Dependencies:** T11 (P1 must be complete; storage backend usable)
**Parallelizable:** Anchor of P2

---

### Task 15: Add `storage` field to `DispatchContext` type

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Adds the typed `storage` field to the DispatchContext shape so the storage primitive is dependency-injected rather than ambient.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T14
**Implements:** DR-2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Test `DispatchContext_TypeShape_IncludesStorageField`
   - File: `servers/exarchos-mcp/src/core/dispatch.test.ts`
2. [GREEN] Add `storage: StorageBackend` to `DispatchContext` in `core/dispatch.ts`.

**Dependencies:** T14
**Parallelizable:** P2

---

### Task 16: Construct storage handle in `lifecycle.ts`; thread through dispatch core

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Constructs the SQLite storage handle once at lifecycle start and threads it through the dispatch core context for the storage primitive.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T14
**Implements:** DR-2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `Lifecycle_Start_ConstructsStorageAndPassesViaContext`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.test.ts`
2. [GREEN] In `lifecycle.ts`, open SQLite connection once at start; build `DispatchContext` carrying the handle; thread to `core/dispatch.ts`.
3. [REFACTOR] Centralize connection options (timeout, WAL mode) in a constants module.

**Dependencies:** T15
**Parallelizable:** P2

---

### Task 17: Remove ambient `bun:sqlite` imports outside `storage/`

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Removes ambient `bun:sqlite` imports from production code outside the `storage/` directory in support of the storage-primitive DI requirement.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T14
**Implements:** DR-2
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `NoLegacyRuntimeDeps_ProductionCode_NoBunSqliteImportsOutsideStorage`
   - File: `servers/exarchos-mcp/src/storage/__tests__/no-legacy-runtime-deps.test.ts` (existing; add case)
   - Greps the production tree (excluding `storage/`, `__shims__/`, `__tests__/`) for `from 'bun:sqlite'`.
2. [GREEN] Replace any non-`storage/` imports with `ctx.storage.*` access.

**Dependencies:** T16
**Parallelizable:** P2

---

## Phase 3 — Migration (group P3, sequential after P2)

### Task 18: ACCEPTANCE — JSONL→SQLite migration imports legacy events and archives source files

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Acceptance test for the JSONL→SQLite migration plan: legacy events imported in append order and source files archived to `.archive-v210/` under a SQLite-backed lock.

**Phase:** RED (kept RED until T19–T22 complete)
**Test Layer:** acceptance
**Implements:** DR-8, DR-9
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `Migration_LegacyJsonlPresent_ImportsAndArchivesUnderArchiveV210`
   - File: `servers/exarchos-mcp/src/storage/migration.acceptance.test.ts`
   - Fixture: 3 legacy `*.events.jsonl` files in a temp dir; one of them has a malformed line.
   - Asserts: events imported in append order; source files moved (not deleted) to `.archive-v210/`; `migration.legacy_jsonl_imported` event per file; `migration.completed` event with totals.

**Dependencies:** T17
**Parallelizable:** Anchor of P3

---

### Task 19: SQLite-backed migration lock primitive

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Implements the SQLite-backed migration-lock primitive enforcing single-runner semantics for the JSONL→SQLite migration plan across concurrent CLI/MCP starts.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T18
**Implements:** DR-8, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `MigrationLock_TwoConcurrentClaimers_OneRunsOneAwaits`
   - File: `servers/exarchos-mcp/src/storage/migration-lock.test.ts`
2. [GREEN] Add `migration_lock` table; `INSERT ... ON CONFLICT DO NOTHING` semantics; loser polls until `migration.completed` event observed.
3. [REFACTOR] Extract lock-claim helper.

**Dependencies:** T18
**Parallelizable:** P3

---

### Task 20: JSONL importer reads in append order, routes through `AtomicAppender`

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Implements the JSONL importer for the migration plan, reading legacy event files in append order and routing through the canonical AtomicAppender path.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T18
**Implements:** DR-8, DR-9
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `JsonlImporter_LegacyFile_AppendsViaAtomicAppenderInOriginalOrder`
   - File: `servers/exarchos-mcp/src/storage/jsonl-importer.test.ts`
2. [GREEN] Implement importer: read line-by-line, parse, call `AtomicAppender.append`, emit `migration.legacy_jsonl_imported` per file.

**Dependencies:** T19
**Parallelizable:** P3

---

### Task 21: Archive source JSONL to `.archive-v210/` after successful import

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Archives source JSONL files to `.archive-v210/` after successful import, preserving forensic shape for one release per the migration plan.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T18
**Implements:** DR-8
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `JsonlImporter_AfterSuccess_MovesSourceToArchiveV210Folder`
   - File: `servers/exarchos-mcp/src/storage/jsonl-importer.test.ts`
2. [GREEN] After successful import, `fs.rename` source to `.archive-v210/<basename>`; create directory if absent.

**Dependencies:** T20
**Parallelizable:** P3

---

### Task 22: Migration failure leaves lock claimed; emits `migration.failed`

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Handles migration-failure path: emits `migration.failed`, leaves the lock claimed for operator inspection, propagates a non-recoverable startup error.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T18, T08
**Implements:** DR-9, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Migration_FailureMidImport_EmitsMigrationFailedAndKeepsLock`
   - File: `servers/exarchos-mcp/src/storage/migration.test.ts`
   - Fault-inject corruption of one JSONL file mid-batch.
2. [GREEN] Try/catch in importer; emit `migration.failed` with `data: { reason, partialTotals }`; do not clear lock; lifecycle propagates a non-recoverable startup error.

**Dependencies:** T21
**Parallelizable:** P3

---

### Task 60: Cross-process migration-lock convergence (CLI ↔ MCP)

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Closes DR-12 cross-process gap — design specifies *concurrent CLI + MCP-server starts converge on a single migration runner; the loser awaits completion*. T19 covers in-process two-claimer convergence; this task asserts the same property across OS-process boundaries.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T18
**Implements:** DR-8, DR-12
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `MigrationLock_CliAndMcpStartConcurrently_OneRunsOneAwaits`
   - File: `servers/exarchos-mcp/src/storage/migration-lock-cross-process.test.ts`
   - Fixture: spawn two child processes (one simulating CLI startup, one MCP-server startup) racing for the same `migration_lock` row. Assert exactly one runs the import; the other observes `migration.completed` and proceeds without re-running.
2. [GREEN] Confirm the SQLite-backed lock primitive (T19) survives the cross-process boundary; if file-locking semantics differ, address via WAL mode + busy_timeout.

**Dependencies:** T22
**Parallelizable:** P3 (final)

---

## Phase 4 — Cross-Stream Namespacing (group P4, parallel after P1)

### Task 23: ACCEPTANCE — namespaced stream IDs + cross-stream queries reduce over events table

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Acceptance test for cross-stream propagation: two concurrent subagents append; parent-stream `team.disbanded` reflects both `task.completed` events via a query reducing over events.

**Phase:** RED (kept RED until T24–T28 complete)
**Test Layer:** acceptance
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `CrossStream_TwoSubagentsAppend_ParentTeamDisbandedReflectsBothCompletions`
   - File: `servers/exarchos-mcp/src/event-store/cross-stream.acceptance.test.ts`
   - Two-worktree fixture; concurrent appends; `team.disbanded` emission queries reduces over events; result reflects both `task.completed` events.

**Dependencies:** T11
**Parallelizable:** Anchor of P4

---

### Task 24: Stream-id validator accepts `<feature-id>/<subagent-id>` form

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Updates the stream-id validator to accept the namespaced `<feature-id>/<subagent-id>` form required by cross-stream propagation.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T23
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "unit", properties: ["validator accepts well-formed namespaced IDs and rejects all malformed inputs"] }`

**TDD Steps:**
1. [RED] Tests for accepted/rejected forms.
   - File: `servers/exarchos-mcp/src/shared/validation.test.ts`
2. [GREEN] Update `validateStreamId` to accept `^[a-z0-9-]+(/[a-z0-9-]+)?$`; reject `..`, slashes-at-end, double slashes.

**Dependencies:** T23
**Parallelizable:** P4

---

### Task 25: `eventStore.queryByType` accepts `streamPrefix` filter

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Adds the `streamPrefix` filter to `eventStore.queryByType` enabling cross-stream propagation queries that reduce over the events table.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T23
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `EventStore_QueryByTypeWithStreamPrefix_ReturnsAllMatchingDescendantStreams`
   - File: `servers/exarchos-mcp/src/event-store/store.test.ts`
2. [GREEN] Add `streamPrefix?: string` to `QueryFilters`; SQL: `WHERE streamId LIKE ? || '/%' OR streamId = ?`.

**Dependencies:** T24
**Parallelizable:** P4

---

### Task 26: `team.disbanded` emission queries events table (not derived state)

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Replaces derived-state reads with an event-store query at `team.disbanded` emission time, enforcing INV-1 stores-as-projections for cross-stream propagation.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T23
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `TeamCoordinator_DisbandedEmission_QueriesEventsNotDerivedState`
   - File: `servers/exarchos-mcp/src/team/coordinator.test.ts`
2. [GREEN] Replace `state.tasksCompleted` reads with `eventStore.queryByType('task.completed', { streamPrefix: featureId })`.
3. [REFACTOR] Inline the count derivation if call site is small.

**Dependencies:** T25
**Parallelizable:** P4

---

### Task 27: Remove `SubagentStreamRouter` primitive (or document as thin wrapper)

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Removes (or thins) the v2.9 `SubagentStreamRouter` primitive once cross-stream propagation is derivable from the event log directly.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T23
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Characterization test of current router behavior; then a removal test asserting same observable behavior without router.
   - File: `servers/exarchos-mcp/src/event-store/subagent-stream-router.test.ts`
2. [GREEN] Delete router module if no remaining callers; otherwise replace its body with the query.

**Dependencies:** T26
**Parallelizable:** P4

---

### Task 28: Bundle test — two concurrent subagents reflect in parent team.disbanded

**Goal:** Implements design section *Cross-stream propagation (C2, Q3)*. Bundle test exercising the full cross-stream propagation path with two concurrent subagent worktrees writing to namespaced streams.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T23
**Implements:** DR-3
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Same as T23 acceptance fixture, but as a concrete bundle test exercising the full path; expected to flip GREEN once T24–T27 are merged.
2. [GREEN] Already passes if upstream tasks are correct.

**Dependencies:** T27
**Parallelizable:** P4 (final)

---

## Phase 5 — Capability Posture (group P5, parallel after Phase 0)

### Task 29: ACCEPTANCE — AgentPosture-derived capabilities flow through resolver

**Goal:** Implements design section *Capability posture (C5, Q5)*. Acceptance test for capability posture: an `AgentSpec` declaring `posture` produces an `EffectiveCapabilities` set merged through the resolver from yaml ⊕ handshake.

**Phase:** RED (kept RED until T30–T34 complete)
**Test Layer:** acceptance
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `Capability_PostureSpec_ResolverDerivesEffectiveCapabilities`
   - File: `servers/exarchos-mcp/src/capabilities/resolver.acceptance.test.ts`
   - Fixture: spec with `posture: 'task-isolated'`; runtime with handshake declaring `fs:read`; assert `EffectiveCapabilities` includes posture-derived caps unioned with handshake declarations.

**Dependencies:** T04
**Parallelizable:** Anchor of P5

---

### Task 30: Add `posture` field to `AgentSpec` schema

**Goal:** Implements design section *Capability posture (C5, Q5)*. Adds the `posture` field to the `AgentSpec` schema with the three known values for the capability posture surface.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Test `AgentSpec_ValidatesPostureField_AcceptsThreeKnownValues`
   - File: `servers/exarchos-mcp/src/agents/spec.test.ts`
2. [GREEN] Add `posture: z.enum(['read-only', 'task-isolated', 'shared-mutating']).optional()`.

**Dependencies:** T29
**Parallelizable:** P5

---

### Task 31: Spec validation rejects specs declaring both `posture` and `capabilities`

**Goal:** Implements design section *Capability posture (C5, Q5)*. Spec validation rejects specs declaring both `posture` and `capabilities` simultaneously, enforcing single-source-of-truth for capability posture.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Test `AgentSpec_BothPostureAndCapabilities_FailsValidationWithStructuredError`
   - File: `servers/exarchos-mcp/src/agents/spec.test.ts`
2. [GREEN] Add Zod refine ensuring exclusivity; structured error references both fields.

**Dependencies:** T30
**Parallelizable:** P5

---

### Task 32: `capabilities/posture-mapping.ts` — posture → capability set table

**Goal:** Implements design section *Capability posture (C5, Q5)*. Implements the posture → capability set mapping table with property tests asserting each posture maps to at least one capability and no two postures collide.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "unit", properties: ["each posture maps to ≥1 capability", "no two postures map to identical sets"] }`

**TDD Steps:**
1. [RED] Tests asserting properties.
   - File: `servers/exarchos-mcp/src/capabilities/posture-mapping.test.ts`
2. [GREEN] Implement table:
   - `read-only` → `{ fs:read }`
   - `task-isolated` → `{ fs:read, fs:write, isolation:worktree }`
   - `shared-mutating` → `{ fs:read, fs:write, shell:exec }`
3. [REFACTOR] Document each entry's rationale in JSDoc.

**Dependencies:** T31
**Parallelizable:** P5

---

### Task 33: `resolvePosture(spec, runtime)` returns `EffectiveCapabilities`

**Goal:** Implements design section *Capability posture (C5, Q5)*. Implements `resolvePosture(spec, runtime)` that derives `EffectiveCapabilities` for capability posture, preserving the resolver's yaml ⊕ handshake authority.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Resolver_ResolvePosture_MergesYamlPostureWithHandshakeCapabilities`
   - File: `servers/exarchos-mcp/src/capabilities/resolver.test.ts`
2. [GREEN] Implement `resolvePosture()`; reuses existing `yaml ⊕ handshake` merge contract.

**Dependencies:** T32
**Parallelizable:** P5

---

### Task 34: Legacy `capabilities[]` spec emits `spec.legacy_capabilities_array` event + `_meta.deprecation`

**Goal:** Implements design section *Capability posture (C5, Q5)*. Emits the `spec.legacy_capabilities_array` deprecation event and surfaces `_meta.deprecation` for legacy capability-array specs during the transition window.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `AgentSpec_LegacyCapabilitiesArray_EmitsDeprecationEventAndEnvelope`
   - File: `servers/exarchos-mcp/src/agents/spec.test.ts`
2. [GREEN] Spec validation path emits event when `capabilities[]` present without `posture`; consumers wrap with `_meta.deprecation`.

**Dependencies:** T33
**Parallelizable:** P5

---

### Task 59: Handshake declarations override yaml posture

**Goal:** Implements design section *Capability posture (C5, Q5)*. Closes DR-6 AC3 — design specifies *handshake declarations override resolved capabilities*. T33 tests merge but does not pin the override priority; without this test a loose-merge implementation passes review.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T29
**Implements:** DR-6
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Resolver_HandshakeOverridesYamlPosture_HandshakeWins`
   - File: `servers/exarchos-mcp/src/capabilities/resolver.test.ts`
   - Fixture: spec declares `posture: 'task-isolated'` (which maps to include `fs:write`); handshake declares `deny:fs:write`. Assert `EffectiveCapabilities.fs.write === false`.
   - Inverse fixture: yaml posture `read-only`; handshake declares `allow:fs:write`. Assert `EffectiveCapabilities.fs.write === true`.
2. [GREEN] Confirm resolver applies handshake last in the merge order; if the implementation merges symmetrically, fix to apply handshake as override.

**Dependencies:** T33
**Parallelizable:** P5

---

## Phase 6 — HSM API Single-Path (group P6, parallel after Phase 0)

### Task 35: ACCEPTANCE — `workflow.set({phase})` reroutes through canonical transition path

**Goal:** Implements design section *HSM API single-path (C4, Q4)*. Acceptance test for HSM API single-path: deprecated `workflow.set({phase})` reroutes through the canonical transition handler emitting the same `workflow.transition` event.

**Phase:** RED (kept RED until T36–T41 complete)
**Test Layer:** acceptance
**Implements:** DR-4, DR-11
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `WorkflowSet_DeprecatedAction_EmitsTransitionEventAndDeprecationEnvelope`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-set-deprecation.acceptance.test.ts`
   - Asserts: same `workflow.transition` event emitted as canonical path; `hsm.deprecated_action_invoked` event emitted; response carries `_meta.deprecation`; `outputSchema` registers the field.

**Dependencies:** T02
**Parallelizable:** Anchor of P6

---

### Task 36: `workflow.transition` is the canonical phase-mutation handler

**Goal:** Implements design section *HSM API single-path (C4, Q4)*. Confirms `workflow.transition` is the canonical phase-mutation handler emitting exactly one transition event for HSM API single-path discipline.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T35
**Implements:** DR-4
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "integration", properties: ["state machine: from any valid phase, only declared transition targets are reachable"] }`

**TDD Steps:**
1. [RED] Test `WorkflowTransition_ValidTarget_EmitsTransitionEventOnce`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-transition.test.ts`
2. [GREEN] Confirm the transition handler is intact post-substrate-flip; no behavior change required if v2.9 path is preserved.

**Dependencies:** T35
**Parallelizable:** P6

---

### Task 37: `workflow.set({phase})` handler delegates to transition handler

**Goal:** Implements design section *HSM API single-path (C4, Q4)*. Refactors `workflow.set({phase})` to delegate into the shared transition handler, eliminating the second phase-write surface for HSM API single-path.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T35
**Implements:** DR-4
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `WorkflowSet_PhaseDelegate_RoutesToTransitionHandlerNoSecondPath`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-set.test.ts`
2. [GREEN] Replace any direct phase-write code in the `set` handler with a call into the transition handler.
3. [REFACTOR] Single shared private `applyTransition()` helper consumed by both action handlers.

**Dependencies:** T36
**Parallelizable:** P6

---

### Task 38: Each `set({phase})` invocation emits `hsm.deprecated_action_invoked`

**Goal:** Implements design section *HSM API single-path (C4, Q4)*. Each `workflow.set({phase})` invocation emits an `hsm.deprecated_action_invoked` event for telemetry against the HSM API single-path migration.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T35
**Implements:** DR-4
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `WorkflowSet_OnInvocation_EmitsHsmDeprecatedActionInvoked`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-set.test.ts`
2. [GREEN] In `set({phase})` handler, emit event with `data: { action: 'workflow.set.phase', invokedBy: ctx.invokerId }`.

**Dependencies:** T37
**Parallelizable:** P6

---

### Task 39: ACCEPTANCE — Action `outputSchema` bumped + `_meta.deprecation` registered

**Goal:** Implements design section *Output-contract registration (INV-5b)*. Acceptance test for output-contract registration: `_meta.deprecation` registered in `outputSchema` for both affected actions; CLI/MCP byte-equivalent.

**Phase:** RED (kept RED until T40–T41 complete)
**Test Layer:** acceptance
**Implements:** DR-4, DR-11
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `OutputSchema_AffectedActions_RegistersMetaDeprecation`
   - File: `servers/exarchos-mcp/src/registry.acceptance.test.ts`
   - Asserts both `exarchos_workflow.set` and `exarchos_workflow.transition` schemas register `_meta.deprecation` and pass parity test for byte-equivalence between CLI and MCP.

**Dependencies:** T35
**Parallelizable:** P6

---

### Task 40: Bump `outputSchema` for `exarchos_workflow.set` and `.transition`; register `_meta.deprecation`

**Goal:** Implements design section *Output-contract registration (INV-5b)*. Bumps `outputSchema` for `exarchos_workflow.set` and `.transition` to register the typed `_meta.deprecation` sub-shape per output-contract registration.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T39
**Implements:** DR-11
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Registry_OutputSchema_RegistersMetaDeprecationOnAffectedActions`
   - File: `servers/exarchos-mcp/src/registry.test.ts`
2. [GREEN] In `registry.ts`, declare `_meta.deprecation` (optional sub-schema with `since`, `removeIn`, `replacement`); bind via `server.registerTool()`.

**Dependencies:** T39
**Parallelizable:** P6

---

### Task 41: `describe` entries for `set` and `transition` reflect deprecation + tool description carries "Do NOT use" pointer

**Goal:** Implements design section *Output-contract registration (INV-5b)*. Updates `describe` entries for the affected actions and adds the explicit 'Do NOT use' pointer to the deprecated tool description for output-contract registration.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T39
**Implements:** DR-4, DR-11
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Tests:
   - `Describe_SetAction_ReturnsDeprecatedTrue`
   - `ToolDescription_SetAction_ContainsDoNotUsePointer`
   - File: `servers/exarchos-mcp/src/orchestrate/describe.test.ts`
2. [GREEN] Update describe metadata + tool description string in `registry.ts`.

**Dependencies:** T40
**Parallelizable:** P6

---

### Task 42: `workflow.transition` guard-failure error envelope (validTargets, expectedShape, suggestedFix)

**Goal:** Implements design section *HSM API single-path (C4, Q4)*. Implements the structured guard-failure error envelope (`validTargets`, `expectedShape`, `suggestedFix`) for `workflow.transition` per HSM API single-path requirements.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T35
**Implements:** DR-5
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `WorkflowTransition_GuardFailure_PopulatesValidTargetsAndSuggestedFix`
   - File: `servers/exarchos-mcp/src/orchestrate/workflow-transition.test.ts`
   - Plus parity-harness fixture under `__tests__/parity-harness.ts`.
2. [GREEN] Failure path returns error envelope with `validTargets[]` from HSM topology, `expectedShape`, `suggestedFix` referencing closest valid transition.
3. [REFACTOR] Extract `buildGuardFailureError()` helper.

**Dependencies:** T36
**Parallelizable:** P6

---

## Phase 7 — Phase Contract (group P7, parallel after Phase 0)

### Task 43: ACCEPTANCE — typed phase contracts feed pruner; missing contract emits `phase.contract_missing`

**Goal:** Implements design section *Phase contract (C6, Q6)*. Acceptance test for the phase contract: typed contracts feed the pruner; phases without contracts trigger a `phase.contract_missing` event at startup.

**Phase:** RED (kept RED until T44–T48 complete)
**Test Layer:** acceptance
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "acceptance" }`

**TDD Steps:**
1. [RED] Acceptance test `PhaseContract_LoaderAndScorer_HonorsTypedContractAndEmitsMissingEvent`
   - File: `servers/exarchos-mcp/src/topology/phase-contract.acceptance.test.ts`
   - Two fixtures: complete contracts vs partial contracts; assert pruner uses contract when present, falls back to single-signal otherwise, emits `phase.contract_missing` per missing phase at startup.

**Dependencies:** T03
**Parallelizable:** Anchor of P7

---

### Task 44: `topology/loader.ts` typed loader called once at startup

**Goal:** Implements design section *Phase contract (C6, Q6)*. Implements the typed topology loader called once at lifecycle start; returns an immutable Topology object for the phase contract surface.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T43
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `TopologyLoader_LoadOnce_ReturnsImmutableTopology`
   - File: `servers/exarchos-mcp/src/topology/loader.test.ts`
2. [GREEN] Implement `loadTopology()` reading `topology.yaml`, parsing through Zod schema, returning frozen object.
3. [REFACTOR] Cache result; expose `getTopology()` accessor.

**Dependencies:** T43
**Parallelizable:** P7

---

### Task 45: `PhaseContract` type + Zod schema with malformed-input rejection

**Goal:** Implements design section *Phase contract (C6, Q6)*. Defines the `PhaseContract` Zod schema with malformed-input rejection for the phase contract loader.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T43
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Tests for: well-formed contract, missing field, wrong-type field, unknown signal name.
   - File: `servers/exarchos-mcp/src/topology/phase-contract.test.ts`
2. [GREEN] Implement `PhaseContractSchema = z.object({ expectedMaxDwellMinutes: z.number().int().positive(), signals: z.array(StalenessSignalSchema), freshnessRequires: z.enum(['all', 'any']) })`.

**Dependencies:** T44
**Parallelizable:** P7

---

### Task 46: `pruner/score.ts` accepts `PhaseContract | undefined`; falls back to current heuristic when undefined

**Goal:** Implements design section *Phase contract (C6, Q6)*. Refactors the pruner to accept a typed `PhaseContract | undefined` and fall back to the v2.9 single-signal heuristic when the phase contract is undefined.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T43
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Tests for both branches: with contract scores per signals; without contract scores per single-signal heuristic.
   - File: `servers/exarchos-mcp/src/pruner/score.test.ts`
2. [GREEN] Refactor pruner; isolate scoring into pure function `scoreStaleness(state, contract)`; default branch reproduces v2.9 behavior.
3. [REFACTOR] Move pruner orchestration to a thin coordinator above the pure scorer.

**Dependencies:** T45
**Parallelizable:** P7

---

### Task 47: Missing phase contract emits `phase.contract_missing` once at startup

**Goal:** Implements design section *Phase contract (C6, Q6)*. Emits `phase.contract_missing` once per missing-contract phase at startup, enabling telemetry for the phase contract migration.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T43
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Topology_StartupWithMissingContracts_EmitsPhaseContractMissingPerPhaseOnce`
   - File: `servers/exarchos-mcp/src/topology/loader.test.ts`
2. [GREEN] On `loadTopology()`, walk phases; emit per-phase event for any phase missing `staleness`.

**Dependencies:** T46
**Parallelizable:** P7

---

### Task 48: Pruner integration with phase-contract + bundle test

**Goal:** Implements design section *Phase contract (C6, Q6)*. Bundle integration test wiring the typed phase contract through the pruner orchestration with multi-phase fixtures.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T43
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test exercising full pruner path with multi-phase fixture.
   - File: `servers/exarchos-mcp/src/pruner/integration.test.ts`
2. [GREEN] Wire `getTopology().phases[name].staleness` into pruner orchestration.

**Dependencies:** T47
**Parallelizable:** P7 (final)

---

## Phase 8 — Integration & POC Validation (sequential after P3, P4, P5, P6, P7)

### Task 49: ACCEPTANCE — POC seam validation; existing AtomicAppender call sites unchanged

**Goal:** Implements design section *POC scope (acceptance criteria of #1259)*. Acceptance test for POC scope: SQLite-backed storage primitive proves the seam holds — all seven AtomicAppender consumers unchanged and bench hits ≥1000 ops/sec/stream.

**Phase:** RED (kept RED until T50–T55 complete)
**Test Layer:** acceptance
**Implements:** DR-13
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, testLayer: "acceptance", performanceSLAs: [{ operation: "event-append", metric: "ops_per_sec", threshold: 1000 }] }`

**TDD Steps:**
1. [RED] Acceptance test `Poc_SqliteBackend_AllSevenConsumersUnchangedAndBenchHits1000OpsPerSec`
   - File: `servers/exarchos-mcp/src/event-store/poc.acceptance.test.ts`

**Dependencies:** T22, T28, T34, T42, T48
**Parallelizable:** Anchor of integration phase

---

### Task 50: Parametric `atomic-appender.test.ts` runs against both backends

**Goal:** Implements design section *POC scope (acceptance criteria of #1259)*. Parametric acceptance test for POC scope: the existing `atomic-appender.test.ts` runs against both `'jsonl'` and `'sqlite'` backends.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-13
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Run existing `atomic-appender.test.ts` parametrized over `['jsonl', 'sqlite']`; expected RED for any case where SQLite backend behaves differently.
2. [GREEN] Refactor existing test to a `describe.each`; fix any divergences.

**Dependencies:** T49
**Parallelizable:** Sequential

---

### Task 51: `store.race.test.ts` race tests under SQLite

**Goal:** Implements design section *Failure-mode coverage (DIM-7, error-handling DR per skill rule)*. Race tests for the storage primitive under SQLite verifying linearizability across concurrent multi-stream writes.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-1, DR-12, DR-13
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "integration", properties: ["linearizability under concurrent multi-stream writes"] }`

**TDD Steps:**
1. [RED] Confirm existing race tests run against SQLite backend; expected RED for any uncovered race window.
2. [GREEN] Address any new races surfaced by tighter atomicity (likely none if T06–T11 are correct).

**Dependencies:** T50
**Parallelizable:** Sequential

---

### Task 52: `store.property.test.ts` replay-determinism under SQLite

**Goal:** Implements design section *Storage primitive (C1, Q1)*. Replay-determinism property tests for the storage primitive proving the SQLite-backed substrate folds events to identical state.

**Phase:** RED → GREEN
**Test Layer:** property
**Acceptance Test Ref:** T49
**Implements:** DR-1
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, testLayer: "integration", properties: ["replay determinism: fold(events) is deterministic regardless of substrate"] }`

**TDD Steps:**
1. [RED] Run replay-determinism property tests against SQLite backend.
2. [GREEN] Address any drift.

**Dependencies:** T51
**Parallelizable:** Sequential

---

### Task 53: `parity.test.ts` covers `_meta.deprecation` byte-equivalence across CLI and MCP

**Goal:** Implements design section *Output-contract registration (INV-5b)*. Parity test ensuring `_meta.deprecation` envelope is byte-equivalent across CLI and MCP carriers per output-contract registration.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-11
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] New parity fixture: deprecated `set({phase})` invocation; assert byte-identical envelopes for CLI and MCP carriers.
   - File: `servers/exarchos-mcp/src/event-store/parity.test.ts`
2. [GREEN] If diverges, fix at `formatResult` boundary.

**Dependencies:** T52
**Parallelizable:** Sequential

---

### Task 54: `store.bench.ts` documents SQLite throughput, regression gate

**Goal:** Implements design section *POC scope (acceptance criteria of #1259)*. Bench documenting SQLite append throughput per stream for POC scope, with a regression gate at ≥1000 ops/sec/stream.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-13
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: true, testLayer: "integration", performanceSLAs: [{ operation: "event-append", metric: "ops_per_sec", threshold: 1000 }] }`

**TDD Steps:**
1. [RED] Bench fails if SQLite append throughput < 1000 ops/sec/stream.
2. [GREEN] Tune transaction or prepared statements as needed.

**Dependencies:** T53
**Parallelizable:** Sequential

---

### Task 55: End-to-end migration integration test (fresh-install + legacy fixtures)

**Goal:** Implements design section *Migration plan (Q2, Q8)*. End-to-end migration plan integration test exercising both fresh-install and legacy-JSONL fixtures producing healthy SQLite state and correct event emissions.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-8, DR-9
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Two-fixture e2e test: fresh install (no legacy files) and legacy-JSONL install; both produce healthy SQLite state and correct event emissions.
   - File: `servers/exarchos-mcp/src/storage/migration.integration.test.ts`
2. [GREEN] Address gaps surfaced.

**Dependencies:** T54
**Parallelizable:** Sequential

---

### Task 57: Lifecycle wires migration runner at startup

**Goal:** Implements design section *Migration plan (Q2, Q8)*. Closes DR-8 AC1 — design specifies *"Migration runs at lifecycle start when SQLite database has no rows in `schema_version` matching SCHEMA_VERSION 3"*. Phase 3 builds the runner primitives (T19–T22) and the cross-process lock (T60); this task wires them into `lifecycle.ts` startup so the migration actually fires.

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-8
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

**TDD Steps:**
1. [RED] Test `Lifecycle_StartWithLegacyJsonl_TriggersMigrationBeforeFirstAppend`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.test.ts` (existing file; add case)
   - Fixture: legacy `*.events.jsonl` files present, SQLite `schema_version` < 3. Lifecycle start. Assert migration runs to completion BEFORE the first runtime `AtomicAppender.append` call.
   - Idempotency: a second lifecycle start (with `schema_version === 3`) is a no-op (no migration events emitted).
2. [GREEN] In `lifecycle.ts`, after opening SQLite connection and before constructing `DispatchContext`, check schema version, claim migration lock, run importer, release on completion.
3. [REFACTOR] Extract `runMigrationIfNeeded(storage)` into a sibling module under `storage/`.

**Dependencies:** T55, T60
**Parallelizable:** Sequential

---

### Task 58: Lifecycle wires topology loader + emits `phase.contract_missing` at startup

**Goal:** Implements design section *Phase contract (C6, Q6)*. Closes DR-7 startup-wiring gap — design specifies the typed loader is *"called once at lifecycle start"* and emits `phase.contract_missing` per missing-contract phase *"once at startup"*. T44 implements the loader; T47 implements the emission inside the loader; T48 wires the contract into the pruner. This task wires `loadTopology()` into `lifecycle.ts` so the startup-emission semantics actually fire.

**Phase:** RED → GREEN
**Test Layer:** integration
**Acceptance Test Ref:** T49
**Implements:** DR-7
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [RED] Test `Lifecycle_Start_LoadsTopologyOnceAndEmitsContractMissingPerMissingPhase`
   - File: `servers/exarchos-mcp/src/storage/lifecycle.test.ts` (existing file; add case)
   - Fixture: `topology.yaml` with two phases declaring `staleness`, three missing. Lifecycle start. Assert `phase.contract_missing` emitted exactly three times (once per missing phase). Subsequent lifecycle start (within the same process) does NOT re-emit.
2. [GREEN] In `lifecycle.ts`, call `loadTopology()` once at startup; cache the result; surface via `getTopology()`. The startup walk emits per-phase events for any phase missing `staleness`.

**Dependencies:** T55, T57
**Parallelizable:** Sequential (after T57 to avoid lifecycle test cross-pollination)

---

### Task 61: AtomicAppender consumer enumeration witness

**Goal:** Implements design section *POC scope (acceptance criteria of #1259)*. Closes DR-13 AC3 — *"Zero changes required in any of the seven current consumers of `AtomicAppender` (verified by `grep -l AtomicAppender` enumeration)"*. T49 acceptance asserts the property at the test layer; this task makes the enumeration discrete and reviewable so the count is pinned and a regression in either direction (new consumer, removed consumer) is caught.

**Phase:** RED → GREEN
**Test Layer:** unit
**Acceptance Test Ref:** T49
**Implements:** DR-1, DR-13
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "unit" }`

**TDD Steps:**
1. [RED] Test `AtomicAppender_ConsumerCount_MatchesBaselineEnumeration`
   - File: `servers/exarchos-mcp/src/event-store/atomic-appender-consumers.test.ts`
   - Greps `servers/exarchos-mcp/src/**/*.ts` (excluding `__tests__/` and `__shims__/`) for `import .* AtomicAppender` and asserts the resulting set matches a frozen baseline list checked into the test fixture.
2. [GREEN] Establish the baseline by running the grep against the post-T55 tree and committing the enumeration. Any future drift fails this test, forcing an explicit acknowledgement.

**Dependencies:** T55
**Parallelizable:** Sequential

---

## Phase 9 — Followup (sequential, last)

### Task 56: Open v2.11.0 cleanup follow-up issue

**Goal:** Implements design section *V2.11 cleanup tracking*. Opens the V2.11 cleanup tracking issue listing exact removal sites for the deprecation shims introduced by this design.

**Phase:** GREEN (no test — issue creation)
**Test Layer:** integration
**Implements:** DR-14
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration" }`

**TDD Steps:**
1. [GREEN] `gh issue create --title "v2.11 cleanup: remove durable-substrate deprecation shims" --body "..."` referencing this design's DR-4, DR-6, DR-7. Body lists exact removal sites and reviews telemetry counters before cut.

**Dependencies:** T58, T61
**Parallelizable:** No

---

## Parallelization Strategy

After Phase 0 completes (T01–T04, T12, T13), seven parallel groups can dispatch concurrently:

| Group | Tasks | Worktree branch |
|---|---|---|
| **P0** Foundation | T01–T04, T12, T13 | `feature/durable-substrate-foundation` (sequential prerequisite) |
| **P1** Storage substrate | T05–T11 | `feature/durable-substrate-storage` |
| **P2** DispatchContext | T14–T17 | `feature/durable-substrate-context` (depends on P1) |
| **P3** Migration | T18–T22, T60 | `feature/durable-substrate-migration` (depends on P2) |
| **P4** Cross-stream namespacing | T23–T28 | `feature/durable-substrate-namespacing` |
| **P5** Capability posture | T29–T34, T59 | `feature/durable-substrate-posture` |
| **P6** HSM single-path | T35–T42 | `feature/durable-substrate-hsm` |
| **P7** Phase contract | T43–T48 | `feature/durable-substrate-phase-contract` |

**Sequential constraints:**
- P0 (T01–T04, T12, T13) → all parallel groups (P1–P7)
- P1 → P2 → P3 (storage handle must exist before migration runs)
- P3, P4, P5, P6, P7 → Phase 8 integration / POC validation (T49–T55)
- Phase 8 → lifecycle-wiring tasks (T57 → T58) and consumer enumeration (T61)
- T58, T61 → Phase 9 (T56)

P4, P5, P6, P7 are mutually independent and run concurrently with P1→P2→P3 chain.

## Deferred Items

| Item | Rationale | Tracking |
|---|---|---|
| Basileus-remote shared store (Q3) | Spike scoped local-only per ideate; cross-stream query primitive remains transport-agnostic | #1081 |
| `exarchos watch` sideband daemon | Explicit out-of-scope per spike | (no issue yet) |
| Multi-author concurrent-checkpoint semantics | Explicit out-of-scope per spike | (no issue yet) |
| `workflow.repair` admin override | Approach C analysis rejected; if needed post-v2.11, opens as separate design | (no issue yet) |
| v2.11 shim removal | Tracked under DR-14; not in this plan's scope | T56 |
| Posture handshake field type-coordination with #1139 | Contract surfaced in this plan (DR-6); detailed wiring in #1139 | #1139 |

## Completion Checklist

- [ ] All tests written before implementation (TDD compliance verified per task)
- [ ] All tests pass
- [ ] Code coverage meets standards (line ≥80, branch ≥70, function 100)
- [ ] Provenance chain verified (every DR-N traces to ≥1 task via `Implements:` field)
- [ ] Plan-design coverage gate passes
- [ ] Task decomposition gate run (advisory)
- [ ] Spec-coverage check passes
- [ ] Ready for review
