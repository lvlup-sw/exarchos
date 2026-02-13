# Implementation Plan: Exarchos MCP Server Optimization

## Source

Audit prompt: `docs/prompts/optimize.md`
Workflow state: `refactor-exarchos-mcp-optimize`

## Scope

**Target:** Token economy, I/O performance, concurrency safety, saga/outbox improvements
**Excluded:**
- Remote sync (Marten/PostgreSQL) wiring — outbox is scaffolded, not production-ready
- Guard composition (AND/OR) — existing guards work correctly
- Sequence counter eviction — negligible memory impact
- Team coordinator worktree cleanup — separate concern
- Adding tests for untested files (guards.ts, hsm-definitions.ts, etc.) — separate effort

**Already Implemented (discovered during exploration):**
- `recentEvents` in `workflow_summary` — already compact (`{ type, timestamp }` via `getRecentEventsFromStore`)
- Snapshot loading in view materializer hot path — all handlers call `loadFromSnapshot()` before `materialize()`

## Summary

- Total tasks: 8
- Parallel groups: 4
- Estimated test count: 20
- Design coverage: 8 of 10 brief goals (2 already met)

## Spec Traceability

| Brief Goal | Requirement | Task ID(s) | Status |
|------------|-------------|------------|--------|
| Compact recentEvents in workflow_summary | Token reduction | — | Already implemented |
| Lazy pagination in handleViewPipeline | Materialize only paginated subset | 001 | Covered |
| Add pagination to handleStackStatus | Offset/limit support | 002 | Covered |
| Pre-parse sequence filtering in query() | Skip JSON.parse for filtered events | 003 | Covered |
| Load snapshots in materializer hot path | Avoid cold-start replay | — | Already implemented |
| CAS for state file operations | Prevent lost updates | 004 | Covered |
| Fix task claim TOCTOU race | Atomic claim-or-fail | 005 | Covered |
| Idempotency key for event append | Dedup on retry | 006 | Covered |
| Idempotent compensation with checkpoint | Resume after partial failure | 007 | Covered |
| Dead-letter recovery in outbox | Re-queue dead-letter entries | 008 | Covered |

## Task Breakdown

---

### Task 001: Lazy Pipeline View Pagination

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `handleViewPipeline_WithLimit_OnlyMaterializesSubset`
   - File: `__tests__/views/tools.test.ts`
   - Setup: Create 5 event streams with events in stateDir
   - Call `handleViewPipeline({ limit: 2 }, stateDir)`
   - Assert: Response contains exactly 2 workflows
   - Expected failure: Currently materializes all 5, assertion on count will pass but we need to verify lazy behavior

   Write test: `handleViewPipeline_WithOffsetAndLimit_ReturnsCorrectSlice`
   - File: `__tests__/views/tools.test.ts`
   - Setup: Create 5 event streams
   - Call `handleViewPipeline({ offset: 2, limit: 2 }, stateDir)`
   - Assert: Response contains workflows 3-4 (0-indexed)
   - Expected failure: Current implementation materializes all 5 then slices — semantically same result but we're testing correct behavior

2. [GREEN] Implement lazy pagination in `handleViewPipeline`
   - File: `src/views/tools.ts`
   - Changes:
     - Apply `offset`/`limit` to `streamIds` array BEFORE the materialization loop
     - `const paginatedIds = streamIds.slice(start, end)` then iterate only `paginatedIds`
     - Return `{ workflows: paginated, total: streamIds.length }` (add total count for pagination awareness)

3. [REFACTOR] Extract stream discovery + pagination into a helper if needed

**Verification:**
- [ ] Tests pass with correct pagination behavior
- [ ] `total` field exposed for client-side pagination
- [ ] No unnecessary materializations

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Stack Status Pagination

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `handleStackStatus_WithPagination_ReturnsSubset`
   - File: `__tests__/stack/tools.test.ts`
   - Setup: Append 10 `stack.position-filled` events to a stream
   - Call `handleStackStatus({ streamId: 'test', limit: 3 }, stateDir)`
   - Assert: Response data has exactly 3 positions
   - Expected failure: `limit` parameter not recognized, returns all 10

   Write test: `handleStackStatus_WithOffset_SkipsPositions`
   - File: `__tests__/stack/tools.test.ts`
   - Setup: Same 10 events
   - Call `handleStackStatus({ streamId: 'test', offset: 5, limit: 3 }, stateDir)`
   - Assert: Response has 3 positions starting from index 5

