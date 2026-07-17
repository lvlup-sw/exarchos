# Implementation Plan: Event-store concurrency — the stream-version gate

**Design:** `docs/designs/2026-06-22-event-store-concurrency-optimal.md`
**Feature ID:** `event-store-concurrency-optimal`
**Date:** 2026-06-22

## Scope

Full scope. All six design requirements (DR-1…DR-6) are planned. Global cross-stream ordering stays deferred per the design's Open Questions (no tasks).

## Traceability Matrix

| Design requirement | Tasks |
|---|---|
| DR-1 — allocation + OCC inside the write txn | T001, T002, T003, T004, T010 |
| DR-2 — one retry contract | T004, T005 |
| DR-3 — `BEGIN IMMEDIATE` fail-fast | T006 |
| DR-4 — configurable durability | T007 |
| DR-5 — INV-7 + narrative reconciliation | T008, T009 |
| DR-6 — error handling, failure modes, recovery | T002, T003, T010, T011 |

## Risk-tier rationale

The gate path (T001–T004, T010–T011) touches the substrate write seam shared by every workflow — high blast radius, so **high tier** with real-collaborator integration + the adequacy kill-probe. The retry-contract narrowing and the two config/init changes are **medium** (scoped tests). The catalog/narrative/comment edits are **low** (static analysis; docs only).

---

## Tasks

### Task 001: Gate prepared statements on SqliteBackend
**Implements:** DR-1
**Risk Tier:** medium
**Boundary Touching:** true

Add prepared statements for the version gate against the existing `sequences` row: an unconditional bump-and-return for plain appends (`INSERT … ON CONFLICT(streamId) DO UPDATE SET sequence = sequence + ?n RETURNING sequence`), a conditional bump for OCC (`UPDATE sequences SET sequence = sequence + ?n WHERE streamId = ? AND sequence = ?k`), and the new-stream OCC insert. No schema change.

**Verification (medium):** scoped tests + `check_test_adequacy`.
- `BumpReturning_NewStream_ReturnsN`
- `BumpIfExpected_StaleVersion_AffectsZeroRows`
- `BumpIfExpected_MatchingVersion_AffectsOneRow`

**Files:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`, `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
**Dependencies:** None
**Parallelizable:** No (head of the gate chain)

### Task 002: Allocate-under-lock in `atomicAppend`
**Implements:** DR-1, DR-6
**Risk Tier:** high
**Boundary Touching:** true

Rewrite `atomicAppend` so the gate runs **inside** `BEGIN IMMEDIATE`: invoke the bump (plain or OCC), derive event `sequence` values from the returned base, insert events, build the `idempotency_claims.events_json` from the authoritative numbers, and return the assigned base. Zero-row OCC bump aborts the txn with a typed conflict carrying `expected`/`actual`. The pre-transaction HWM read for allocation is removed.

**Verification (high):** scoped tests + `check_test_adequacy` + integration across the seam.
- `AtomicAppend_PlainConcurrent_AllocatesContiguousNoConflict`
- `AtomicAppend_OccStale_ReturnsExpectedActual`
- `AtomicAppend_CrashBetweenBumpAndInsert_RollsBackNoGap`

**Files:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`, `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
**Dependencies:** T001
**Parallelizable:** No

### Task 003: Remove pre-transaction allocation from `appendSqliteLocked`
**Implements:** DR-1, DR-6
**Risk Tier:** high
**Boundary Touching:** true

Stop pre-computing `baseSeq + i` in `AtomicAppender.appendSqliteLocked`; pass event count `n` + optional `expectedSequence` into `atomicAppend` and stamp `sequence`/`eventId`/`timestamp` from the returned base. Keep the idempotency cache-hit short-circuit outside the lock. Demote `translateAtomicAppendError` to a backstop: an `events` PK violation under the gate is a genuine anomaly → `io-error` with cause, **not** a re-mapped cache-hit/conflict. Delete the sequence-conflict tail re-read recovery (the gate returns `expected`/`actual` directly).

