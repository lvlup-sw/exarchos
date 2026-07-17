# Implementation Plan: Agent Teams Deep Integration

**Feature:** Agent Teams Deep Integration via Hooks Pipeline
**Design:** `docs/designs/2026-02-16-agent-teams-deep-integration.md`
**Workflow:** `agent-teams-deep-integration`
**Date:** 2026-02-16

## Source Design

Link: `docs/designs/2026-02-16-agent-teams-deep-integration.md`

## Prerequisites

This plan assumes issue #401 is completed, providing:
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` and `teammateMode: "auto"` in settings
- `findActiveWorkflowState()` helper in gates.ts
- `matchCwdToTask()` helper mapping cwd to worktree/task
- `handleTeammateGate` updating task status after quality gates pass
- Basic dual-mode documentation in delegation SKILL.md

This plan builds the **deep integration layer** on top of that foundation.

## Scope

**Target:** Full design — all 6 technical design sections
**Excluded:** None

## Summary

- Total tasks: 13
- Parallel groups: 6 (A through F)
- Estimated test count: ~35
- Design coverage: 6 of 6 technical design sections covered

## Spec Traceability

| Design Section | Key Requirements | Tasks |
|---------------|-----------------|-------|
| 1. Hook Enrichment Pipeline — SubagentStart | Historical intelligence injection, team context | 6, 7 |
| 1. Hook Enrichment Pipeline — TeammateIdle | Rich event emission, follow-up detection | 8, 9 |
| 1. Hook Enrichment Pipeline — PreCompact | Team composition snapshot in checkpoint | 10 |
| 1. Hook Enrichment Pipeline — SessionStart | Orphaned team recovery detection | 11 |
| 2. New Event Types | 6 team event types with Zod schemas | 1 |
| 3. CQRS Views — TeamPerformanceView | Teammate metrics, module metrics, team sizing | 2, 3 |
| 3. CQRS Views — DelegationTimelineView | Timeline projection, bottleneck detection | 4 |
| 3+4. View Registration + Adaptive Flow | Composite routing, registry, handlers, orchestration docs | 5, 12, 13 |
| 5. Guard-Aware Task Graph | Documented in adaptive orchestration flow | 12 |
| 6. SessionStart Recovery | Orphaned team state detection | 11 |

## Parallelization Strategy

```
Phase 1 (independent):
  Group A (schemas):     Task 1
  Group E (lifecycle):   Task 10 ║ Task 11
  Group F (content):     Task 12 ║ Task 13

Phase 2 (after Group A):
  Group B (views):       Task 2 → Task 3, Task 4 (parallel), then → Task 5
  Group C (subagent):    Task 6 → Task 7
  Group D (teammate):    Task 8 → Task 9

Groups B, C, D run in parallel (independent modules).
```

**Worktree assignment:**
- Worktree 1: Groups A → B (schemas then views)
- Worktree 2: Groups C (subagent-context enrichment)
- Worktree 3: Groups D + E (gates enrichment + lifecycle hooks)
- Worktree 4: Group F (content-only, no TypeScript)

---

## Task Breakdown

### Task 1: Add 6 team event types + Zod data schemas

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`