2. [GREEN] Add pagination to `handleStackStatus`
   - File: `src/stack/tools.ts`
   - Changes:
     - Add `limit?: number` and `offset?: number` to args type
     - After materializing, apply `positions.slice(offset, offset + limit)`
     - Update Zod schema in `registerStackTools` to accept `limit` and `offset`

3. [REFACTOR] Align parameter names with views/tools.ts convention

**Verification:**
- [ ] Tests pass with correct pagination behavior
- [ ] Zod schema updated
- [ ] Existing tests still pass (no-arg calls return all positions)

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 003: Pre-Parse Sequence Filtering in EventStore.query()

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `query_WithSinceSequence_CorrectlyFilters`
   - File: `__tests__/event-store/store.test.ts`
   - Setup: Append 100 events to a stream
   - Call `store.query(streamId, { sinceSequence: 90 })`
   - Assert: Returns exactly 10 events (sequence 91-100)
   - Expected failure: Test will actually pass (filtering works), but we add a performance assertion

   Write test: `query_WithSinceSequenceAndLimit_CombinesCorrectly`
   - File: `__tests__/event-store/store.test.ts`
   - Setup: Append 100 events
   - Call `store.query(streamId, { sinceSequence: 90, limit: 5 })`
   - Assert: Returns 5 events (91-95), with early termination

2. [GREEN] Optimize query to skip parsing for low-sequence events
   - File: `src/event-store/store.ts`
   - Changes:
     - When `sinceSequence` is provided and no other filters (type, since, until), track line count
     - Since sequences are monotonically increasing (1, 2, 3...), lines before `sinceSequence` can be skipped without JSON.parse
     - Add fast-skip: count non-empty lines, skip `JSON.parse` until line count > `sinceSequence`
     - Fall back to full parse when other filters are present (type, date range)

3. [REFACTOR] Extract the fast-skip logic into a private helper method

**Verification:**
- [ ] All existing event store tests pass
- [ ] New tests pass
- [ ] Behavior identical for all filter combinations

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 004: CAS Versioning for State File Operations

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `writeStateFile_WithExpectedVersion_ThrowsOnMismatch`
   - File: `__tests__/workflow/state-store.test.ts`
   - Setup: Init state file (version starts at 1)
   - Modify state, write with `expectedVersion: 1` — should succeed
   - Read again, try to write with `expectedVersion: 1` again — should throw `VersionConflictError` (version is now 2)
   - Expected failure: `writeStateFile` doesn't accept `expectedVersion`, no `_version` field

   Write test: `writeStateFile_AutoIncrementsVersion`
   - Setup: Init state, read it
   - Assert `_version` === 1
   - Write updated state
   - Read again, assert `_version` === 2

   Write test: `writeStateFile_WithoutExpectedVersion_SucceedsAlways`
   - Backward compatibility: writes without expectedVersion always succeed

2. [GREEN] Implement CAS versioning
   - File: `src/workflow/state-store.ts`
   - Changes:
     - Add `_version: number` to state schema (default 1, auto-incremented)
     - `writeStateFile` accepts optional `expectedVersion` parameter
     - Before write: if `expectedVersion` provided, read current file, check `_version` matches
     - On mismatch: throw `VersionConflictError` (new error class extending `StateStoreError`)
     - On write: increment `_version` in the state object
   - File: `src/workflow/schemas.ts`
   - Changes:
     - Add `_version: z.number().int().positive().default(1)` to `WorkflowStateSchema`
   - File: `src/workflow/tools.ts`
   - Changes:
     - In `handleSet`: capture `_version` from read, pass as `expectedVersion` to write
     - Add retry logic: on VersionConflictError, re-read and re-apply (up to 3 retries)

3. [REFACTOR] Extract version conflict handling into a reusable `withOptimisticLock` wrapper

