# Implementation Plan: Optimize Exarchos MCP Server

## Source Design
Source: Refactor brief in `docs/workflow-state/refactor-optimize-mcp.state.json`
Audit prompt: `docs/prompts/optimize.md`

## Scope
**Target:** Full — all 8 goals from the refactor brief
**Excluded:** Multi-process file locking, idempotency keys, state file CAS, outbox/saga/HSM changes (all out of scope per brief)

## Summary
- Total tasks: 10
- Parallel groups: 5 (worktree-isolated chains)
- Estimated test count: ~30 new/modified tests
- Design coverage: 8 of 8 brief goals covered

## Spec Traceability

| Brief Goal | Key Requirements | Task ID(s) | Status |
|------------|-----------------|------------|--------|
| Fix CQRS violation in stack/tools.ts | Replace inline event aggregation with StackView projection | 004, 005 | Covered |
| Add pagination to handleViewPipeline and handleViewTasks | limit/offset params, slice after materialization | 001, 002 | Covered |
| Add field projection to handleViewTasks and handleEventQuery | fields param, pick only requested keys | 002, 010 | Covered |
| Add summary mode to handleTeamStatus | summary param returns counts only | 003 | Covered |
| Optimize EventStore.query() with sinceSequence | Streaming line read, early termination | 006 | Covered |
| Add LRU/TTL eviction to ViewMaterializer | Bounded cache with max entries | 007 | Covered |
| Add claim-guard to handleTaskClaim | Query prior task.claimed events before emitting | 008 | Covered |
| Emit team.shutdown events from coordinator | Emit events on shutdown/shutdownAll | 009 | Covered |

## Task Breakdown

---

### Task 001: Add pagination to handleViewPipeline

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `handleViewPipeline_WithLimit_ReturnsLimitedWorkflows`
   - File: `src/views/tools.test.ts`
   - Also: `handleViewPipeline_WithOffset_SkipsWorkflows`, `handleViewPipeline_WithLimitAndOffset_ReturnsSlice`
   - Expected failure: `limit` and `offset` params not accepted / no pagination applied
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add `limit` and `offset` parameters to `handleViewPipeline` and the Zod schema in `registerViewTools`
   - File: `src/views/tools.ts`
   - Changes: Update args type to `{ limit?: number; offset?: number }`, apply `slice()` after `workflows.push(view)` loop
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract common pagination helper if pattern repeats across view handlers
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 002: Add offset and fields projection to handleViewTasks

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleViewTasks_WithOffset_SkipsTasks`
   - `handleViewTasks_WithFields_ReturnsOnlyRequestedFields`
   - `handleViewTasks_WithFieldsAndFilter_AppliesBoth`
   - File: `src/views/tools.test.ts`
   - Expected failure: `offset` param not accepted, `fields` param not accepted
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add `offset` and `fields` parameters
   - File: `src/views/tools.ts`
   - Changes:
     - Add `offset?: number` and `fields?: string[]` to args type and Zod schema
     - After filter+limit, apply `slice(offset)` before limit
     - If `fields` provided, `map()` tasks to pick only requested keys
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract field projection into a shared helper in `format.ts` (reused by Task 010)
   - File: `src/format.ts`
   - Add: `pickFields<T>(obj: T, fields: string[]): Partial<T>`
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A, sequential with Task 001 — same file)

---

### Task 003: Add summary mode to handleTeamStatus

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleTeamStatus_WithSummaryTrue_ReturnsCountsOnly`
   - `handleTeamStatus_WithSummaryFalse_ReturnsFullTeammates`
   - `handleTeamStatus_Default_ReturnsFullTeammates`
   - File: `src/team/tools.test.ts` (create if not exists, else add to existing)
   - Expected failure: `summary` param not accepted
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add `summary` parameter to `handleTeamStatus` and Zod schema
   - File: `src/team/tools.ts`
   - Changes:
     - Update args type to `{ summary?: boolean }`
     - If `summary: true`, return `{ activeCount, staleCount }` only
     - Otherwise return full `TeamStatus`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 004: Create StackView projection

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `stackViewProjection_Init_ReturnsEmptyPositions`
   - `stackViewProjection_Apply_StackPositionFilled_AddsPosition`
   - `stackViewProjection_Apply_MultiplePositions_AccumulatesAll`
   - `stackViewProjection_Apply_UnrelatedEvent_ReturnsUnchanged`
   - File: `src/views/stack-view.test.ts` (new file)
   - Expected failure: Module does not exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `stack-view.ts` with `ViewProjection<StackViewState>` implementation
   - File: `src/views/stack-view.ts` (new file)
   - Changes:
     - Export `STACK_VIEW` constant (`'stack'`)
     - Export `StackViewState` interface: `{ positions: StackPosition[] }`
     - Export `stackViewProjection` implementing `ViewProjection<StackViewState>`
     - Handle `stack.position-filled` events in `apply()`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A, sequential before Task 005)

