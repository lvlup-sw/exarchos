# Implementation Plan: Optimization Sweep

## Source Design
Brief: `docs/workflow-state/refactor-optimization-sweep.state.json` (`.brief`)

## Scope
**Target:** Full brief — Token optimization, Event-sourcing rigor, Performance, Installation hardening ADR
**Excluded:** Installation code changes (documented only), schema migration tooling, distributed event store

## Summary
- Total tasks: 11
- Parallel groups: 3 (A, B, and C all run in parallel)
- Estimated test count: ~35 new/modified tests
- Brief coverage: 8 of 8 goals covered

## Spec Traceability

### Traceability Matrix

| Brief Goal | Task ID(s) | Status |
|------------|-----------|--------|
| Strip _events and internal fields from responses | A2 | Covered |
| Deduplicate ToolResult interface | A1 | Covered |
| Emit workflow transitions to external event store | B3, B4 | Covered |
| Event-first mutation ordering | B5 | Covered |
| Persist sequence counters in .seq file | B1 | Covered |
| Cache ViewMaterializer per server lifecycle | B2 | Covered |
| Fast-path for simple queries (skip Zod) | A3 | Covered |
| Installation hardening ADR | C1 | Covered |

## Task Breakdown

---

### Group A: Token Optimization

**Worktree:** `refactor-token-optimization`
**Files touched:** `format.ts`, `workflow/tools.ts`, `workflow/query.ts`, `workflow/next-action.ts`, `workflow/cancel.ts`, `event-store/tools.ts`, `team/tools.ts`, `tasks/tools.ts`, `views/tools.ts`, `workflow/types.ts`
**Parallel with:** Group B

---

### Task A1: Deduplicate ToolResult Interface

**Phase:** RED → GREEN → REFACTOR

**Context:**
ToolResult is defined 9 times: once in `format.ts` (canonical) and 8 local redeclarations. The workflow modules extend it with `_meta?: CheckpointMeta` while other modules use simplified versions. All 8 duplicates import `formatResult` from `format.ts` but redeclare the interface locally. Only `stack/tools.ts` properly imports from `format.ts`.

**Duplication locations:**
- `format.ts:3` — canonical, `_meta?: unknown`
- `workflow/tools.ts:39` — `_meta?: CheckpointMeta`
- `workflow/query.ts:25` — `_meta?: CheckpointMeta`
- `workflow/next-action.ts:21` — `_meta?: CheckpointMeta`
- `workflow/cancel.ts:26` — `_meta?: CheckpointMeta`
- `event-store/tools.ts:9` — simplified
- `team/tools.ts:12` — simplified
- `tasks/tools.ts:10` — simplified
- `views/tools.ts:32` — simplified

**TDD Steps:**

1. [RED] Write test: `ToolResult_ImportedFromFormat_TypeCompatible`
   - File: `src/__tests__/workflow/tools.test.ts` (add to existing)
   - Test that a ToolResult with CheckpointMeta _meta field satisfies the format.ts ToolResult type
   - Expected failure: Type test may fail if format.ts ToolResult _meta is `unknown` (which is compatible — test structure)

2. [GREEN] Update `format.ts` to export ToolResult (already exported). Keep `_meta?: unknown` since `CheckpointMeta` is assignable to `unknown`.
   - Remove local `interface ToolResult` from all 8 files
   - Add `import { type ToolResult } from '../format.js'` to each (alongside existing `formatResult` import)
   - Files to update:
     - `workflow/tools.ts:39-44` — remove interface, add import
     - `workflow/query.ts:25-30` — remove interface, add import
     - `workflow/next-action.ts:21-26` — remove interface, add import
     - `workflow/cancel.ts:26-31` — remove interface, add import
     - `event-store/tools.ts:9-13` — remove interface, add import
     - `team/tools.ts:12-16` — remove interface, add import
     - `tasks/tools.ts:10-14` — remove interface, add import
     - `views/tools.ts:32-36` — remove interface, add import