1. **[RED]** Write tests in `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.test.ts`:
   - `TeamSpawnedData_ValidPayload_ParsesSuccessfully` — validate `{ teamSize: 3, teammateNames: ['a','b','c'], taskCount: 5, dispatchMode: 'agent-team' }` passes Zod
   - `TeamTaskCompletedData_ValidPayload_ParsesSuccessfully` — validate `{ taskId: 'task-001', teammateName: 'worker-1', durationMs: 5000, filesChanged: ['a.ts'], testsPassed: true, qualityGateResults: {} }` passes Zod
   - `TeamTaskFailedData_ValidPayload_ParsesSuccessfully` — validate `{ taskId: 'task-001', teammateName: 'worker-1', failureReason: 'typecheck', gateResults: {} }` passes Zod
   - `TeamDisbandedData_ValidPayload_ParsesSuccessfully` — validate `{ totalDurationMs: 60000, tasksCompleted: 5, tasksFailed: 0 }` passes Zod
   - `TeamContextInjectedData_ValidPayload_ParsesSuccessfully` — validate `{ phase: 'delegate', toolsAvailable: 3, historicalHints: ['hint'] }` passes Zod
   - `TeamTaskAssignedData_ValidPayload_ParsesSuccessfully` — validate `{ taskId: 'task-001', teammateName: 'worker-1', worktreePath: '/tmp/wt', modules: ['auth'] }` passes Zod
   - `EventTypes_IncludesTeamEvents_AllSixPresent` — assert `EventTypes` array includes all 6 `team.*` strings
   - Expected failure: `team.spawned` not in `EventTypes`; `TeamSpawnedData` is not exported

2. **[GREEN]** Add to `schemas.ts`:
   - Append 6 type strings to `EventTypes` array: `'team.spawned'`, `'team.task.assigned'`, `'team.task.completed'`, `'team.task.failed'`, `'team.disbanded'`, `'team.context.injected'`
   - Add Zod data schemas: `TeamSpawnedData`, `TeamTaskAssignedData`, `TeamTaskCompletedData`, `TeamTaskFailedData`, `TeamDisbandedData`, `TeamContextInjectedData`
   - Export TypeScript types via `z.infer<>`
   - Add `'team.task.completed'` and `'team.task.failed'` to `AGENT_EVENT_TYPES` (they require agentId/source since emitted by teammate hooks)

3. **[REFACTOR]** Group team event schemas under a `// ─── Team Event Data ──────` section comment, following existing convention

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 2: TeamPerformanceView — teammate metrics projection

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/views/team-performance-view.ts` (new file)

1. **[RED]** Write tests in `plugins/exarchos/servers/exarchos-mcp/src/views/team-performance-view.test.ts`:
   - `init_ReturnsEmptyState_NoTeammates` — assert `init()` returns `{ teammates: {}, modules: {}, teamSizing: { avgTasksPerTeammate: 0, dataPoints: 0 } }`
   - `apply_TeamTaskCompleted_IncrementsTeammateTaskCount` — apply `team.task.completed` event with `teammateName: 'worker-1'`, assert `teammates['worker-1'].tasksCompleted === 1`
   - `apply_TeamTaskCompleted_UpdatesAvgDuration` — apply 2 events with `durationMs: 4000` and `6000`, assert `teammates['worker-1'].avgDurationMs === 5000`
   - `apply_TeamTaskCompleted_TracksModuleExpertise` — apply event with `modules: ['auth', 'api']` in payload (extracted from filesChanged paths), assert `teammates['worker-1'].moduleExpertise` contains `'auth'`
   - `apply_TeamTaskFailed_IncrementsFailCount` — apply `team.task.failed`, assert `teammates['worker-1'].tasksFailed === 1`
   - `apply_TeamTaskCompleted_CalculatesPassRate` — apply 3 completed + 1 failed, assert `qualityGatePassRate === 0.75`
   - Expected failure: Module `team-performance-view` does not exist

2. **[GREEN]** Create `team-performance-view.ts`:
   - Export `TEAM_PERFORMANCE_VIEW = 'team_performance'` constant
   - Define `TeamPerformanceViewState` interface with `teammates`, `modules`, `teamSizing` fields
   - Implement `teamPerformanceProjection: ViewProjection<TeamPerformanceViewState>` with `init()` and `apply()` handling `team.task.completed`, `team.task.failed` events
   - Teammate metrics: running average for duration, accumulating module expertise, pass rate from completed/(completed+failed)

3. **[REFACTOR]** Extract duration averaging helper if complex

**Dependencies:** Task 1 (team event types must exist for type checking)
**Parallelizable:** Yes (Group B start)

---

### Task 3: TeamPerformanceView — module metrics + team sizing

**Phase:** RED → GREEN → REFACTOR

**Module:** Same as Task 2

1. **[RED]** Write tests in `team-performance-view.test.ts`:
   - `apply_TeamTaskCompleted_TracksModuleDuration` — apply events touching `auth` module, assert `modules['auth'].avgTaskDurationMs` calculated correctly
   - `apply_WorkflowFixCycle_IncrementsModuleFixCycleRate` — apply `workflow.fix-cycle` event with module context, assert `modules['auth'].fixCycleRate` incremented
   - `apply_TeamSpawned_UpdatesTeamSizingDataPoints` — apply `team.spawned` with `teamSize: 3`, assert `teamSizing.dataPoints === 1`
   - `apply_TeamDisbanded_CalculatesAvgTasksPerTeammate` — apply spawned (3 teammates, 6 tasks) then disbanded, assert `teamSizing.avgTasksPerTeammate === 2`
   - Expected failure: `modules` not populated; `teamSizing.dataPoints` not tracked

2. **[GREEN]** Extend `apply()`:
   - Handle `team.task.completed` for module metrics: extract module from event data, update `modules[name].avgTaskDurationMs`
   - Handle `workflow.fix-cycle` for fix cycle tracking
   - Handle `team.spawned` to record team size data point
   - Handle `team.disbanded` to finalize team sizing calculations

3. **[REFACTOR]** Consolidate module extraction logic

**Dependencies:** Task 2
**Parallelizable:** Sequential after Task 2

---

### Task 4: DelegationTimelineView — timeline + bottleneck detection

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/views/delegation-timeline-view.ts` (new file)

