# Implementation Plan: Agent Teams Bridge — Local Event Store + Team Coordinator

## Source Design
Link: `docs/designs/2026-02-05-agent-teams-bridge.md`

## Scope
**Target:** Partial — Phase (a) from Open Question #6: local-only event store, team coordinator, and materialized views. This delivers a working agent teams integration without remote dependencies.

**Excluded:**
- Remote event projection (Phase c) — requires agentic-engine API endpoints not yet built
- Bidirectional sync (Phase d) — depends on remote projection
- Jules interop as virtual teammates (Open Question #5) — separate feature
- Token budget enforcement (Open Question #3) — deferred until usage patterns observed

**Rationale:** Delivering local-first gives immediate value (agent teams work today), while remote capabilities build incrementally on top. Each phase is independently shippable and testable.

## Summary
- Total tasks: 24
- Parallel groups: 5
- Estimated test count: ~72
- Design coverage: 12 of 15 design sections covered (3 explicitly deferred)

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Bridge MCP Server > Tools | 12 tool definitions registered | 001, 007-009, 013-015, 019-020 | Covered |
| Bridge MCP Server > Configuration | Config schema, operational modes | 002 | Covered |
| Event Schema > WorkflowEvent base | Base interface + metadata fields | 003 | Covered |
| Event Schema > Workflow-level events | WorkflowStarted, TeamFormed, PhaseTransitioned, TaskAssigned | 004 | Covered |
| Event Schema > Task-level events | TaskClaimed, TaskProgressed, TestResult, TaskCompleted, TaskFailed | 005 | Covered |
| Event Schema > Inter-agent events | AgentMessage, AgentHandoff | 006 | Covered |
| Local Event Store | File-based append-only store | 007-008 | Covered |
| Concurrency > Optimistic locking | Sequence numbers, conflict detection | 009 | Covered |
| Concurrency > Vector clock | Causal ordering for views | 010 | Covered |
| CQRS Views > WorkflowStatusView | Materialized from events | 011 | Covered |
| CQRS Views > TeamStatusView | Materialized from events | 012 | Covered |
| CQRS Views > TaskDetailView | Materialized from events | 013 | Covered |
| Team Coordinator > Spawn | Role-based teammate creation | 014 | Covered |
| Team Coordinator > Messaging | Send/broadcast to teammates | 015 | Covered |
| Team Coordinator > Shutdown | Graceful teammate shutdown | 016 | Covered |
| Team Composition > Roles | Role definitions + spawn prompts | 017 | Covered |
| Team Composition > Strategy | Sizing and assignment logic | 018 | Covered |
| MCP Server > Entry point | Server factory, tool registration | 019 | Covered |
| MCP Server > Tool integration | All tools wired to handlers | 020 | Covered |
| Installer integration | --enable-agent-teams flag, settings.json | 021 | Covered |
| Subagent definitions | implementer.md, reviewer.md, integrator.md | 022 | Covered |
| Delegation skill extension | Agent teams as delegation alternative | 023 | Covered |
| /team command | Manual team management command | 024 | Covered |
| Event Projection > Local→Remote | Remote HTTP projection | — | Deferred: Phase (c) |
| Event Projection > Remote→Local | SSE subscription | — | Deferred: Phase (d) |
| Remote > Auth | HMAC token management | — | Deferred: Phase (c) |

## Task Breakdown

---

### Task 001: Bridge MCP server scaffolding

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `createServer_WithValidStateDir_ReturnsServerInstance`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/index.test.ts`
   - Expected failure: Module not found — index.ts doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/index.ts`
   - Changes: Create MCP server factory function with `createServer(stateDir)`, register empty tool list, add `formatResult` helper
   - Also create: `package.json`, `tsconfig.json` matching workflow-state-mcp patterns
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract constants
   - Apply: Extract SERVER_NAME, SERVER_VERSION constants
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A — Foundation)

---

### Task 002: Bridge configuration schema

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `BridgeConfigSchema_ValidLocalConfig_Parses`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/schemas.test.ts`
   - Expected failure: Module not found — schemas.ts doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write tests: `BridgeConfigSchema_ValidDualConfig_Parses`, `BridgeConfigSchema_MissingMode_UsesDefault`, `BridgeConfigSchema_InvalidMode_Rejects`
   - Same file
   - Expected failure: Schema doesn't exist

3. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/schemas.ts`
   - Changes: Define `BridgeConfigSchema` with Zod — mode (local|remote|dual), remote connection settings, projection config, view refresh settings. All with appropriate defaults.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A — Foundation)