3. [REFACTOR] Verify all existing tests still pass. No behavior change.
   - Run: `npm run test:run` in `plugins/exarchos/servers/exarchos-mcp/`

**Verification:**
- [ ] Zero `interface ToolResult` definitions outside `format.ts`
- [ ] All tests pass
- [ ] `npm run typecheck` passes

**Dependencies:** None
**Parallelizable:** Yes (within Group A, do first)

---

### Task A2: Strip Internal Fields from Workflow Responses

**Phase:** RED → GREEN → REFACTOR

**Context:**
`handleGet()` at `workflow/tools.ts:125-130` returns the full WorkflowState including `_events` (array of up to 100 events), `_eventSequence`, and `_history`. These internal fields waste 2,000-2,500 tokens per call and are never needed by clients.

**TDD Steps:**

1. [RED] Write tests:
   - `handleGet_NoQuery_ExcludesInternalFields` — verify `_events`, `_eventSequence`, `_history` absent from response data
   - `handleGet_NoQuery_IncludesMetaEventSummary` — verify `_meta.eventCount` and `_meta.recentEvents` present
   - `handleGet_QueryInternalField_StillWorks` — verify `query: "_events"` still returns events (explicit access)
   - `handleSet_Response_ExcludesInternalFields` — verify set response also strips internals
   - File: `src/__tests__/workflow/tools.test.ts`
   - Expected failure: responses currently include all fields

2. [GREEN] Implement field stripping:
   - Create helper `stripInternalFields(state: WorkflowState): Record<string, unknown>` in `workflow/tools.ts`
     - Remove `_events`, `_eventSequence`, `_history` from cloned state
     - Return cleaned object
   - Create helper `buildEventSummary(state: WorkflowState): { eventCount: number; recentEvents: Array<{ type: string; timestamp: string }> }`
     - Use `getRecentEvents(state._events, 3)` for last 3 events
     - Return compact summary
   - Update `handleGet()` (~line 128): when no query, strip fields and add event summary to `_meta`
   - Update `handleGet()`: when query targets internal field directly, allow it (escape hatch)
   - Update `handleSet()` (~line 262): strip fields from response data

3. [REFACTOR] Extract stripping logic to a shared utility if used in handleSummary too.

**Verification:**
- [ ] `workflow_get` without query returns no `_events`, `_eventSequence`, `_history`
- [ ] `_meta.eventCount` and `_meta.recentEvents` present in response
- [ ] Explicit `query: "_events"` still works
- [ ] All existing tests pass (update assertions that check full state)

**Dependencies:** A1 (ToolResult cleanup)
**Parallelizable:** No (sequential after A1 within Group A)

---

### Task A3: Fast-Path Query Routing for Simple Lookups

**Phase:** RED → GREEN → REFACTOR

**Context:**
`handleGet()` reads the full state file, validates against the full Zod `WorkflowStateSchema` discriminated union, then extracts a single field. For simple queries like `phase` or `featureId`, this is wasteful. A fast path can JSON.parse and return the field directly.

**TDD Steps:**

1. [RED] Write tests:
   - `handleGet_SimpleQuery_Phase_SkipsFullValidation` — verify `query: "phase"` returns correct value
   - `handleGet_SimpleQuery_FeatureId_SkipsFullValidation` — verify `query: "featureId"` returns correct value
   - `handleGet_ComplexQuery_FallsBackToFullValidation` — verify `query: "tasks[0].status"` still works
   - File: `src/__tests__/workflow/tools.test.ts`
   - Expected failure: Tests should pass (behavior unchanged), but add timing/spy to verify Zod not called

2. [GREEN] Add fast-path to `handleGet()`:
   - Define `FAST_PATH_FIELDS = new Set(['phase', 'featureId', 'workflowType', 'track', 'version'])` — top-level scalars
   - Before Zod validation, check if `query` is in `FAST_PATH_FIELDS`
   - If yes: read file, `JSON.parse()`, return `parsed[query]` directly
   - If no: proceed with full Zod validation path
   - File: `workflow/tools.ts` in `handleGet()` around line 108