---

### Task 005: Rewire handleStackStatus to use StackView via materializer

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `handleStackStatus_UsesStackViewProjection`
   - File: `src/stack/tools.test.ts`
   - Assert: Same result as before but through materializer (verify materializer is called, not raw event query)
   - Expected failure: `handleStackStatus` still queries events directly
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Rewire `handleStackStatus` to use `ViewMaterializer`
   - File: `src/stack/tools.ts`
   - Changes:
     - Import `ViewMaterializer`, `StackViewState`, `stackViewProjection`, `STACK_VIEW`
     - Accept materializer as dependency (via module-level cache or parameter)
     - Replace inline `store.query()` + `events.map()` with `materializer.materialize<StackViewState>()`
     - Return `view.positions`
   - File: `src/views/tools.ts`
   - Changes: Register `stackViewProjection` in `createMaterializer()`
   - File: `src/index.ts`
   - Changes: Pass materializer or EventStore to `registerStackTools()` (if API changes needed)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove the now-unused `StackPosition` interface from `stack/tools.ts` (canonical definition is in `views/stack-view.ts`)
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 004
**Parallelizable:** No (depends on Task 004, modifies views/tools.ts — same chain as Tasks 001-002)

---

### Task 006: Optimize EventStore.query() with sinceSequence early termination

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `query_WithSinceSequence_SkipsEarlyLines` (verify only events after sinceSequence are returned)
   - `query_WithSinceSequence_LargeFile_DoesNotParseAllLines` (verify performance characteristic — mock `fs.readFile` to track that only tail of file is parsed, or use a line-by-line reader)
   - `query_WithoutFilters_ReadsAllLines` (existing behavior preserved)
   - File: `src/event-store/store.test.ts`
   - Expected failure: Current `query()` always reads and parses entire file
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement streaming line-by-line read with early skip for `sinceSequence`
   - File: `src/event-store/store.ts`
   - Changes:
     - Replace `fs.readFile()` + `split('\n')` with line-by-line reader (e.g., `readline` + `createReadStream` or manual chunk reader)
     - For `sinceSequence` filter: parse each line's sequence field, skip lines where `sequence <= sinceSequence`
     - For `type` filter: skip lines that don't match (parse minimally)
     - Apply limit/offset as events are collected, stopping early when limit is reached
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract streaming reader into a private method for readability
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

### Task 007: Add LRU eviction to ViewMaterializer cache

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `materialize_ExceedsMaxCacheSize_EvictsLeastRecentlyUsed`
   - `materialize_AfterEviction_ReinitializesFromProjection`
   - `materialize_WithinMaxCacheSize_KeepsAllEntries`
   - File: `src/views/materializer.test.ts`
   - Expected failure: No eviction, cache grows unbounded
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add LRU eviction with configurable `maxCacheEntries`
   - File: `src/views/materializer.ts`
   - Changes:
     - Add `maxCacheEntries?: number` to `MaterializerOptions` (default: 100)
     - Track access order in `states` Map (use Map insertion order: delete + re-insert on access to move to end)
     - After `states.set()` in `materialize()`, if `states.size > maxCacheEntries`, delete the oldest entry (first key in Map iteration)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group D)

---