---

### Task 003: WorkflowEvent base schema and types

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `WorkflowEventSchema_ValidEvent_Parses`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/schema.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write tests: `WorkflowEventSchema_MissingStreamId_Rejects`, `WorkflowEventSchema_InvalidTimestamp_Rejects`, `WorkflowEventSchema_AgentRoleEnum_ValidatesCorrectly`
   - Same file
   - Expected failure: Schema doesn't exist

3. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/schema.ts`
   - Changes: Define `WorkflowEventSchema` base with Zod — streamId, sequence, timestamp, type, correlationId, causationId, agentId, agentRole. Define `AgentRole` enum.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A — Foundation)

---

### Task 004: Workflow-level event schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `WorkflowStartedSchema_ValidEvent_Parses`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/schema.test.ts`
   - Expected failure: WorkflowStarted schema doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write tests for each workflow event type:
   - `TeamFormedSchema_ValidEvent_Parses`
   - `PhaseTransitionedSchema_ValidEvent_Parses`
   - `TaskAssignedSchema_ValidEvent_Parses`
   - Expected failure: Schemas don't exist

3. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/schema.ts`
   - Changes: Add WorkflowStarted, TeamFormed, PhaseTransitioned, TaskAssigned schemas extending WorkflowEvent base
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 003
**Parallelizable:** No (depends on 003)

---

### Task 005: Task-level event schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests for each task event type:
   - `TaskClaimedSchema_ValidEvent_Parses`
   - `TaskProgressedSchema_TddPhaseRed_Parses`
   - `TestResultSchema_ValidCoverage_Parses`
   - `TaskCompletedSchema_WithArtifacts_Parses`
   - `TaskFailedSchema_WithDiagnostics_Parses`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/schema.test.ts`
   - Expected failure: Schemas don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/schema.ts`
   - Changes: Add TaskClaimed, TaskProgressed, TestResult, TaskCompleted, TaskFailed schemas
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 003
**Parallelizable:** No (depends on 003, can parallel with 004)

---

### Task 006: Inter-agent event schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `AgentMessageSchema_FindingType_Parses`
   - `AgentMessageSchema_BroadcastTarget_Parses`
   - `AgentHandoffSchema_ValidHandoff_Parses`
   - `AgentHandoffSchema_MissingContext_Rejects`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/schema.test.ts`
   - Expected failure: Schemas don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/schema.ts`
   - Changes: Add AgentMessage, AgentHandoff schemas. Define MessageType enum (finding, question, challenge, handoff).
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Create discriminated union
   - Apply: Create `AnyWorkflowEvent` discriminated union over all event types for type-safe dispatching
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 003
**Parallelizable:** No (depends on 003, can parallel with 004-005)

---

### Task 007: Local event store — append and read

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EventStore_AppendEvent_PersistsToFile`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/store.test.ts`
   - Expected failure: Module not found — store.ts doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write tests:
   - `EventStore_ReadEvents_ReturnsAllInOrder`
   - `EventStore_ReadEvents_EmptyStream_ReturnsEmpty`
   - `EventStore_AppendMultiple_MaintainsOrder`
   - Expected failure: Store doesn't exist

3. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/store.ts`
   - Changes: `LocalEventStore` class with `append(event)` and `readAll(streamId)`. Use JSONL (one JSON object per line) for append-only file storage. Each stream is a separate file.
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Add stream isolation
   - Apply: Ensure stream files are namespaced in subdirectory
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 003-006 (needs event schemas)
**Parallelizable:** No (depends on schemas)

---

### Task 008: Local event store — query by type and time range

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `EventStore_QueryByType_ReturnsMatchingEvents`
   - `EventStore_QueryByTimeRange_ReturnsEventsInRange`
   - `EventStore_QueryByTypeAndRange_CombinesFilters`
   - `EventStore_QuerySinceSequence_ReturnsSubsequentEvents`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/events/store.test.ts`
   - Expected failure: Query methods don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/events/store.ts`
   - Changes: Add `query(streamId, { type?, since?, from?, to? })` method to `LocalEventStore`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 007