**Verification (high):** scoped tests + `check_test_adequacy` + integration.
- `AppendSqliteLocked_DerivesSeqFromGate_NoPreflightRead`
- `AppendSqliteLocked_CacheHit_ShortCircuitsOutsideLock`
- `TranslateAtomicAppendError_PkViolation_SurfacesIoErrorAnomaly`

**Files:** `servers/exarchos-mcp/src/event-store/atomic-appender.ts`, `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
**Dependencies:** T002
**Parallelizable:** No

### Task 004: Wire OCC conflict translation to gate output
**Implements:** DR-1, DR-2
**Risk Tier:** high
**Boundary Touching:** false

`decide` / `withSession` / explicit-`expectedSequence` paths derive `ConcurrencyError(expected, actual)` from the gate's zero-row result instead of regex-matching SQLite constraint strings. Ensure `EventStore.delegateAppend` / `handleEventAppend` surface the typed conflict only for real OCC.

**Verification (high):** scoped tests + `check_test_adequacy`.
- `Decide_OccLoss_ThrowsConcurrencyErrorFromGate`
- `DelegateAppend_PlainRace_NeverThrowsSequenceConflict`

**Files:** `servers/exarchos-mcp/src/event-store/atomic-appender.ts`, `servers/exarchos-mcp/src/event-store/concurrency-error.ts`, `servers/exarchos-mcp/src/event-store/store.ts`, co-located tests
**Dependencies:** T003
**Parallelizable:** No

### Task 005: Collapse the retry contract
**Implements:** DR-2
**Risk Tier:** medium
**Boundary Touching:** false

Remove `withStateRetry` wrapping from plain-append call sites; reserve it for genuine OCC load→decide→save handlers. Narrow the retry predicate to real `ConcurrencyError`/`StorageBusyError`. Add a test (or grep gate) asserting no `withStateRetry` wraps a plain-append site.

**Verification (medium):** scoped tests + `check_test_adequacy`.
- `PlainAppendHandler_NotRetryWrapped`
- `OccHandler_RetriesReFoldOnConflict`

**Files:** `servers/exarchos-mcp/src/workflow/state-retry.ts`, plain-append call sites (e.g. `orchestrate/vcs/*.ts`, `task-store/event-sourced-task-store.ts`), co-located tests
**Dependencies:** T004
**Parallelizable:** No

### Task 006: `BEGIN IMMEDIATE` fail-fast assertion
**Implements:** DR-3
**Risk Tier:** medium
**Boundary Touching:** true

Assert in `SqliteBackend.initialize()` that the driver exposes `transaction(fn).immediate`; throw a typed, operator-facing error otherwise. Delete the deferred-`BEGIN` fallback branch in `atomicAppend`.

**Verification (medium):** scoped tests + `check_test_adequacy`.
- `Initialize_DriverLacksImmediate_ThrowsTyped`
- `AtomicAppend_NoDeferredFallbackBranch`

**Files:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`, `servers/exarchos-mcp/src/storage/sqlite-backend.test.ts`
**Dependencies:** T002
**Parallelizable:** No (shares `atomicAppend` with the gate chain)

### Task 007: Configurable `synchronous` durability
**Implements:** DR-4
**Risk Tier:** medium
**Boundary Touching:** true

Add `storage.synchronous: normal | full` (default `normal`) to the layered config resolver; apply it in `applyConnectionPragmas`; reject invalid values at config-load with a typed error. Document the crash-vs-power-loss boundary at the pragma site.

**Verification (medium):** scoped tests + `check_test_adequacy`.
- `Synchronous_DefaultNormal_PragmaReadsOne`
- `Synchronous_ConfigFull_PragmaReadsTwo`
- `Synchronous_InvalidValue_RejectedAtLoad`

**Files:** `servers/exarchos-mcp/src/storage/sqlite-backend.ts`, `servers/exarchos-mcp/src/config/*`, co-located tests
**Dependencies:** None
**Parallelizable:** Yes (independent of the gate chain)

### Task 008: Refine INV-7 catalog entry
**Implements:** DR-5
**Risk Tier:** low
**Boundary Touching:** false

Rewrite INV-7's `summary` in `.exarchos/invariants.md` to describe the in-transaction version gate (assigns-and-checks atomically; PK is an integrity backstop). Re-run `vocabulary-lint` / `check_invariant_conformance`.

**Verification (low):** static analysis + the two invariant gates green.

**Files:** `.exarchos/invariants.md`
**Dependencies:** None
**Parallelizable:** Yes

### Task 009: Reconcile system-design narrative + scrub stale comments
**Implements:** DR-5
**Risk Tier:** low
**Boundary Touching:** false

Edit `docs/system-design.html` §03 to describe transparent serialization for plain appends and reserve "conflict" for genuine OCC (drop the "whole concurrency story" overstatement). Scrub the stale "PID lock" comments at `sqlite-backend.ts:661,1097` and `sidecar-scheduler.ts:61`.

**Verification (low):** static analysis; `grep -n "PID lock"` returns zero non-test hits.

**Files:** `docs/system-design.html`, `servers/exarchos-mcp/src/storage/sqlite-backend.ts` (comments), `servers/exarchos-mcp/src/storage/sidecar-scheduler.ts` (comment)
**Dependencies:** T007
**Parallelizable:** No (shares `sqlite-backend.ts` with T007 and the gate chain — run its comment scrub after they land)

### Task 010: Multi-process concurrency proof (regression guard)
**Implements:** DR-1, DR-6
**Risk Tier:** high
**Boundary Touching:** true

Spawn N OS processes appending to one hot stream against a shared DB file; assert contiguous sequences, **zero** `sequence-conflict`, and all commits durable. This is the TOCTOU-fix regression guard called out in the design's Testing Strategy.

**Verification (high):** integration test across the seam + `check_integration_suite`.
- `HotStream_NProcessConcurrentAppend_ContiguousZeroConflict`

**Files:** `servers/exarchos-mcp/src/event-store/atomic-appender.concurrency.test.ts`
**Dependencies:** T004
**Parallelizable:** Yes (with T011, after T004)

### Task 011: Idempotency + crash/anomaly edge coverage
**Implements:** DR-6
**Risk Tier:** high
**Boundary Touching:** true

Cover the DR-6 failure modes: keyed-retry cache-hit preserved (INV-8); simulated crash between gate bump and insert → no per-stream gap, clean re-append; backstop PK anomaly → `io-error`; `busy_timeout` + JS-budget exhaustion → `storage_busy`.

**Verification (high):** scoped tests + `check_test_adequacy`.
- `KeyedRetry_SameKey_ReturnsCacheHit`
- `Crash_BetweenBumpAndInsert_NoGapReappendSucceeds`
- `BusyExhausted_SurfacesStorageBusy`

**Files:** `servers/exarchos-mcp/src/event-store/atomic-appender.test.ts`
**Dependencies:** T003
**Parallelizable:** Yes (with T010, after T003/T004)

---

## Parallelization

```
Gate chain (sequential):   T001 → T002 → T003 → T004 → T005
                                      └→ T006 (after T002)
Edge/integration (after T004): T010, T011  (parallel pair)
Independent (parallel from start): T007, T008
After T007: T009 (shares sqlite-backend.ts)
```

- **Sequential spine:** T001→T002→T003→T004→T005 (each edits the gate/append seam; no concurrent edits to the same file).
- **T006** branches off after T002 but shares `atomicAppend`; merge before/after the spine touches it, not concurrently.
- **T007, T008** touch disjoint files (config+`sqlite-backend.ts` pragma, catalog) — safe in parallel worktrees from the start.
- **T009** edits comments in `sqlite-backend.ts` (plus disjoint `system-design.html` / `sidecar-scheduler.ts`), so it shares a file with T007 and the gate chain — sequenced after T007 to avoid a worktree merge conflict.
- **T010, T011** are test-only, depend on the wired gate (T004/T003); run as a parallel pair.

## Deferred verification (post-implementation)

`spec_coverage_check`, `check_coverage_thresholds`, and `check_integration_suite` run after the tasks land (they require the new test files to exist); they are not plan-time gates.