3. [REFACTOR] Consider extracting fast-path into `state-store.ts` as `readFieldFast(stateFile, field)`.

**Verification:**
- [ ] Simple queries return correct values
- [ ] Complex queries still work
- [ ] All existing tests pass
- [ ] `npm run typecheck` passes

**Dependencies:** A1
**Parallelizable:** No (sequential after A2 within Group A, but could merge with A2 commit)

---

### Group B: Event Architecture + Performance

**Worktree:** `refactor-event-architecture`
**Files touched:** `event-store/store.ts`, `event-store/schemas.ts`, `views/materializer.ts`, `views/tools.ts`, `workflow/tools.ts`, `workflow/events.ts`, `workflow/schemas.ts`, `workflow/query.ts`, `workflow/next-action.ts`, `workflow/cancel.ts`, `workflow/circuit-breaker.ts`
**Parallel with:** Group A (first 2 tasks B1-B2 can run parallel with A; B3-B5 are sequential within B)

---

### Task B1: Persist EventStore Sequence Counters

**Phase:** RED → GREEN → REFACTOR

**Context:**
`EventStore` at `event-store/store.ts:50` stores sequence counters in an in-memory `Map<string, number>` that resets on server restart. On first access, `initializeSequence()` (lines 164-173) reads the entire JSONL file and counts lines — O(n). For streams with 1000+ events, this is expensive.

**TDD Steps:**

1. [RED] Write tests:
   - `EventStore_Append_WritesSeqFile` — after append, verify `.seq` file exists alongside `.events.jsonl`
   - `EventStore_NewInstance_ReadsSeqFile` — create store, append events, create NEW store instance, verify sequence continues correctly without reading JSONL
   - `EventStore_SeqFileMissing_FallsBackToLineCount` — delete .seq file, verify fallback works
   - `EventStore_SeqFileCorrupt_FallsBackToLineCount` — write garbage to .seq, verify fallback
   - File: `src/__tests__/event-store/store.test.ts`
   - Expected failure: No .seq file written currently

2. [GREEN] Implement sequence persistence:
   - After each append in `store.ts`, write `{ "sequence": N }` to `${streamId}.seq` alongside JSONL file
   - In `initializeSequence()`, try reading `.seq` file first
   - If `.seq` exists and parses: use its sequence value
   - If `.seq` missing or corrupt: fall back to line counting (existing behavior)
   - Write `.seq` atomically: write to `.seq.tmp`, then rename

3. [REFACTOR] Extract `.seq` file path helper. Consider batching `.seq` writes for high-frequency appends.

**Verification:**
- [ ] `.seq` file created alongside `.events.jsonl`
- [ ] New EventStore instance reads from `.seq` (no line counting)
- [ ] Fallback to line counting works when `.seq` missing/corrupt
- [ ] All existing event-store tests pass

**Dependencies:** None
**Parallelizable:** Yes (independent of all other tasks)

---

### Task B2: Singleton ViewMaterializer with Cache

**Phase:** RED → GREEN → REFACTOR

**Context:**
`views/tools.ts` creates a new `ViewMaterializer` instance on every query (lines 65-92). Each creation registers 4 projections from scratch and replays all events. A cached singleton would reuse the materializer across queries, only processing new events via the high-water mark.

**TDD Steps:**

1. [RED] Write tests:
   - `ViewMaterializer_Singleton_ReusedAcrossQueries` — call view tool twice, verify same materializer instance used
   - `ViewMaterializer_Singleton_ProcessesOnlyNewEvents` — append events between queries, verify only new events processed
   - `ViewMaterializer_Singleton_InvalidatesOnReset` — call reset function, verify new instance created
   - File: `src/__tests__/views/tools.test.ts`
   - Expected failure: New instance created each time