**Verification:**
- [ ] All existing workflow tests pass (backward compatible — existing state files default `_version: 1`)
- [ ] CAS prevents lost updates
- [ ] Retry logic handles transient conflicts

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 005: Fix Task Claim TOCTOU Race

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `handleTaskClaim_WithConcurrentClaims_SecondFails`
   - File: `__tests__/tasks/tools.test.ts`
   - Setup: Create event stream, append a task.assigned event
   - Simulate race: first claim succeeds, then immediately second claim for same task
   - Assert: Second claim returns `ALREADY_CLAIMED` error
   - Expected failure: Current code has TOCTOU — both could succeed in theory. But in single-threaded Node.js the race is unlikely. Test the fix path explicitly.

   Write test: `handleTaskClaim_UsesExpectedSequenceForAtomicity`
   - Setup: Create event stream with 5 existing events
   - Call handleTaskClaim
   - Assert: The appended event was written with the correct sequence (verifies the fix uses the claim-check sequence as expectedSequence)

2. [GREEN] Fix the TOCTOU in `handleTaskClaim`
   - File: `src/tasks/tools.ts`
   - Changes:
     - Query for existing claims AND capture the current max sequence
     - Use `expectedSequence` on the `append()` call
     - If `SequenceConflictError` is thrown, re-check and retry (up to 3 retries)
     - On retry: re-query for claims, if now claimed return `ALREADY_CLAIMED`

3. [REFACTOR] Extract retry-with-concurrency-check into a helper if pattern is reused

**Verification:**
- [ ] All existing task tests pass
- [ ] TOCTOU race condition eliminated
- [ ] Graceful retry on conflict

**Dependencies:** None (uses existing `expectedSequence` from EventStore)
**Parallelizable:** Yes

---

### Task 006: Idempotency Key for Event Store Append

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `append_WithIdempotencyKey_DeduplicatesRetry`
   - File: `__tests__/event-store/store.test.ts`
   - Setup: Append event with `idempotencyKey: 'claim-task-1'`
   - Append same event again with same `idempotencyKey: 'claim-task-1'`
   - Assert: Second call returns the SAME event (same sequence) without creating a duplicate
   - Expected failure: No `idempotencyKey` support exists

   Write test: `append_WithDifferentIdempotencyKeys_BothSucceed`
   - Setup: Append with key 'a', then with key 'b'
   - Assert: Both succeed with different sequences

   Write test: `append_WithoutIdempotencyKey_NoDeduplication`
   - Backward compatibility: existing behavior unchanged when no key provided

2. [GREEN] Implement idempotency key support
   - File: `src/event-store/store.ts`
   - Changes:
     - Add `idempotencyKey?: string` to `AppendOptions`
     - Add `private idempotencyCache: Map<string, Map<string, WorkflowEvent>>` (streamId → key → event)
     - In `append()`: if key provided, check cache first; if hit, return cached event
     - After successful append: store in cache
     - Bound cache per stream to last 100 keys (FIFO eviction)
     - Store key in event metadata: `data: { ...event.data, _idempotencyKey: key }`
   - File: `src/event-store/schemas.ts`
   - No schema changes needed (`data` is already `z.record(z.string(), z.unknown()).optional()`)

3. [REFACTOR] Extract idempotency cache into a small `IdempotencyCache` class if logic is complex

**Verification:**
- [ ] All existing event store tests pass
- [ ] Deduplication works within cache window
- [ ] Cache is bounded (no memory leaks)
- [ ] Backward compatible (no key = no dedup)

**Dependencies:** None
**Parallelizable:** Yes (different method than Task 003)

---

### Task 007: Idempotent Compensation with Checkpoint Resume

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `executeCompensation_WithCheckpoint_SkipsCompletedActions`
   - File: `__tests__/workflow/compensation.test.ts`
   - Setup: Create compensation context with 3 actions, checkpoint shows first action completed
   - Call `executeCompensation` with checkpoint
   - Assert: Only actions 2 and 3 are executed; action 1 is skipped
   - Expected failure: No checkpoint parameter exists

   Write test: `executeCompensation_ReturnsUpdatedCheckpoint`
   - Setup: Run compensation with no checkpoint (fresh)
   - Assert: Result includes `checkpoint` with all completed action IDs

   Write test: `executeCompensation_WithEmptyCheckpoint_ExecutesAll`
   - Backward compatibility: no checkpoint = execute all actions

