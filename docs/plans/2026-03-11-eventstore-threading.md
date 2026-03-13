# Implementation Plan: EventStore Threading & Array Fix

## Source Design
Issues: #1001, #1003, #1011

## Scope
**Target:** Full — all three issues
**Excluded:**
- #1001 docs clarification (already fixed in registry.ts:341, just needs issue closure)
- SnapshotStore threading (separate concern, only used in cleanup.ts)
- `configureStateStoreBackend` (StorageBackend, not EventStore)
- `configureWorkflowMaterializer` (ViewMaterializer, not EventStore)

## Summary
- Total tasks: 5
- Parallel groups: 2 (tasks 3+4 run in parallel after task 2)
- Estimated test count: 12
- Design coverage: 2 of 2 issues covered (#1003 fix + #1011 refactor; #1001 already resolved)

## Spec Traceability

| Issue | Requirement | Task(s) |
|-------|-------------|---------|
| #1003 | `mergeArrays` replaces arrays instead of id-based upsert | Task 1 |
| #1003 | Stale tasks no longer block `all-tasks-complete` guard | Task 1 |
| #1011 | `CompositeHandler` accepts `DispatchContext` | Task 2 |
| #1011 | `dispatch()` passes full ctx to handlers | Task 2 |
| #1011 | Workflow handlers receive EventStore as parameter | Task 3 |
| #1011 | Event-store/views/quality handlers receive EventStore as parameter | Task 4 |
| #1011 | All `configureXxx` functions and module-globals removed | Task 5 |
| #1011 | Dual-wiring in `initializeContext` + `createServer` eliminated | Task 5 |

## Task Breakdown

### Task 1: Fix mergeArrays array replacement semantics (#1003)

**Phase:** RED -> GREEN -> REFACTOR
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

1. [RED] Write characterization test capturing current mergeArrays id-based upsert behavior
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Test: `mergeArrays_existingIdArrayWithDifferentIncomingIds_retainsOldEntries` (characterization — will be deleted after fix)
   - Expected: passes (documents current buggy behavior)

2. [RED] Write regression test for desired replacement behavior
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Test: `applyDotPath_tasksArrayWithNewIds_replacesEntireArray`
   - Test: `applyDotPath_tasksArrayReplacement_staleTasksRemoved`
   - Expected failure: old entries persist due to id-based upsert

3. [GREEN] Change `mergeArrays` in `state-store.ts` to return `incoming` directly (remove id-based upsert)
   - File: `servers/exarchos-mcp/src/workflow/state-store.ts` (lines 476-495)
   - The function currently does id-based upsert when both arrays have `id` fields. Change to always return `incoming`.

4. [REFACTOR] Remove dead `mergeArrays` function entirely — `applyDotPath` line 608-612 can just assign directly since arrays should always replace.

**Dependencies:** None
**Parallelizable:** Yes (independent of all other tasks)
**Branch:** `refactor/fix-merge-arrays-1003`

---

### Task 2: Change CompositeHandler signature to accept DispatchContext

**Phase:** RED -> GREEN -> REFACTOR
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

1. [RED] Write characterization tests verifying current dispatch behavior
   - File: `servers/exarchos-mcp/src/core/dispatch.test.ts`
   - Test: `dispatch_compositeHandler_receivesDispatchContext` — verify handler receives full ctx
   - Expected failure: handler currently receives `(args, stateDir)` not `(args, ctx)`

2. [GREEN] Change `CompositeHandler` type from `(args, stateDir: string) => Promise<ToolResult>` to `(args, ctx: DispatchContext) => Promise<ToolResult>`
   - File: `servers/exarchos-mcp/src/core/dispatch.ts` (line 16-19)
   - Update `dispatch()` line 133: change `builtInHandler(a, ctx.stateDir)` to `builtInHandler(a, ctx)`

3. [GREEN] Update all 5 composite handler signatures to accept `ctx: DispatchContext`
   - File: `servers/exarchos-mcp/src/workflow/composite.ts` — `handleWorkflow(args, ctx)`, internally use `ctx.stateDir` where `stateDir` was used
   - File: `servers/exarchos-mcp/src/event-store/composite.ts` — `handleEvent(args, ctx)`, use `ctx.stateDir`
   - File: `servers/exarchos-mcp/src/views/composite.ts` — `handleView(args, ctx)`, use `ctx.stateDir`
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts` — `handleOrchestrate(args, ctx)`, use `ctx.stateDir`
   - File: `servers/exarchos-mcp/src/sync/composite.ts` — `handleSync(args, ctx)`, use `ctx.stateDir`

4. [GREEN] Update composite handler tests to pass ctx instead of stateDir
   - Files: composite.test.ts files in workflow/, event-store/, views/, orchestrate/, sync/

5. [REFACTOR] Destructure `{ stateDir }` in each composite handler for readability

**Dependencies:** None
**Parallelizable:** Yes (independent of Task 1)
**Branch:** `refactor/composite-handler-signature`

---

### Task 3: Thread EventStore through workflow module handlers

**Phase:** RED -> GREEN -> REFACTOR
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

1. [RED] Write tests verifying handlers use ctx.eventStore
   - File: `servers/exarchos-mcp/src/workflow/tools.test.ts` (or appropriate test file)
   - Test: `handleSet_phaseTransition_usesInjectedEventStore` — verify handleSet uses eventStore from parameter, not module-global
   - Expected failure: handleSet still reads moduleEventStore

2. [GREEN] Add `eventStore` parameter to workflow sub-handlers
   - File: `servers/exarchos-mcp/src/workflow/tools.ts` — `handleInit`, `handleGet`, `handleSet`, `handleReconcileState` accept optional `eventStore?: EventStore` parameter, falling back to moduleEventStore during transition
   - File: `servers/exarchos-mcp/src/workflow/cancel.ts` — `handleCancel` accepts `eventStore?: EventStore`
   - File: `servers/exarchos-mcp/src/workflow/cleanup.ts` — `handleCleanup` accepts `eventStore?: EventStore`
   - File: `servers/exarchos-mcp/src/workflow/next-action.ts` — `handleNextAction` accepts `eventStore?: EventStore`
   - File: `servers/exarchos-mcp/src/workflow/query.ts` — `handleSummary`, `handleReconcile`, `handleTransitions` accept `eventStore?: EventStore`

3. [GREEN] Update `workflow/composite.ts` to pass `ctx.eventStore` to all sub-handlers
   - File: `servers/exarchos-mcp/src/workflow/composite.ts`

4. [GREEN] Remove `moduleEventStore` and `configureWorkflowEventStore` from `workflow/tools.ts`
   - Remove `configureCancelEventStore` from `cancel.ts`
   - Remove `configureCleanupEventStore` from `cleanup.ts`
   - Remove `configureNextActionEventStore` from `next-action.ts`
   - Remove `configureQueryEventStore` from `query.ts`

5. [GREEN] Update workflow test files to pass EventStore via parameter instead of configureXxx
   - Files: `workflow/event-injection.test.ts`, `workflow/next-action.test.ts`, `workflow/query.test.ts`, `workflow/reconcile-state.test.ts`, `workflow/tools.playbook.test.ts`

6. [REFACTOR] Make `eventStore` parameter required (not optional) since module-global fallback is removed

**Dependencies:** Task 2 (needs CompositeHandler signature change)
**Parallelizable:** Yes (parallel with Task 4, different files)
**Branch:** `refactor/thread-workflow-eventstore`

---

### Task 4: Thread EventStore through event-store, views, and quality modules

**Phase:** RED -> GREEN -> REFACTOR
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: true }`

1. [RED] Write tests verifying handlers use injected EventStore
   - File: `servers/exarchos-mcp/src/event-store/tools.test.ts`
   - Test: `handleEventAppend_usesInjectedEventStore` — verify append uses passed EventStore
   - File: `servers/exarchos-mcp/src/quality/hints.test.ts`
   - Test: `handleQualityHints_usesInjectedEventStore`
   - Expected failure: handlers still use lazy-init or module-global

2. [GREEN] Add `eventStore` parameter to event-store handlers
   - File: `servers/exarchos-mcp/src/event-store/tools.ts` — `handleEventAppend`, `handleEventQuery`, `handleBatchAppend` accept `eventStore: EventStore` (replaces `getStore(stateDir)` lazy-init)
   - Update `event-store/composite.ts` to pass `ctx.eventStore`

3. [GREEN] Add `eventStore` parameter to views handlers
   - File: `servers/exarchos-mcp/src/views/tools.ts` — all `handleView*` functions accept `eventStore: EventStore` parameter
   - Replace `getOrCreateEventStore(stateDir)` calls with the passed parameter
   - Update `views/composite.ts` to pass `ctx.eventStore`

4. [GREEN] Add `eventStore` parameter to quality handler
   - File: `servers/exarchos-mcp/src/quality/hints.ts` — accept `eventStore: EventStore`
   - Remove `moduleEventStore` and `configureQualityEventStore`

5. [GREEN] Remove module-global state from all three modules
   - `event-store/tools.ts`: remove `moduleEventStore`, `getStore()`, `resetModuleEventStore()`
   - `views/tools.ts`: remove `moduleEventStore`, update `getOrCreateEventStore` to not use module-global, remove `registerViewTools` module-global setter
   - `quality/hints.ts`: remove `moduleEventStore`, `configureQualityEventStore`

6. [GREEN] Update test files
   - File: `servers/exarchos-mcp/src/quality/hints.test.ts` — replace `configureQualityEventStore` with direct parameter passing
   - File: `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts` — update EventStore setup

7. [REFACTOR] Remove dead `registerViewTools` function if no longer needed (it was the views equivalent of configureXxx)

**Dependencies:** Task 2 (needs CompositeHandler signature change)
**Parallelizable:** Yes (parallel with Task 3, different files)
**Branch:** `refactor/thread-nonworkflow-eventstore`

---

### Task 5: Remove wiring from context.ts and index.ts, final cleanup

**Phase:** RED -> GREEN -> REFACTOR
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false, testLayer: "integration", characterizationRequired: false }`

1. [RED] Write test verifying `initializeContext` no longer calls any configureXxx functions
   - File: `servers/exarchos-mcp/src/core/context.test.ts`
   - Test: `initializeContext_noConfigureXxxCalls_eventStoreOnlyInContext` — verify no configureXxx imports exist
   - Expected failure: context.ts still imports and calls configureXxx

2. [GREEN] Remove all configureXxx imports and calls from `core/context.ts`
   - File: `servers/exarchos-mcp/src/core/context.ts` (lines 8-14, 47-54)
   - Remove: `configureWorkflowEventStore`, `configureNextActionEventStore`, `configureCancelEventStore`, `configureCleanupEventStore`, `configureQueryEventStore`, `configureQualityEventStore`
   - Keep: `configureCleanupSnapshotStore` (SnapshotStore is out of scope)
   - Keep: `configureStateStoreBackend` (StorageBackend is out of scope)

3. [GREEN] Remove all configureXxx imports and calls from `index.ts`
   - File: `servers/exarchos-mcp/src/index.ts` (lines ~163-169)

4. [GREEN] Verify no remaining references to removed functions
   - Run typecheck: `npm run typecheck`
   - Run tests: `npm run test:run`

5. [REFACTOR] Clean up any dead imports across the codebase

**Dependencies:** Task 3 AND Task 4 (all handlers must be threaded before removing wiring)
**Parallelizable:** No (must run after tasks 3 and 4 complete)
**Branch:** `refactor/remove-configure-wiring`

---

## Parallelization Strategy

```
Task 1 ─────────────────────────────────────────→ merge
                                                     ↓
Task 2 ──→ Task 3 ──→ Task 5 ──→ merge ──→ integration
           Task 4 ──↗
```

**Group A (independent):** Task 1 — can start immediately
**Group B (independent):** Task 2 — can start immediately, parallel with Task 1
**Group C (parallel, after Task 2):** Tasks 3 + 4 — different files, no merge conflicts
**Group D (sequential, after Group C):** Task 5 — final cleanup

## Deferred Items

| Item | Rationale |
|------|-----------|
| SnapshotStore threading | Only used in cleanup.ts; separate concern per brief |
| StorageBackend threading | Already uses simple module-global; different pattern |
| ViewMaterializer threading | Depends on EventStore threading; follow-up refactor |
| #1001 issue closure | Docs already fixed in registry.ts:341; close manually |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] `npm run typecheck` passes
- [ ] `npm run test:run` passes
- [ ] No `configureXxx` EventStore patterns remain (grep verification)
- [ ] No `moduleEventStore` module-globals remain for EventStore
- [ ] Ready for review