2. [GREEN] Implement singleton cache:
   - Add module-level `let cachedMaterializer: ViewMaterializer | null = null` in `views/tools.ts`
   - Add `function getOrCreateMaterializer(stateDir: string): ViewMaterializer`
     - If cached and same stateDir: return cached
     - Otherwise: create new, register projections, cache, return
   - Update all 4 view handlers to use `getOrCreateMaterializer()` instead of `createMaterializer()`
   - The high-water mark pattern in `ViewMaterializer.materialize()` already handles incremental processing
   - Add `resetMaterializer()` export for testing

3. [REFACTOR] Consider adding a snapshot trigger after N new events processed.

**Verification:**
- [ ] Same materializer reused across queries
- [ ] High-water mark ensures only new events processed
- [ ] All existing view tests pass
- [ ] No stale data returned

**Dependencies:** None
**Parallelizable:** Yes (independent of all other tasks)

---

### Task B3: Extend External Event Schema for Workflow Transitions

**Phase:** RED → GREEN → REFACTOR

**Context:**
The external event store (`event-store/schemas.ts`) has 19 event types for domain events. Workflow internal events (transition, fix-cycle, guard-failed, checkpoint) are only in the embedded `_events` array. To unify event storage, we need to add workflow transition event types to the external schema.

**TDD Steps:**

1. [RED] Write tests:
   - `EventSchema_WorkflowTransition_ValidatesCorrectly` — verify new `workflow.transition` event type parses
   - `EventSchema_WorkflowFixCycle_ValidatesCorrectly` — verify `workflow.fix-cycle` event type parses
   - `EventSchema_WorkflowGuardFailed_ValidatesCorrectly` — verify `workflow.guard-failed` event type parses
   - `EventStore_Append_WorkflowTransition_Succeeds` — append a workflow.transition event to store
   - File: `src/__tests__/event-store/schemas.test.ts` and `src/__tests__/event-store/store.test.ts`
   - Expected failure: Unknown event types rejected by schema

2. [GREEN] Extend `event-store/schemas.ts`:
   - Add to event type enum: `workflow.transition`, `workflow.fix-cycle`, `workflow.guard-failed`, `workflow.checkpoint`
   - Add data schemas for each:
     - `workflow.transition`: `{ from: string, to: string, trigger: string, featureId: string }`
     - `workflow.fix-cycle`: `{ compound: string, count: number, featureId: string }`
     - `workflow.guard-failed`: `{ guard: string, from: string, to: string, featureId: string }`
     - `workflow.checkpoint`: `{ counter: number, featureId: string }`
   - Add these to the `WorkflowEventSchema` discriminated union

3. [REFACTOR] Ensure naming follows existing `domain.action` convention.

**Verification:**
- [ ] New event types parse correctly
- [ ] Existing event types unaffected
- [ ] All existing schema tests pass

**Dependencies:** None
**Parallelizable:** Yes (can run parallel with B1, B2)

---

### Task B4: Bridge Workflow Transitions to External Event Store

**Phase:** RED → GREEN → REFACTOR

**Context:**
Currently, `handleSet()` in `workflow/tools.ts` calls `appendEvent()` from `events.ts` which mutates the in-memory `_events` array. Instead, transitions should be emitted to the external JSONL event store. This requires threading an `EventStore` instance into the workflow tools.

Also migrate the consumers: `getFixCycleCount()`, `getRecentEvents()`, `getPhaseDuration()` in `events.ts`, and `getCircuitBreakerState()` in `circuit-breaker.ts`.

**TDD Steps:**

1. [RED] Write tests:
   - `handleSet_PhaseTransition_AppendsToExternalStore` — after a phase transition, verify event appears in JSONL file
   - `handleSet_PhaseTransition_DoesNotModifyStateEvents` — verify `_events` array is NOT modified
   - `getFixCycleCount_QueriesExternalStore` — verify fix-cycle count comes from JSONL events
   - `getRecentEvents_QueriesExternalStore` — verify recent events come from JSONL
   - `getCircuitBreakerState_UsesExternalStore` — verify circuit breaker reads from external store
   - File: `src/__tests__/workflow/tools.test.ts`, `src/__tests__/workflow/events.test.ts`, `src/__tests__/workflow/circuit-breaker.test.ts`
   - Expected failure: Events still written to `_events` array

