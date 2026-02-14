# Implementation Plan: Architectural Rigor Refactor

## Source Design
Brief: `docs/workflow-state/refactor-arch-rigor.state.json`
ADR: `docs/adrs/distributed-sdlc-pipeline.md`

## Scope
**Target:** Code decomposition (3 monolithic files) + ADR reconciliation + test gap closure
**Excluded:** Remote sync implementation, Task Router, agent team integration, performance optimization, new event types

## Summary
- Total tasks: 9
- Parallel groups: 2 (Group A: tasks 1-2, Group B: tasks 3-5, Independent: task 7)
- Estimated test count: ~15 new tests (snapshot-store)
- Design coverage: All 7 brief goals covered

## Spec Traceability

### Traceability Matrix

| Brief Goal | Key Requirements | Task ID(s) | Status |
|------------|-----------------|------------|--------|
| Decompose state-machine.ts | Extract guards, extract per-workflow HSMs | 1, 2 | Covered |
| Decompose workflow/tools.ts | Extract next-action, cancel, query handlers | 3, 4, 5 | Covered |
| Refactor index.ts with registry pattern | Per-module registration functions | 6 | Covered |
| Reconcile event schemas in ADR | Mark implemented vs. deferred in ADR | 8 | Covered |
| Add snapshot-store tests | Dedicated test file with full coverage | 7 | Covered |
| Update ADR to reflect unified server | Tool names, module structure, event taxonomy | 8 | Covered |
| Update CLAUDE.md | Architecture section, module descriptions | 9 | Covered |

## Task Breakdown

---

### Task 1: Extract guards from state-machine.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Run existing test suite to establish baseline
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/__tests__/state-machine.test.ts`
   - Run: `cd plugins/exarchos/servers/exarchos-mcp && npm run test:run` — MUST PASS (baseline)

2. [GREEN] Extract guards to new file
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/workflow/guards.ts`
   - Move: `guards` object, `hasArtifact()`, `collectReviewStatuses()`, `PASSED_STATUSES`, `FAILED_STATUSES`, `Guard`, `GuardResult` types
   - Update: `state-machine.ts` to import guards from `./guards.js`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify no file exceeds 500 lines
   - `guards.ts` should be ~330 lines
   - `state-machine.ts` should be ~680 lines (still needs Task 2)
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] All 14+ state-machine test scenarios pass
- [ ] All integration tests pass
- [ ] `guards.ts` exports all guard definitions
- [ ] `state-machine.ts` imports guards cleanly

**Dependencies:** None
**Parallelizable:** Yes (with Tasks 3-5, 7)

---

### Task 2: Extract HSM definitions from state-machine.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Verify existing tests still pass after Task 1
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/__tests__/state-machine.test.ts`
   - Run: `npm run test:run` — MUST PASS (baseline after Task 1)

2. [GREEN] Extract HSM definitions to new file
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/workflow/hsm-definitions.ts`
   - Move: `createFeatureHSM()`, `createDebugHSM()`, `createRefactorHSM()`
   - Import guards from `./guards.js` in new file
   - Update: `state-machine.ts` to import HSM creators and build `hsmRegistry`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify target line counts
   - `hsm-definitions.ts` should be ~275 lines
   - `state-machine.ts` should be ~400 lines (types + transition algorithm + registry)
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] All state-machine tests pass
- [ ] `getHSMDefinition()` still returns correct HSMs for all 3 workflow types
- [ ] `state-machine.ts` is under 500 lines

**Dependencies:** Task 1
**Parallelizable:** No (sequential with Task 1)

---

### Task 3: Extract handleNextAction from workflow/tools.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Verify existing tests pass as baseline
   - Files: `plugins/exarchos/servers/exarchos-mcp/src/workflow/__tests__/tools.test.ts`, `integration.test.ts`
   - Run: `npm run test:run` — MUST PASS