1. **[RED]** Write tests in `plugins/exarchos/servers/exarchos-mcp/src/views/delegation-timeline-view.test.ts`:
   - `init_ReturnsEmptyState_NoTasks` — assert `init()` returns `{ featureId: '', teamSpawnedAt: null, teamDisbandedAt: null, totalDurationMs: 0, tasks: [], bottleneck: null }`
   - `apply_TeamSpawned_SetsSpawnTimestamp` — apply `team.spawned`, assert `teamSpawnedAt` matches event timestamp
   - `apply_TeamTaskAssigned_AddsTaskEntry` — apply `team.task.assigned` with taskId and teammateName, assert task in `tasks` array with status `'assigned'`
   - `apply_TeamTaskCompleted_UpdatesTaskStatus` — apply assigned then completed events for same taskId, assert task status `'completed'` with `durationMs` calculated
   - `apply_TeamTaskFailed_UpdatesTaskStatus` — apply assigned then failed, assert status `'failed'`
   - `apply_TeamDisbanded_CalculatesTotalDuration` — apply spawned then disbanded, assert `totalDurationMs` calculated from timestamps
   - `apply_MultipleCompleted_IdentifiesBottleneck` — apply 3 tasks with varying durations (1000, 5000, 2000), assert `bottleneck.taskId` is the 5000ms task with reason `'longest_task'`
   - Expected failure: Module `delegation-timeline-view` does not exist

2. **[GREEN]** Create `delegation-timeline-view.ts`:
   - Export `DELEGATION_TIMELINE_VIEW = 'delegation_timeline'` constant
   - Define `DelegationTimelineViewState` interface
   - Implement `delegationTimelineProjection: ViewProjection<DelegationTimelineViewState>` handling `team.spawned`, `team.task.assigned`, `team.task.completed`, `team.task.failed`, `team.disbanded`
   - Bottleneck detection: after each task completion, recalculate which completed task has the longest duration

3. **[REFACTOR]** Extract bottleneck calculation into named helper

**Dependencies:** Task 1 (team event types)
**Parallelizable:** Yes (parallel with Tasks 2-3)

---