**Parallelizable:** No (extends 007)

---

### Task 009: Optimistic concurrency control

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `SequenceManager_NextSequence_ReturnsMonotonic`
   - `SequenceManager_ConcurrentAppend_DetectsConflict`
   - `SequenceManager_AfterConflict_RefreshAndRetry_Succeeds`
   - `EventStore_AppendWithWrongSequence_ThrowsConflictError`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/concurrency/sequence.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/concurrency/sequence.ts`
   - Changes: `SequenceManager` class with `next(streamId)`, `validate(streamId, expected)`. Integrate with `LocalEventStore.append()` to reject out-of-sequence writes.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 007
**Parallelizable:** No (depends on 007)

---

### Task 010: Vector clock for causal ordering

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `VectorClock_Increment_IncrementsOwnComponent`
   - `VectorClock_Merge_TakesMaxOfEachComponent`
   - `VectorClock_HappensBefore_DetectsCausality`
   - `VectorClock_Concurrent_DetectsNonCausality`
   - `VectorClock_Compare_ReturnsCorrectOrdering`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/concurrency/vector-clock.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/concurrency/vector-clock.ts`
   - Changes: `VectorClock` class with `increment(agentId)`, `merge(other)`, `happensBefore(other)`, `isConcurrentWith(other)`, `compare(other)`. Immutable — returns new instances.
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Add serialization
   - Apply: `toJSON()` and `fromJSON()` for persistence
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group B — Concurrency, independent of events)

---

### Task 011: WorkflowStatusView materializer

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `WorkflowStatusView_FromEmptyStream_ReturnsDefaults`
   - `WorkflowStatusView_AfterWorkflowStarted_ShowsFeatureId`
   - `WorkflowStatusView_AfterTeamFormed_ShowsTeamSize`
   - `WorkflowStatusView_AfterTaskCompleted_IncrementsCounter`
   - `WorkflowStatusView_AfterTaskFailed_IncrementsFailedCounter`
   - `WorkflowStatusView_AfterPhaseTransitioned_UpdatesPhase`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/views/workflow-status.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/views/workflow-status.ts`
   - Changes: `WorkflowStatusProjection` with `apply(event)` method that folds events into `WorkflowStatusView` interface. Pure function — no I/O.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 003-006 (event schemas)
**Parallelizable:** Yes (Group C — Views, parallel with store tasks)

---

### Task 012: TeamStatusView materializer

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `TeamStatusView_FromEmptyStream_ReturnsEmptyTeam`
   - `TeamStatusView_AfterTeamFormed_ShowsTeammates`
   - `TeamStatusView_AfterTaskClaimed_UpdatesTeammateStatus`
   - `TeamStatusView_AfterTaskCompleted_IncrementsTeammateCount`
   - `TeamStatusView_AfterAgentMessage_IncrementsMessageCount`
   - `TeamStatusView_UnclaimedTasks_CountsCorrectly`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/views/team-status.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/views/team-status.ts`
   - Changes: `TeamStatusProjection` with `apply(event)` method that folds events into `TeamStatusView` interface.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 003-006 (event schemas)
**Parallelizable:** Yes (Group C — Views, parallel with 011)

---

### Task 013: TaskDetailView materializer

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `TaskDetailView_FromAssignment_ShowsPending`
   - `TaskDetailView_AfterClaimed_ShowsClaimedWithAssignee`
   - `TaskDetailView_AfterTddProgress_ShowsCurrentPhase`
   - `TaskDetailView_AfterTestResult_ShowsCoverage`
   - `TaskDetailView_AfterCompleted_ShowsBranchAndSha`
   - `TaskDetailView_AfterFailed_ShowsDiagnostics`
   - `TaskDetailView_EventHistory_CapturesAllTaskEvents`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/views/task-detail.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/views/task-detail.ts`
   - Changes: `TaskDetailProjection` with `apply(event)` for a single task. Filters events by taskId.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 003-006 (event schemas)
**Parallelizable:** Yes (Group C — Views, parallel with 011-012)

---

### Task 014: View materializer coordinator

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `ViewMaterializer_MaterializeAll_RebuildsFromEvents`
   - `ViewMaterializer_GetView_ReturnsLatestProjection`
   - `ViewMaterializer_SnapshotEveryN_CreatesSnapshot`
   - `ViewMaterializer_LoadFromSnapshot_SkipsReplayedEvents`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/views/materializer.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/views/materializer.ts`
   - Changes: `ViewMaterializer` class that holds all three projections, replays events from store, maintains snapshots. `getView(viewType, streamId)` and `refresh(streamId)` methods.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 007, 011-013