2. [GREEN] Extract next-action logic to new file
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/workflow/next-action.ts`
   - Move: `handleNextAction()`, `HUMAN_CHECKPOINT_PHASES`, `PHASE_ACTION_MAP`, `findCompoundForPhase()`
   - Update: `workflow/tools.ts` to remove moved code
   - Update: `index.ts` to import `handleNextAction` from `./workflow/next-action.js`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Clean up imports
   - Ensure no unused imports remain in tools.ts
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] All workflow tools tests pass
- [ ] Integration tests pass (handleNextAction used heavily)
- [ ] `next-action.ts` is ~215 lines

**Dependencies:** None
**Parallelizable:** Yes (with Tasks 1-2, 7) — but sequential with Tasks 4-5 (shared tools.ts)

---

### Task 4: Extract handleCancel from workflow/tools.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Verify tests pass after Task 3
   - Run: `npm run test:run` — MUST PASS

2. [GREEN] Extract cancel handler to new file
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/workflow/cancel.ts`
   - Move: `handleCancel()`
   - Update: `workflow/tools.ts` to remove moved code
   - Update: `index.ts` to import `handleCancel` from `./workflow/cancel.js`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify remaining tools.ts is under target
   - `cancel.ts` should be ~172 lines
   - `tools.ts` should be ~580 lines (still needs Task 5)
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Cancel-specific tests pass
- [ ] Compensation integration tests pass
- [ ] No circular imports

**Dependencies:** Task 3
**Parallelizable:** No (sequential with Task 3)

---

### Task 5: Extract query handlers from workflow/tools.ts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Verify tests pass after Task 4
   - Run: `npm run test:run` — MUST PASS

2. [GREEN] Extract query handlers to new file
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/workflow/query.ts`
   - Move: `handleSummary()`, `handleReconcile()`, `handleTransitions()`
   - Update: `workflow/tools.ts` to remove moved code
   - Update: `index.ts` to import from `./workflow/query.js`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify tools.ts is under 500 lines
   - `query.ts` should be ~165 lines
   - `tools.ts` should be ~415 lines (CRUD + checkpoint)
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] Summary, reconcile, transitions tests all pass
- [ ] `workflow/tools.ts` is under 500 lines
- [ ] All tools are still accessible from index.ts

**Dependencies:** Task 4
**Parallelizable:** No (sequential with Task 4)

---

### Task 6: Refactor index.ts with per-module registration functions

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Verify all tests pass with current index.ts
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/index.test.ts`
   - Run: `npm run test:run` — MUST PASS

2. [GREEN] Create per-module registration functions
   - Update each module's tools file to export a `registerXTools(server, stateDir)` function:
     - `workflow/tools.ts` → `registerWorkflowTools()` (init, list, get, set, checkpoint)
     - `workflow/next-action.ts` → `registerNextActionTool()` (next_action)
     - `workflow/cancel.ts` → `registerCancelTool()` (cancel)
     - `workflow/query.ts` → `registerQueryTools()` (summary, reconcile, transitions)
     - `event-store/tools.ts` → `registerEventTools()` (event_append, event_query)
     - `views/tools.ts` → `registerViewTools()` (view_pipeline, view_tasks, view_workflow_status, view_team_status)
     - `team/tools.ts` → `registerTeamTools()` (team_spawn, team_message, team_broadcast, team_shutdown, team_status)
     - `tasks/tools.ts` → `registerTaskTools()` (task_claim, task_complete, task_fail)
     - `stack/tools.ts` → `registerStackTools()` (stack_status, stack_place)
   - Move Zod schema definitions from index.ts into each registration function
   - Reduce `index.ts` to: imports, `createServer()` calling all `register*()` functions, `resolveStateDir()`, `main()`
   - Run: `npm run test:run` — MUST PASS

3. [REFACTOR] Verify index.ts line count
   - `index.ts` should be ~80-100 lines
   - Run: `npm run test:run` — MUST STAY GREEN
   - Run: `npm run typecheck` — MUST PASS

**Verification:**
- [ ] All 21 MCP tools are still registered (verify with integration test)
- [ ] `index.ts` is under 150 lines
- [ ] Each module's tools file contains its own Zod schemas
- [ ] No Zod schema definitions remain in index.ts