### Task 5: Register both views + handlers + composite routing

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/views/tools.ts`, `views/composite.ts`, `registry.ts`

1. **[RED]** Write tests:
   - In `views/tools.test.ts`: `handleViewTeamPerformance_WithTeamEvents_ReturnsMaterializedView` — seed event store with `team.task.completed` events, call handler, assert response contains `teammates` data
   - In `views/tools.test.ts`: `handleViewDelegationTimeline_WithTeamEvents_ReturnsTimeline` — seed events, call handler, assert response contains `tasks` array
   - In `views/composite.test.ts`: `handleView_TeamPerformanceAction_DispatchesToHandler` — call `handleView({ action: 'team_performance' })`, assert it doesn't return UNKNOWN_ACTION
   - In `views/composite.test.ts`: `handleView_DelegationTimelineAction_DispatchesToHandler` — call `handleView({ action: 'delegation_timeline', workflowId: 'test' })`, assert success
   - In `registry.test.ts`: `TOOL_REGISTRY_ViewActions_IncludesTeamPerformance` — assert `viewActions` contains action with `name: 'team_performance'`
   - Expected failure: `handleViewTeamPerformance` is not a function; `'team_performance'` is not a valid action

2. **[GREEN]** Wire up:
   - In `tools.ts`: Add `handleViewTeamPerformance()` and `handleViewDelegationTimeline()` handler functions. Register both projections in `createMaterializer()`.
   - In `composite.ts`: Add `case 'team_performance'` and `case 'delegation_timeline'` to switch. Add both to `validTargets` array.
   - In `registry.ts`: Add `team_performance` and `delegation_timeline` actions to `viewActions` array with `ALL_PHASES` and `ROLE_ANY`.

3. **[REFACTOR]** Ensure import ordering follows convention

**Dependencies:** Tasks 2, 3, 4 (projections must exist)
**Parallelizable:** Sequential after Tasks 3 and 4

---

### Task 6: SubagentStart — historical intelligence query helper

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/subagent-context.ts`

1. **[RED]** Write tests in `cli-commands/subagent-context.test.ts`:
   - `queryModuleHistory_EventsExist_ReturnsRelevantEvents` — create temp JSONL file with `workflow.fix-cycle` and `task.completed` events, call `queryModuleHistory('auth')`, assert returns events related to auth module
   - `queryModuleHistory_NoEvents_ReturnsEmptyArray` — empty event store, assert returns `[]`
   - `synthesizeIntelligence_FixCycleEvents_SummarizesPatterns` — pass fix-cycle events, assert formatted string mentions fix cycle count and module name
   - `synthesizeIntelligence_NoEvents_ReturnsEmptyString` — pass empty array, assert returns `''`
   - Expected failure: `queryModuleHistory` is not a function