**Parallelizable:** No (depends on store + all views)

---

### Task 015: Team role definitions and spawn prompts

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `RoleDefinition_Implementer_HasCorrectCapabilities`
   - `RoleDefinition_Reviewer_IsReadOnly`
   - `RoleDefinition_Integrator_HasMergeAccess`
   - `RoleDefinition_Researcher_UsesHaiku`
   - `SpawnPrompt_Generate_IncludesRoleAndTask`
   - `SpawnPrompt_Generate_IncludesTddRequirements`
   - `SpawnPrompt_Generate_IncludesMaterializedView`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/team/roles.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/team/roles.ts`
   - Changes: `ROLES` constant object with capabilities, model, and worktree config per role. `generateSpawnPrompt(role, context)` function using template from design.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group D — Team, independent)

---

### Task 016: Team composition strategy

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `TeamComposition_ThreeIndependentTasks_ReturnsThreeImplementers`
   - `TeamComposition_ReviewPhase_IncludesReviewer`
   - `TeamComposition_DebugPhase_IncludesMultipleResearchers`
   - `TeamComposition_MaxTeamSize_CapsAtLimit`
   - `TeamComposition_SingleTask_RecommendsSingleAgent`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/team/composition.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/team/composition.ts`
   - Changes: `determineComposition(tasks, phase, options)` function that returns team roster with roles, models, and assignments.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 015
**Parallelizable:** No (depends on 015)

---

### Task 017: Team coordinator — spawn and status

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `TeamCoordinator_Spawn_RecordsTeammateInState`
   - `TeamCoordinator_Spawn_EmitsTeamFormedEvent`
   - `TeamCoordinator_Status_ReturnsAllTeammates`
   - `TeamCoordinator_Status_EmptyTeam_ReturnsEmptyList`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/team/coordinator.test.ts`
   - Expected failure: Module not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/team/coordinator.ts`
   - Changes: `TeamCoordinator` class with `spawn(role, worktree, task)` and `getStatus()`. Spawn records teammate in local state and appends event. Does NOT invoke Claude Code team primitives directly — returns spawn instructions for the lead to execute.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 007 (event store), 015 (roles)
**Parallelizable:** No (depends on store + roles)

---

### Task 018: Team coordinator — messaging and shutdown

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `TeamCoordinator_Message_EmitsAgentMessageEvent`
   - `TeamCoordinator_Broadcast_EmitsEventForEachTeammate`
   - `TeamCoordinator_Shutdown_MarksTeammateAsShutdown`
   - `TeamCoordinator_Shutdown_EmitsShutdownEvent`
   - `TeamCoordinator_ShutdownAll_CleansUpEntireTeam`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/team/coordinator.test.ts`
   - Expected failure: Methods don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/team/coordinator.ts`
   - Changes: Add `message(from, to, content, type)`, `broadcast(from, content, type)`, `shutdown(name)`, `shutdownAll()` to `TeamCoordinator`.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 017
**Parallelizable:** No (extends 017)

---

### Task 019: MCP tool handlers — event tools

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `EventAppendTool_ValidEvent_AppendsAndReturnsSequence`
   - `EventAppendTool_InvalidEvent_ReturnsError`
   - `EventAppendTool_ConflictingSequence_ReturnsConflictError`
   - `EventQueryTool_ByType_ReturnsFiltered`
   - `EventQueryTool_SinceSequence_ReturnsSubsequent`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/tools.test.ts`
   - Expected failure: Tool handlers don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/tools.ts`
   - Changes: `handleEventAppend(args, deps)` and `handleEventQuery(args, deps)` functions. Define `ToolDeps` interface for dependency injection (store, materializer, coordinator).
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 007-009 (store + concurrency)
**Parallelizable:** No (depends on store)