2. [GREEN] Implement bridging:
   - **Dependency injection:** Update `registerWorkflowTools(server, stateDir)` → `registerWorkflowTools(server, stateDir, eventStore: EventStore)` in `workflow/tools.ts`
   - Update `index.ts` to create EventStore and pass to `registerWorkflowTools()`
   - In `handleSet()`: after computing `TransitionResult`, call `eventStore.append(featureId, { type: 'workflow.transition', data: { from, to, trigger } })` INSTEAD of `appendEvent()`
   - For fix-cycle events: call `eventStore.append(featureId, { type: 'workflow.fix-cycle', ... })`
   - **Migrate events.ts functions** to accept `EventStore` parameter:
     - `getFixCycleCount(eventStore, streamId, compound)` — query with `{ type: 'workflow.fix-cycle' }` filter
     - `getRecentEvents(eventStore, streamId, count)` — query all, take last N
     - `getPhaseDuration(eventStore, streamId)` — query `workflow.transition` events
   - **Update circuit-breaker.ts** to pass EventStore to `getFixCycleCount()`
   - **Update query.ts** `handleSummary()` to use new `getRecentEvents()` signature
   - **Update next-action.ts** `handleNextAction()` to pass EventStore for circuit breaker checks
   - **Update cancel.ts** `handleCancel()` if it uses appendEvent

3. [REFACTOR] Remove unused `appendEvent()` function signature that takes `_events` array. Keep function if needed for backward compat, but mark deprecated.

**Verification:**
- [ ] Phase transitions appear in JSONL event file
- [ ] `_events` array NOT modified during transitions
- [ ] Fix-cycle counting works from external store
- [ ] Circuit breaker reads from external store
- [ ] All existing workflow tests pass (update test setups to provide EventStore)

**Dependencies:** B3 (needs new event types in schema)
**Parallelizable:** No (sequential after B3)

---

### Task B5: Remove _events from WorkflowState Schema + Event-First Ordering

**Phase:** RED → GREEN → REFACTOR

**Context:**
After B4 bridges all events to the external store, the embedded `_events` and `_eventSequence` fields in `WorkflowState` are no longer needed. Remove them from the schema and implement event-first mutation ordering.

**TDD Steps:**

1. [RED] Write tests:
   - `WorkflowStateSchema_NoEventsField` — verify schema does not include `_events` or `_eventSequence`
   - `handleSet_EventAppendedBeforeStateMutation` — use spy/mock to verify event store append is called BEFORE state file write
   - `handleSet_StateWriteFails_EventStillRecorded` — simulate state write failure, verify event was already appended
   - File: `src/__tests__/workflow/schemas.test.ts`, `src/__tests__/workflow/tools.test.ts`
   - Expected failure: Schema still includes `_events`

2. [GREEN] Remove _events from schema and reorder mutations:
   - In `workflow/schemas.ts`: Remove `_events` and `_eventSequence` from `BaseWorkflowStateSchema`
   - Remove `EventSchema`, `EventTypeSchema` if no longer used (check all consumers first)
   - In `workflow/tools.ts` `handleSet()`: reorder to:
     1. Compute transition result
     2. `await eventStore.append(...)` — event recorded first
     3. Mutate state (`mutableState.phase = result.newPhase`)
     4. Write state file
   - Remove `EVENT_LOG_MAX` constant from `events.ts`
   - Remove or update `appendEvent()` in `events.ts` — may be fully removable if all callers migrated in B4
   - Update migration logic in `state-store.ts` if it references `_events`

3. [REFACTOR] Clean up any dead code paths that referenced `_events`. Update JSDoc comments.

**Verification:**
- [ ] `_events` and `_eventSequence` absent from WorkflowState type
- [ ] Event append happens before state write (verified by test ordering)
- [ ] Existing state files without `_events` load correctly (migration)
- [ ] All tests pass (many test setups will need `_events` removed from fixtures)