2. **[GREEN]** Add to `subagent-context.ts`:
   - `queryModuleHistory(stateDir: string, modules: string[]): Promise<WorkflowEvent[]>` — scan JSONL event files for `workflow.fix-cycle`, `task.completed`, `task.failed` events where data contains module references. Use lightweight line-by-line JSON parsing (don't import full EventStore to keep CLI hook fast).
   - `synthesizeIntelligence(events: WorkflowEvent[]): string` — summarize event patterns into a concise hint string (e.g., "auth module: 3 fix cycles in recent workflows. Common issue: missing null checks.")
   - `extractModulesFromCwd(cwd: string): string[]` — extract module names from worktree path (e.g., `/tmp/wt-auth-service` → `['auth-service']`)

3. **[REFACTOR]** Ensure JSONL scanning is bounded (limit to last N lines / last N files)

**Dependencies:** Task 1 (event types for filtering)
**Parallelizable:** Yes (Group C start)

---

### Task 7: Enriched handleSubagentContext with context + team fields

**Phase:** RED → GREEN → REFACTOR

**Module:** Same as Task 6

1. **[RED]** Write tests in `cli-commands/subagent-context.test.ts`:
   - `handleSubagentContext_ActiveWorkflowWithEvents_IncludesContextField` — setup: active workflow state file + JSONL with fix-cycle events. Assert result includes non-empty `context` string
   - `handleSubagentContext_ActiveWorkflowNoEvents_ContextIsEmpty` — setup: active workflow but no events. Assert `context` is empty string
   - `handleSubagentContext_ActiveWorkflowWithTasks_IncludesTeamField` — setup: active workflow with `tasks` array in state. Assert result includes `team` field with formatted task summary
   - `handleSubagentContext_NoActiveWorkflow_NoContextOrTeamFields` — no active workflow, assert `guidance`, `context`, and `team` are all empty strings
   - Expected failure: `context` field not present in result

2. **[GREEN]** Extend `handleSubagentContext()`:
   - After tool guidance filtering (existing), add:
   - Call `extractModulesFromCwd(stdinData.cwd)` to get module context
   - Call `queryModuleHistory(stateDir, modules)` to get relevant events
   - Call `synthesizeIntelligence(events)` to format historical hints
   - Read active workflow state to get current task list for team context
   - Format team context: "N tasks in progress, N completed. Other teammates working on: [module list]"
   - Return `{ guidance, context, team }`

3. **[REFACTOR]** Extract team context formatting into `formatTeamContext()` helper

**Dependencies:** Task 6
**Parallelizable:** Sequential after Task 6

---

### Task 8: TeammateIdle — rich team.task.completed event emission

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/gates.ts`

1. **[RED]** Write tests in `cli-commands/gates.test.ts`:
   - `handleTeammateGate_QualityPasses_EmitsTeamTaskCompletedEvent` — setup: mock quality checks passing, active workflow state with task matching cwd, temp JSONL event file. Assert: after handler returns, event file contains `team.task.completed` event with `taskId`, `teammateName`, `durationMs` > 0, `testsPassed: true`
   - `handleTeammateGate_QualityFails_NoEventEmitted` — setup: mock quality checks failing. Assert: no `team.task.completed` event written
   - `handleTeammateGate_NoMatchingTask_NoEventEmitted` — setup: quality passes, no task matches cwd. Assert: no event written, returns `{ continue: true }`
   - `handleTeammateGate_QualityPasses_EventIncludesChangedFiles` — mock `git diff --name-only` in cwd. Assert: event payload `filesChanged` matches diff output
   - Expected failure: no `team.task.completed` event is emitted

2. **[GREEN]** Extend `handleTeammateGate()`:
   - After quality gates pass AND task status is updated (from #401):
   - Run `git diff --name-only HEAD~1` in cwd to get changed files
   - Calculate `durationMs` from `task.startedAt` to now
   - Append `team.task.completed` event to JSONL via lightweight file append (don't import full EventStore — CLI hooks must stay fast)
   - Include `taskId`, `teammateName` (from input), `durationMs`, `filesChanged`, `testsPassed: true`, `qualityGateResults`

3. **[REFACTOR]** Extract event emission into `emitTeamTaskEvent()` helper for reuse with `team.task.failed`

**Dependencies:** Task 1 (event type validation)
**Parallelizable:** Yes (Group D start)

---

### Task 9: TeammateIdle — follow-up task detection

**Phase:** RED → GREEN → REFACTOR

**Module:** Same as Task 8

1. **[RED]** Write tests in `cli-commands/gates.test.ts`:
   - `findUnblockedTasks_CompletedUnblocksDependents_ReturnsDependents` — state with tasks: A (complete), B (pending, blockedBy: [A]). Assert: `findUnblockedTasks(state, 'A')` returns `[B]`
   - `findUnblockedTasks_DependentStillBlocked_ReturnsEmpty` — state: A (complete), C (pending, blockedBy: [A, D]), D (in_progress). Assert: returns `[]` (C still blocked by D)
   - `findUnblockedTasks_NoDependents_ReturnsEmpty` — state: A (complete), B (pending, no blockedBy). Assert: returns `[]`
   - `handleTeammateGate_UnblockedTasksExist_IncludesInResult` — full handler test: after task completion, assert result includes `unblockedTasks` array
   - Expected failure: `findUnblockedTasks` is not a function

2. **[GREEN]** Add to `gates.ts`:
   - `findUnblockedTasks(state, completedTaskId): Task[]` — scan state.tasks for tasks with `blockedBy` containing `completedTaskId` where ALL other blockers are also complete
   - Extend `handleTeammateGate` return: include `unblockedTasks` field when follow-ups exist

3. **[REFACTOR]** Type the `Task` shape explicitly for blockedBy support

**Dependencies:** Task 8
**Parallelizable:** Sequential after Task 8

---

### Task 10: PreCompact — team composition snapshot

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/pre-compact.ts`

1. **[RED]** Write tests in `cli-commands/pre-compact.test.ts`:
   - `handlePreCompact_DelegatePhaseWithTeamState_CheckpointIncludesTeamState` — setup: active workflow in `delegate` phase with `teamState: { teammates: [{ name: 'worker-1', status: 'active', taskId: 'task-001' }] }`. Assert: checkpoint JSON includes `teamState` field matching input
   - `handlePreCompact_NonDelegatePhase_NoTeamStateInCheckpoint` — setup: active workflow in `review` phase. Assert: checkpoint JSON has no `teamState` field
   - `handlePreCompact_DelegatePhaseNoTeamState_CheckpointOmitsTeamState` — setup: delegate phase but no `teamState` in workflow state. Assert: checkpoint has no `teamState`
   - Expected failure: `teamState` not present in `CheckpointData` interface

2. **[GREEN]** Extend `pre-compact.ts`:
   - Add `readonly teamState?: unknown` to `CheckpointData` interface
   - In checkpoint creation loop: if `state.phase === 'delegate'` and `state.teamState` exists, include `teamState: state.teamState` in checkpoint
   - Update `isCheckpointData` type guard to allow optional `teamState`

3. **[REFACTOR]** None expected

**Dependencies:** None (independent of event schemas)
**Parallelizable:** Yes (Group E)

---

### Task 11: SessionStart — orphaned team recovery detection

**Phase:** RED → GREEN → REFACTOR

**Module:** `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`

1. **[RED]** Write tests in `cli-commands/session-start.test.ts`:
   - `handleSessionStart_DelegatePhaseWithActiveTeammates_IncludesRecoveryInfo` — setup: checkpoint with `phase: 'delegate'`, `teamState: { teammates: [{ name: 'w1', status: 'active' }] }`, tasks with mixed statuses. Assert: workflow info includes `recovery` field with `type: 'orphaned_team'`, `remainingTasks` count > 0
   - `handleSessionStart_DelegatePhaseNoTeamState_NoRecoveryInfo` — setup: delegate phase, no teamState. Assert: no `recovery` field in workflow info
   - `handleSessionStart_CompletedTeammates_NoRecoveryInfo` — setup: teamState with all teammates status `'completed'`. Assert: no `recovery` field
   - `handleSessionStart_ReviewPhaseWithTeamState_NoRecoveryInfo` — setup: review phase with teamState. Assert: no `recovery` (only relevant in delegate phase)
   - Expected failure: `recovery` field not in `WorkflowInfo` type

2. **[GREEN]** Extend `session-start.ts`:
   - Add `readonly recovery?: { type: string; message: string; completedTasks: number; remainingTasks: number }` to `WorkflowInfo` interface
   - In checkpoint processing: if `cp.phase === 'delegate'` and `cp.teamState?.teammates` has any with `status === 'active'`, populate `recovery` field with orphaned team summary
   - In state file discovery: check state file for `teamState` with same logic

3. **[REFACTOR]** Extract orphaned team detection into `detectOrphanedTeam(checkpoint)` helper

**Dependencies:** None (independent of event schemas)
**Parallelizable:** Yes (parallel with Task 10, Group E)

---

### Task 12: Update delegation SKILL.md with adaptive orchestration flow

**Phase:** Content update (no TDD — markdown only)

1. Add **Adaptive Orchestration** section after "Delegation Mode":
   - Pre-delegation intelligence queries (TeamPerformanceView, event history)
   - Team composition informed by historical metrics
   - Guard-aware task graph creation before native task list
   - Event emission at each delegation milestone

2. Add **Agent Teams Event Emission** subsection under "Exarchos Integration":
   - Document orchestrator-emitted events: `team.spawned`, `team.task.assigned`, `team.disbanded`
   - Document hook-emitted events: `team.task.completed`, `team.task.failed`, `team.context.injected`
   - Note that TeammateIdle hook now emits rich events (not just state updates)

3. Add **Intelligence Views** subsection:
   - `exarchos_view team_performance` — query before delegation for team sizing
   - `exarchos_view delegation_timeline` — query after delegation for retrospective

4. Update **Known Limitations** with cold start behavior for TeamPerformanceView

**File:** `skills/delegation/SKILL.md`
**Dependencies:** None
**Parallelizable:** Yes (Group F)

---

### Task 13: Update delegation references with team coordination patterns

**Phase:** Content update (no TDD — markdown only)

1. Update `skills/delegation/references/parallel-strategy.md`:
   - Add **Agent Teams Dispatch Pattern** section with natural language delegation
   - Add comparison table: subagent parallelism vs Agent Teams parallelism
   - Document shared task list coordination model
   - Note one-team-per-session limitation

2. Update `skills/delegation/references/workflow-steps.md`:
   - Add conditional Agent Teams path for Step 4 (Dispatch): natural language team creation
   - Add tmux pane observation for Step 5 (Monitor)
   - Add TeammateIdle hook flow for Step 6 (Collect) with rich event emission

**Files:** `skills/delegation/references/parallel-strategy.md`, `skills/delegation/references/workflow-steps.md`
**Dependencies:** None
**Parallelizable:** Yes (parallel with Task 12, Group F)

---

## Summary

| Group | Tasks | Module | Type | Worktree |
|-------|-------|--------|------|----------|
| A | 1 | Event store schemas | TypeScript + TDD | WT-1 |
| B | 2, 3, 4, 5 | CQRS views | TypeScript + TDD | WT-1 (after A) |
| C | 6, 7 | SubagentStart CLI | TypeScript + TDD | WT-2 |
| D | 8, 9 | TeammateIdle CLI | TypeScript + TDD | WT-3 |
| E | 10, 11 | Lifecycle hooks | TypeScript + TDD | WT-3 |
| F | 12, 13 | Skills (markdown) | Content | WT-4 |

**Total:** 13 tasks across 6 groups, 4 worktrees
**TDD tasks:** 11 (Tasks 1-11)
**Content tasks:** 2 (Tasks 12-13)

## Deferred Items

1. **Event compaction/archival** — Open Question 4 from design. Defer until JSONL growth becomes measurable (>10MB per workflow). Can be addressed as a separate refactor.

2. **Native task list projection API** — Open Question 5 from design. No programmatic task creation API exists in Agent Teams. Orchestrator uses natural language to create tasks. Revisit when Agent Teams API stabilizes.

3. **Hook payload limits** — Open Question 1 from design. Historical intelligence will be capped at 500 chars in `synthesizeIntelligence()`. If insufficient, file-based sidecar can be added later.

4. **TeamPerformanceView cold start** — Open Question 3. Orchestrator falls back to plan's parallel groups for team sizing when no historical data exists. No special implementation needed — the view simply returns empty/zero metrics.

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards (>80% line, >70% branch)
- [ ] 6 new event types in schemas.ts with Zod validation
- [ ] 2 new CQRS views with projections and handlers
- [ ] SubagentStart hook enriched with historical intelligence
- [ ] TeammateIdle hook enriched with event emission + follow-up detection
- [ ] PreCompact checkpoint includes team state
- [ ] SessionStart detects orphaned teams
- [ ] Delegation skill documentation updated
- [ ] Ready for review