2. [GREEN] Add checkpoint support to compensation
   - File: `src/workflow/compensation.ts`
   - Changes:
     - Add `CompensationCheckpoint` interface: `{ completedActions: string[] }`
     - Extend `CompensationOptions` with optional `checkpoint?: CompensationCheckpoint`
     - Extend `CompensationResult` with `checkpoint: CompensationCheckpoint`
     - In `executeCompensation`: skip actions whose `id` is in `checkpoint.completedActions`
     - After each successful/skipped action, add to checkpoint
     - Return updated checkpoint in result
   - File: `src/workflow/cancel.ts`
   - Changes:
     - Load checkpoint from state file before executing compensation
     - Save updated checkpoint to state file after compensation completes
     - On partial failure: checkpoint is saved with progress so far

3. [REFACTOR] Ensure checkpoint persistence is atomic (use writeStateFile)

**Verification:**
- [ ] All existing compensation tests pass
- [ ] Partial failure + retry resumes from checkpoint
- [ ] Checkpoint is persisted to state file

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 008: Dead-Letter Recovery in Outbox

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `replayDeadLetters_ResetsStatusAndAttempts`
   - File: `__tests__/sync/outbox.test.ts`
   - Setup: Create outbox with 3 entries: 1 pending, 1 confirmed, 1 dead-letter
   - Call `outbox.replayDeadLetters(streamId)`
   - Assert: Dead-letter entry status changed to 'pending', attempts reset to 0
   - Assert: Pending and confirmed entries unchanged
   - Expected failure: No `replayDeadLetters` method exists

   Write test: `replayDeadLetters_WithNoDeadLetters_ReturnsZero`
   - Setup: Outbox with only pending/confirmed entries
   - Assert: Returns 0 replayed

   Write test: `replayDeadLetters_ClearsErrorField`
   - Setup: Dead-letter entry with error message
   - After replay: error field cleared, nextRetryAt cleared

2. [GREEN] Implement dead-letter recovery
   - File: `src/sync/outbox.ts`
   - Changes:
     - Add `replayDeadLetters(streamId: string): Promise<number>` method
     - Load entries, find `status === 'dead-letter'`
     - Reset: `status = 'pending'`, `attempts = 0`, `error = undefined`, `nextRetryAt = undefined`
     - Save entries
     - Return count of replayed entries

3. [REFACTOR] Consider adding optional `filter` parameter (e.g., replay only entries older than X)

**Verification:**
- [ ] All existing outbox tests pass
- [ ] Dead-letter entries are re-queued correctly
- [ ] No data loss during replay

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

### Parallel Group A — Token Economy
- **Worktree 1:** Task 001 (views/tools.ts)
- **Worktree 2:** Task 002 (stack/tools.ts)

### Parallel Group B — I/O + Concurrency
- **Worktree 3:** Task 003 (event-store/store.ts — query optimization)
- **Worktree 4:** Task 004 (workflow/state-store.ts + workflow/tools.ts — CAS)
- **Worktree 5:** Task 005 (tasks/tools.ts — claim TOCTOU)
- **Worktree 6:** Task 006 (event-store/store.ts — idempotency key)

### Parallel Group C — Saga & Outbox
- **Worktree 7:** Task 007 (workflow/compensation.ts — checkpoint)
- **Worktree 8:** Task 008 (sync/outbox.ts — dead-letter recovery)

**All 8 tasks can run in parallel** — each modifies a different primary file with no cross-task dependencies.

> Note: Tasks 003 and 006 both modify `event-store/store.ts` but different methods (`query()` vs `append()`). They can be developed in parallel worktrees and merged sequentially.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Guard composition (AND/OR) | Guards work correctly as-is; composition is a feature, not a fix |
| View payload size bounds | LRU eviction at 100 entries is adequate for current scale |
| Sequence counter eviction | ~200KB at 10K workflows is negligible |
| Team coordinator worktree cleanup | External resource management; separate concern |
| Test coverage for guards.ts, hsm-definitions.ts, next-action.ts, query.ts, cancel.ts | Separate test coverage effort |
| Event store indexed reads / cursor-based pagination | Current optimization (line skip) is sufficient; indexing is over-engineering for current scale |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] CLAUDE.md updated with new capabilities
- [ ] docs/adrs/distributed-sdlc-pipeline.md updated with CAS and idempotency additions
- [ ] Ready for review