**Dependencies:** B4 (all consumers migrated to external store)
**Parallelizable:** No (sequential after B4)

---

### Group C: Documentation

**Worktree:** None (orchestrator writes docs directly)
**Parallel with:** Groups A and B

---

### Task C1: Write Installation Hardening ADR + Update CLAUDE.md

**Phase:** Write documentation

**Content for ADR (`docs/adrs/installation-hardening-plan.md`):**

Document these findings from exploration:

1. **Atomic JSON writes** — `configureMcpServers()` should write to temp file then rename
2. **Rollback on partial failure** — Track created symlinks, undo on MCP build failure
3. **Source validation** — Verify source paths exist before symlinking
4. **Graphite availability check** — Warn if `gt` not in PATH
5. **Backup consolidation** — Keep only 2 most recent backups, clean older
6. **Cross-platform symlink fallback** — Detect Windows, use junction or warn
7. **Install lock file** — Prevent concurrent installations
8. **Multi-clone support** — Allow multiple exarchos installations with unique names

Each item should include: problem, proposed solution, effort estimate, priority.

**CLAUDE.md updates:**
- Update "Key modules" section to reflect unified event architecture (events go to external JSONL, not embedded `_events`)
- Note ViewMaterializer caching pattern
- Note ToolResult canonical location in `format.ts`

**Dependencies:** None (can start immediately)
**Parallelizable:** Yes (fully independent)

---

## Parallelization Strategy

### Parallel Groups

```text
Group A (Token)                Group B (Event + Perf)           Group C (Docs)
┌─────────────────┐           ┌─────────────────────┐          ┌──────────┐
│ A1: ToolResult   │           │ B1: Persist .seq     │          │ C1: ADR  │
│ A2: Strip fields │           │ B2: Cache Materializer│         │ + CLAUDE │
│ A3: Fast-path    │           │ B3: Extend schema    │          └──────────┘
└─────────────────┘           │ B4: Bridge events    │
                               │ B5: Remove _events   │
                               └─────────────────────┘
```

**Execution order:**
- **Wave 1 (parallel):** A1+A2+A3 | B1+B2+B3 | C1
  - Group A: sequential within (A1 → A2 → A3)
  - Group B first 3: B1 and B2 independent, B3 independent
  - Group C: independent
- **Wave 2 (sequential in B):** B4 (depends on B3)
- **Wave 3 (sequential in B):** B5 (depends on B4)

### Worktree Assignment

| Worktree | Tasks | Branch |
|----------|-------|--------|
| `refactor-token-optimization` | A1, A2, A3 | `refactor/token-optimization` |
| `refactor-event-architecture` | B1, B2, B3, B4, B5 | `refactor/event-architecture` |
| (orchestrator) | C1 | `main` or commit to feature branch |

### Merge Strategy

Group A and Group B both modify `workflow/tools.ts`. Merge order matters:
1. Merge Group A first (token optimization — lower risk, less invasive)
2. Merge Group B second (event architecture — resolves conflicts against A's changes)
3. Group C is docs-only, merge anytime

## Deferred Items

| Item | Rationale |
|------|-----------|
| Event compression / archival | Out of scope — not needed until event volumes are high |
| Distributed event store | Out of scope — single-machine is sufficient |
| Schema migration tooling | Out of scope — existing state files can drop `_events` gracefully |
| Rules file token optimization | Out of scope — separate refactor for markdown content |
| Indexed event queries | Deferred — singleton materializer with high-water marks addresses most perf concerns |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `npm run typecheck` passes in MCP server
- [ ] `npm run test:run` passes in MCP server
- [ ] Zero `interface ToolResult` outside format.ts
- [ ] `workflow_get` responses exclude internal fields
- [ ] Events emitted to external JSONL store
- [ ] `.seq` files created alongside `.events.jsonl`
- [ ] ViewMaterializer cached per server lifecycle
- [ ] Installation hardening ADR written
- [ ] CLAUDE.md updated
- [ ] Ready for review