### Task 008: Add claim guard to handleTaskClaim

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleTaskClaim_AlreadyClaimed_RejectsWithError`
   - `handleTaskClaim_NotClaimed_EmitsEvent`
   - `handleTaskClaim_DifferentTaskId_AllowsClaim`
   - File: `src/tasks/tools.test.ts` (create if not exists, else add to existing)
   - Expected failure: Claim always succeeds regardless of prior claims
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add claim guard
   - File: `src/tasks/tools.ts`
   - Changes:
     - Before `store.append()`, call `store.query(args.streamId, { type: 'task.claimed' })`
     - Filter results for `data.taskId === args.taskId`
     - If match found, return `{ success: false, error: { code: 'ALREADY_CLAIMED', message: ... } }`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group E)

---

### Task 009: Emit shutdown events from TeamCoordinator

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `shutdown_EmitsTeamShutdownEvent`
   - `shutdownAll_EmitsTeamShutdownEventForEachMember`
   - `shutdown_NonExistentMember_ThrowsWithoutEvent`
   - File: `src/team/coordinator.test.ts`
   - Expected failure: No events emitted on shutdown
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Emit events on shutdown
   - File: `src/team/coordinator.ts`
   - Changes:
     - In `shutdown()`: Before deleting from Map, emit `agent.message` event with `{ from: 'system', to: name, content: 'shutdown', messageType: 'shutdown' }` — or define a new event type. Since the event schema already has `agent.message`, use that with messageType `'shutdown'`.
     - Actually, a better approach: use the `streamId` parameter that's already accepted but unused. Emit a descriptive event before removing from Map.
     - In `shutdownAll()`: Iterate teammates and emit for each before clearing
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group B, same worktree as Task 003)

---

### Task 010: Add fields projection to handleEventQuery

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `handleEventQuery_WithFields_ReturnsOnlyRequestedFields`
   - `handleEventQuery_WithFieldsTypeTimestamp_ReturnsMinimalEvents`
   - `handleEventQuery_WithoutFields_ReturnsFullEvents`
   - File: `src/event-store/tools.test.ts` (add to existing store.test.ts if that's where event tool tests live)
   - Expected failure: `fields` param not accepted
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add `fields` parameter to `handleEventQuery` and Zod schema
   - File: `src/event-store/tools.ts`
   - Changes:
     - Add `fields?: string[]` to args and Zod schema: `fields: z.array(z.string()).optional()`
     - After query, if `fields` provided, map events to pick only requested keys using `pickFields()` from `format.ts` (created in Task 002 refactor step)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 002 (for shared `pickFields` helper in format.ts; can proceed independently if helper is implemented inline first)
**Parallelizable:** Yes (Group C, same worktree as Task 006)

---

## Parallelization Strategy

### Sequential Chains

**Chain A (Views + Stack CQRS):** Task 001 → Task 002 → Task 004 → Task 005
- All modify `views/tools.ts` or depend on new view file

**Chain B (Team Module):** Task 003 + Task 009 (independent files, one worktree)

**Chain C (Event Store):** Task 006 + Task 010 (independent files, one worktree)

**Chain D (Materializer):** Task 007 (standalone)

**Chain E (Tasks):** Task 008 (standalone)

### Parallel Groups

```
Group A (worktree-1): Chain A — Tasks 001, 002, 004, 005
Group B (worktree-2): Chain B — Tasks 003, 009
Group C (worktree-3): Chain C — Tasks 006, 010
Group D (worktree-4): Chain D — Task 007
Group E (worktree-5): Chain E — Task 008
```

All 5 groups can execute in parallel. Within each group, tasks run sequentially.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Multi-process file locking | Single-process assumption is valid and enforced by MCP stdio protocol |
| Idempotency key for event append | At-least-once semantics are acceptable; callers can use `expectedSequence` |
| State file compare-and-swap | Same single-process rationale |
| Event schema string length limits | Low severity, deferred to future hardening |
| Snapshot-based query shortcut | Optimization beyond streaming read; snapshots are already used by materializer |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `npm run test:run` green for all modules
- [ ] `npm run typecheck` passes
- [ ] Code coverage maintained or improved
- [ ] CLAUDE.md updated to reflect changes
- [ ] Ready for review