**Dependencies:** Tasks 3, 4, 5
**Parallelizable:** No (depends on tools decomposition)

---

### Task 7: Add snapshot-store tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for SnapshotStore
   - Create: `plugins/exarchos/servers/exarchos-mcp/src/views/__tests__/snapshot-store.test.ts`
   - Tests:
     - `save_ValidData_WritesJsonFile` — save a snapshot and verify file exists with correct content
     - `load_ExistingSnapshot_ReturnsData` — save then load, verify roundtrip
     - `load_MissingFile_ReturnsUndefined` — load non-existent snapshot
     - `load_CorruptJson_ReturnsUndefined` — load file with invalid JSON
     - `load_MissingHighWaterMark_ReturnsUndefined` — load file missing required field
     - `getSnapshotPath_InvalidStreamId_ThrowsError` — path traversal prevention
     - `getSnapshotPath_InvalidViewName_ThrowsError` — unsafe characters rejected
     - `getSnapshotPath_PathTraversal_ThrowsError` — `../` in IDs blocked
     - `save_CreatesDirectory_IfMissing` — mkdir recursive behavior
     - `load_HighWaterMarkPreserved_AcrossRoundtrip` — sequence tracking
   - Expected failure: Tests should PASS (testing existing implementation)
   - Run: `npm run test:run` — MUST PASS

2. [GREEN] All tests should pass against existing implementation
   - No code changes needed — snapshot-store.ts is already implemented
   - If any test reveals a bug, fix it

3. [REFACTOR] Improve test organization if needed
   - Run: `npm run test:run` — MUST STAY GREEN

**Verification:**
- [ ] 10+ test cases covering all public methods
- [ ] Path traversal protection tested
- [ ] Error handling (corrupt files, missing files) tested
- [ ] Roundtrip save/load verified

**Dependencies:** None
**Parallelizable:** Yes (independent of all other tasks)

---

### Task 8: Update distributed-sdlc-pipeline.md ADR

**Phase:** Documentation (no TDD)

**Changes:**

1. **Section 4 - MCP Server Structure:**
   - Update package structure diagram to reflect actual file layout after decomposition:
     - `workflow/guards.ts`, `workflow/hsm-definitions.ts`
     - `workflow/next-action.ts`, `workflow/cancel.ts`, `workflow/query.ts`
     - Note unified server (not separate workflow-state-mcp)
   - Update the "MCP Tools" table:
     - Change count from "16 Tools" to "22 Tools" (10 workflow + 2 event + 4 view + 5 team + 3 task + 2 stack + 1 sync stub = 27... wait)

   Actually: Count actual tools:
   - Workflow: workflow_init, workflow_list, workflow_get, workflow_set, workflow_summary, workflow_reconcile, workflow_next_action, workflow_transitions, workflow_cancel, workflow_checkpoint = **10**
   - Event: event_append, event_query = **2**
   - View: view_pipeline, view_tasks, view_workflow_status, view_team_status = **4**
   - Team: team_spawn, team_message, team_broadcast, team_shutdown, team_status = **5**
   - Task: task_claim, task_complete, task_fail = **3**
   - Stack: stack_status, stack_place = **2**
   - Sync: sync_now = **1** (stub)
   - **Total: 27 tools**

   Wait, the ADR says 16 but assumes workflow tools are in a separate server. The ADR should reflect the actual unified count.

   - Add "Workflow Tools (10)" section to the tool table
   - Update view tool names: `view_progress` → `view_pipeline`, add `view_workflow_status`
   - Add note about `sync_now` being a stub for future implementation