---

### Task 020: MCP tool handlers — view and team tools

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `ViewGetTool_WorkflowStatus_ReturnsMaterializedView`
   - `ViewGetTool_TeamStatus_ReturnsMaterializedView`
   - `ViewGetTool_TaskDetail_ReturnsTaskView`
   - `TeamSpawnTool_ValidRole_ReturnsSpawnInstructions`
   - `TeamMessageTool_ValidTarget_EmitsEvent`
   - `TeamShutdownTool_ValidTeammate_MarksShutdown`
   - `TeamStatusTool_ReturnsCurrentTeam`
   - `TaskClaimTool_UnclaimedTask_ClaimsSuccessfully`
   - `TaskCompleteTool_WithArtifacts_EmitsEvent`
   - `TaskFailTool_WithDiagnostics_EmitsEvent`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/tools.test.ts`
   - Expected failure: Tool handlers don't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/tools.ts`
   - Changes: Add handlers for all remaining tools: `handleViewGet`, `handleTeamSpawn`, `handleTeamMessage`, `handleTeamBroadcast`, `handleTeamShutdown`, `handleTeamStatus`, `handleTaskClaim`, `handleTaskComplete`, `handleTaskFail`.
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract tool input schemas
   - Apply: Move tool-specific Zod input schemas to schemas.ts
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 014 (materializer), 017-018 (coordinator)
**Parallelizable:** No (depends on views + team)

---

### Task 021: Wire tools into MCP server

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `Server_RegistersAllTwelveTools`
   - `Server_EventAppendTool_DelegatesToHandler`
   - `Server_ViewGetTool_DelegatesToHandler`
   - `Server_TeamSpawnTool_DelegatesToHandler`
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/__tests__/index.test.ts`
   - Expected failure: Tools not registered
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/agent-teams-bridge/servers/agent-teams-bridge-mcp/src/index.ts`
   - Changes: Wire all 12 tools into `createServer()` using `server.tool()` calls with proper schemas and handlers. Create `ToolDeps` from store, materializer, coordinator.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 019-020 (all tool handlers)
**Parallelizable:** No (depends on all tools)

---

### Task 022: Installer integration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `Install_WithAgentTeamsFlag_RegistersBridgeMcp`
   - `Install_WithAgentTeamsFlag_SetsExperimentalEnvVar`
   - `Install_WithoutAgentTeamsFlag_SkipsBridgeMcp`
   - `Install_WithAgentTeamsFlag_BuildsBridgeMcpServer`
   - File: `src/install.test.ts` (extend existing tests)
   - Expected failure: --enable-agent-teams flag not handled
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `src/install.ts`
   - Changes: Add `--enable-agent-teams` flag to `parseArgs()`. In `install()`, conditionally build bridge MCP server and register in `~/.claude.json`. Add `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to settings.json env.
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 021 (server must be wirable)
**Parallelizable:** No (depends on server)

---

### Task 023: Subagent definition files

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `AgentDefinitions_ImplementerMd_HasRequiredFrontmatter`
   - File: `plugins/agent-teams-bridge/agents/__tests__/agents.test.ts`
   - Expected failure: File not found
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write tests:
   - `AgentDefinitions_ReviewerMd_HasReadOnlyTools`
   - `AgentDefinitions_IntegratorMd_HasMergeCapabilities`
   - Expected failure: Files don't exist

3. [GREEN] Create agent definition files
   - Files:
     - `plugins/agent-teams-bridge/agents/implementer.md` — name, description, tools (all), model (opus), skills (TDD), spawn prompt with TDD enforcement
     - `plugins/agent-teams-bridge/agents/reviewer.md` — name, description, tools (Read, Grep, Glob), model (sonnet), read-only
     - `plugins/agent-teams-bridge/agents/integrator.md` — name, description, tools (all), model (opus), merge-focused prompt
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group E — Integration artifacts)

---

### Task 024: /team command and delegation skill extension

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write test: `TeamCommand_HasValidStructure`
   - File: `plugins/agent-teams-bridge/commands/__tests__/team.test.ts`
   - Expected failure: File not found
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create command and update delegation skill
   - Files:
     - `plugins/agent-teams-bridge/commands/team.md` — /team command for manual team management (spawn, status, message, shutdown)
     - Update `skills/delegation/SKILL.md` — add agent teams as delegation alternative with decision logic from design
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group E — Integration artifacts)

---

## Parallelization Strategy

### Group A — Foundation (Tasks 001-003)
Independent scaffolding, can start simultaneously.

```
Task 001 (server scaffold)  ──┐
Task 002 (config schema)    ──┤── All parallel
Task 003 (event base)       ──┘
```

### Group A' — Event Schemas (Tasks 004-006)
Depend on Task 003 but parallel with each other.

```
Task 003 ──► Task 004 (workflow events)  ──┐
         ──► Task 005 (task events)      ──┤── Parallel after 003
         ──► Task 006 (inter-agent)      ──┘