2. **Section 7 - Unified Event Stream:**
   - Add "Implementation Status" column to Event Taxonomy Summary table
   - Mark each event type as "Implemented" or "Deferred (Phase N)"
   - Currently implemented event types (19): workflow.started, team.formed, phase.transitioned, task.assigned, task.claimed, task.completed, task.failed, task.progressed, agent.message, agent.handoff, stack.position-filled, stack.restacked, stack.enqueued, gate.executed, gate.self-corrected, remediation.started, remediation.attempted, remediation.exhausted, context.assembled
   - Deferred: ContainerProvisioned, CodingAttemptStarted, CodingAttemptCompleted, ContainerDestroyed, TaskRouted, DependencyBlocked, DependencyResolved (remote-only events, Phase 4-5)

3. **Section 3 - Architecture Overview:**
   - Add note that workflow-state-mcp has been unified into exarchos-mcp
   - Update component table to reflect single server

4. **General:**
   - Add "Implementation Status" section before "Implementation Phases"
   - List which phases are complete, in progress, or planned

**Dependencies:** Tasks 1-6
**Parallelizable:** No (needs final code structure)

---

### Task 9: Update CLAUDE.md

**Phase:** Documentation (no TDD)

**Changes:**

1. **Architecture section:**
   - Update "MCP Servers" description to mention decomposed modules:
     - `workflow/guards.ts` — Guard definitions for all HSM transitions
     - `workflow/hsm-definitions.ts` — HSM definitions for feature/debug/refactor workflows
     - `workflow/next-action.ts` — Auto-continue logic and phase-to-action mapping
     - `workflow/cancel.ts` — Saga compensation and workflow cancellation
     - `workflow/query.ts` — Summary, reconcile, and transitions handlers
   - Note the per-module tool registration pattern

2. **Build & Test Commands:**
   - Verify all commands are still accurate after refactor

**Dependencies:** Tasks 1-6
**Parallelizable:** No (needs final code structure)

---

## Parallelization Strategy

### Sequential Chain A (state-machine decomposition)
Task 1 → Task 2

### Sequential Chain B (tools decomposition)
Task 3 → Task 4 → Task 5 → Task 6

### Independent
Task 7 (snapshot-store tests)

### Documentation (after all code changes)
Task 8 → Task 9

### Parallel Groups

```
Group 1: Chain A (Tasks 1-2) ─────────────────────────────┐
Group 2: Chain B (Tasks 3-6) ─────────────────────────────├─→ Task 8 → Task 9
Group 3: Task 7 (independent) ────────────────────────────┘
```

- **Group 1** and **Group 2** can run in parallel (different files)
- **Group 3** can run in parallel with both groups
- **Tasks 8-9** run after all code changes complete

### Stack Order

1. Task 1 — Guards extraction
2. Task 2 — HSM definitions extraction
3. Task 3 — NextAction extraction
4. Task 4 — Cancel extraction
5. Task 5 — Query handlers extraction
6. Task 6 — Index.ts registry refactor
7. Task 7 — Snapshot-store tests
8. Task 8 — ADR update
9. Task 9 — CLAUDE.md update

## Deferred Items

| Item | Rationale |
|------|-----------|
| Remote sync implementation (`sync_now` stub) | Separate feature, ADR Phase 4 |
| Task Router implementation | Separate feature, ADR Phase 4 |
| Agent team integration (Claude Code experimental) | Depends on experimental feature stability |
| `agents/` directory (implementer.md, reviewer.md) | Subagent definitions are dynamically generated by delegation skill |
| Performance optimization (state file caching, view snapshots) | Requires profiling data, separate effort |
| Event log retention policy (beyond FIFO cap) | Low priority, current cap is adequate |

## Completion Checklist
- [ ] All existing tests pass after decomposition
- [ ] No source file in `src/` exceeds 500 lines
- [ ] `state-machine.ts` decomposed into 3 files (guards, hsm-definitions, state-machine)
- [ ] `workflow/tools.ts` decomposed into 4 files (tools, next-action, cancel, query)
- [ ] `index.ts` uses per-module registration pattern
- [ ] ADR tool table matches actual MCP tool names
- [ ] ADR event taxonomy has implemented/deferred markers
- [ ] snapshot-store has dedicated test file
- [ ] CLAUDE.md architecture section matches implementation
- [ ] Code coverage maintained or improved