```

### Group B — Concurrency (Task 010)
Fully independent, can run in parallel with everything.

```
Task 010 (vector clock)  ── Independent
```

### Group C — Views (Tasks 011-013)
Depend on event schemas but parallel with each other.

```
Tasks 004-006 ──► Task 011 (workflow view)  ──┐
              ──► Task 012 (team view)      ──┤── Parallel
              ──► Task 013 (task view)      ──┘
```

### Group D — Team (Tasks 015-016)
Independent of events, can run in parallel with Groups A/B/C.

```
Task 015 (roles)  ──► Task 016 (composition)
```

### Group E — Integration Artifacts (Tasks 023-024)
No code dependencies, can run anytime.

```
Task 023 (agent definitions)  ──┐
Task 024 (command + skill)    ──┘── Parallel, anytime
```

### Sequential Chain — Store→Tools→Server→Installer

```
Tasks 004-006 ──► Task 007 (store) ──► Task 008 (query) ──► Task 009 (concurrency)
                                                              │
Tasks 011-013 ──► Task 014 (materializer) ────────────────────┤
                                                              │
Tasks 017-018 (coordinator) ──────────────────────────────────┤
                                                              ▼
                                                    Task 019 (event tools)
                                                              │
                                                    Task 020 (view+team tools)
                                                              │
                                                    Task 021 (wire server)
                                                              │
                                                    Task 022 (installer)
```

### Recommended Worktree Assignment (5 parallel groups)

| Worktree | Tasks | Focus |
|----------|-------|-------|
| wt-foundation | 001, 002, 003 → 004-006 → 007-009 | Schemas, store, concurrency |
| wt-views | 011, 012, 013 → 014 | Materialized views |
| wt-concurrency | 010 | Vector clock (small, fast) |
| wt-team | 015 → 016 → 017 → 018 | Roles, composition, coordinator |
| wt-artifacts | 023, 024 | Commands, agents, skill updates |

After parallel groups complete, sequential chain (019 → 020 → 021 → 022) runs in main branch.

## Deferred Items

| Item | Rationale |
|------|-----------|
| Remote event projection (Local→Remote) | Requires agentic-engine API endpoints. Phase (c) of incremental delivery. |
| Remote event subscription (Remote→Local) | Requires SSE infrastructure. Phase (d) of incremental delivery. |
| HMAC authentication for remote | Depends on remote projection. Phase (c). |
| Jules virtual teammates | Separate feature. Requires Jules MCP server extension. |
| Per-teammate token budgets | Defer until usage patterns observed. |
| view_subscribe (SSE) tool | Deferred — requires persistent connection from MCP tool, which is not standard. Will implement as polling via view_get for now. |
| Retry/backoff for remote | Depends on remote projection. Phase (c). |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Event schemas validate all event types
- [ ] Local event store supports append, read, query
- [ ] Optimistic concurrency prevents conflicting writes
- [ ] Vector clocks establish causal ordering
- [ ] All three materialized views project correctly from events
- [ ] Team coordinator manages spawn, message, shutdown lifecycle
- [ ] All 12 MCP tools registered and functional (view_subscribe deferred as polling)
- [ ] Installer optionally installs bridge MCP
- [ ] Subagent definitions follow existing patterns
- [ ] Ready for review
