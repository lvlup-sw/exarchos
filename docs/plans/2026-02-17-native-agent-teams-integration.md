# Implementation Plan: Native Agent Teams Integration

## Source Design
Link: `docs/designs/2026-02-17-native-agent-teams-integration.md`

## Scope
**Target:** Full design — all 7 Technical Design sections
**Excluded:** None

## Summary
- Total tasks: 10
- Parallel groups: 3
- Estimated test count: 37
- Design coverage: 8 of 8 sections covered

## Spec Traceability

### Scope Declaration

**Target:** Full design
**Excluded:** None

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Technical Design > 1. Correlation Model | - `nativeTaskId`, `teammateName`, `blockedBy` on TaskSchema<br>- Team name = featureId convention | 001, 007 | Covered |
| Technical Design > 2. Delegation Saga | - Six-step saga with compensation<br>- Event-first ordering<br>- Pivot transaction identified<br>- Idempotency checks per step | 007 | Covered |
| Technical Design > 3. Event-First Dispatch Sequence | - `team.task.planned` event type<br>- `team.teammate.dispatched` event type<br>- `batch_append` for Step 2 batched events<br>- Saga step sequence in skill | 002, 003, 007 | Covered |
| Technical Design > 4. Teammate Spawn Prompt | - Native API coordination section<br>- Exarchos MCP workflow intelligence section<br>- Historical context + team context populated at spawn time (not by hooks) | 008 | Covered |
| Technical Design > 5. Hook Changes | - TeammateIdle: single-writer (emit events only, no state mutation)<br>- SubagentStart: live data only (no historical re-injection)<br>- SessionStart: native team directory detection (both path formats) | 004, 005, 006 | Covered |
| Technical Design > 6. Saga Compensation | - Compensation table per step with idempotency checks<br>- Pivot transaction at Step 3<br>- Compensable vs retryable classification | 007 | Covered |
| Technical Design > 7. State Consistency Model | - Single-writer: orchestrator only for workflow.tasks[]<br>- Reconciliation via workflow reconcile extension<br>- Single-orchestrator invariant<br>- Reconstructibility invariant<br>- Append-only immutability | 004, 009 | Covered |
| Technical Design > 8. Eventual Consistency Windows | - Staleness windows per layer documented<br>- Agent behavior on stale reads specified<br>- Acceptable staleness rationale | — | Covered (design-level, no task needed) |
| Integration Points > Changes Needed | - All 8 changed components traced to tasks | 001-010 | Covered |
| Testing Strategy > Unit Tests | - batch_append tests<br>- Event schema validation<br>- Single-writer compliance<br>- Hook deduplication tests | 001-006, 009 | Covered |
| Testing Strategy > Validation Scripts | - `verify-delegation-saga.sh`<br>- Extended `post-delegation-check.sh` | 010 | Covered |
| Open Questions > 1. TaskCreate return value | Design assumes ID returned | — | Deferred: validate at integration time |
| Open Questions > 2. Team cleanup timing | Shutdown before delete | — | Deferred: handled by skill instructions |
| Open Questions > 3. Delegate mode enforcement | UI action, not API | — | Deferred: orchestrator constraint rule sufficient |
| Open Questions > 4. Native task dependencies | Sequential TaskCreate + wire dependencies | — | Covered in Task 007 |

## Task Breakdown

### Task 001: Extend WorkflowTask schema with native correlation fields

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `TaskSchema_WithNativeTaskId_AcceptsOptionalString`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/__tests__/schemas.test.ts`
   - Additional tests:
     - `TaskSchema_WithTeammateName_AcceptsOptionalString`
     - `TaskSchema_WithBlockedBy_AcceptsStringArray`
     - `TaskSchema_WithBlockedBy_DefaultsToEmptyArray`
   - Expected failure: Zod schema rejects unknown fields `nativeTaskId`, `teammateName`, `blockedBy`
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add optional fields to TaskSchema
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/schemas.ts`
   - Changes: Add `nativeTaskId: z.string().optional()`, `teammateName: z.string().optional()`, `blockedBy: z.array(z.string()).default([])`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Update WorkflowTask type exports if needed
   - Ensure `types.ts` re-exports the inferred type
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A — foundation)

---

### Task 002: Add team.task.planned and team.teammate.dispatched event schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EventSchema_TeamTaskPlanned_ValidatesPayload`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/__tests__/schemas.test.ts`
   - Additional tests:
     - `EventSchema_TeamTaskPlanned_RejectsWithoutTaskId`
     - `EventSchema_TeamTeammateDispatched_ValidatesPayload`
     - `EventSchema_TeamTeammateDispatched_RejectsWithoutTeammateName`
     - `EventSchema_TeamTaskPlanned_IncludedInEventTypeUnion`
     - `EventSchema_TeamTeammateDispatched_IncludedInEventTypeUnion`
   - Expected failure: Event type union doesn't include `team.task.planned` or `team.teammate.dispatched`
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add event type schemas
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes:
     - Add `team.task.planned` to EventType union with data schema: `{ taskId: string, title: string, modules: string[], blockedBy: string[] }`
     - Add `team.teammate.dispatched` to EventType union with data schema: `{ teammateName: string, worktreePath: string, assignedTaskIds: string[], model: string }`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Ensure data schemas follow existing pattern (optional fields for forward compat)
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A — foundation)

---

### Task 003: Event store — add batch_append action

**Phase:** RED → GREEN → REFACTOR

**Rationale:** The design prescribes batched event emission for Step 2 (N task planning events in one MCP call). Without this, emitting 6 events individually costs ~1,020 tokens of envelope overhead (170 tokens/call). `batch_append` reduces this to ~334 tokens (single envelope + batch response), saving ~686 tokens per delegation cycle.

**TDD Steps:**
1. [RED] Write tests:
   - `batchAppend_MultipleEvents_AppendsAllWithSequentialSequenceNumbers`
   - `batchAppend_EmptyArray_ReturnsError`
   - `batchAppend_IdempotencyKey_DeduplicatesAcrossBatch`
   - `batchAppend_PartialFailure_AtomicRollback`
   - `batchAppend_ConcurrentWrite_RespectsOptimisticConcurrency`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/__tests__/tools.test.ts`
   - Expected failure: `batch_append` action doesn't exist in event tools
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement batch_append action
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/tools.ts`
   - Changes:
     - Add `batch_append` to action enum in event tool schema
     - Accept `events: Event[]` (array) alongside existing `event: Event` (single)
     - Append all events atomically to the JSONL file with sequential sequence numbers
     - Validate all events against schema before appending any (all-or-nothing)
     - Return array of appended sequence numbers
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract shared append logic between `append` and `batch_append` to avoid duplication
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 002 (event schemas for new types used in batches)
**Parallelizable:** Yes (Group A — foundation, same worktree as 001+002)

---

### Task 004: TeammateIdle hook — single-writer compliance and team config correlation

**Phase:** RED → GREEN → REFACTOR

**Rationale:** The audit found that both the orchestrator and TeammateIdle hook mutate `workflow.tasks[]`, causing CAS races and violating event sourcing's single-writer principle. This task converts the hook to emit events only.

**TDD Steps:**
1. [RED] Write tests:
   - `readTeamConfig_ValidConfig_ReturnsMembersArray`
   - `readTeamConfig_DirectoryFormat_ReturnsConfig`
   - `readTeamConfig_FlatFileFormat_ReturnsConfig`
   - `readTeamConfig_MissingFile_ReturnsNull`
   - `readTeamConfig_MalformedJson_ReturnsNull`
   - `resolveTeammateFromConfig_MatchesByWorktreePath_ReturnsTeammateName`
   - `resolveTeammateFromConfig_NoMatch_ReturnsFallbackFromInput`
   - `handleTeammateGate_OnQualityPass_EmitsEventOnly`
   - `handleTeammateGate_OnQualityPass_DoesNotMutateWorkflowState`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/__tests__/gates.test.ts`
   - Expected failure: `readTeamConfig` doesn't exist; `handleTeammateGate` still calls `commitTaskCompletion`
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement team config reading and remove state mutation
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/gates.ts`
   - Changes:
     - Add `readTeamConfig(featureId: string)`: try `~/.claude/teams/{featureId}/config.json` then `~/.claude/teams/{featureId}.json`, return parsed config or null
     - Add `resolveTeammateFromConfig(config, cwd, inputName?)`: match cwd to teammate worktree, fall back to input name
     - Remove `commitTaskCompletion()` call from `handleTeammateGate()` — hook emits `team.task.completed` event only
     - Retain circuit breaker and quality gate logic unchanged
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract team config reading to shared utility (reused by tasks 005, 006)
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements
- [ ] Confirm: `commitTaskCompletion()` is NOT called from any hook path

**Dependencies:** Task 001 (TaskSchema.teammateName field)
**Parallelizable:** Yes (Group B — hooks, parallel with 005, 006)

---

### Task 005: SubagentStart hook — live data only (deduplication)

**Phase:** RED → GREEN → REFACTOR

**Rationale:** The audit found that SubagentStart re-injects historical intelligence (~125 tokens) and team context (~30 tokens) already present in the spawn prompt. Across 3 teammates, this wastes ~465 tokens. More significantly, the hook fires for every teammate sub-subagent during monitoring — skipping injection entirely for these eliminates the largest actual token sink.

**TDD Steps:**
1. [RED] Write tests:
   - `readNativeTaskList_ExistingDir_ReturnsTaskStatuses`
   - `readNativeTaskList_MissingDir_ReturnsEmptyArray`
   - `handleSubagentContext_DoesNotCallQueryModuleHistory`
   - `handleSubagentContext_DoesNotCallSynthesizeIntelligence`
   - `handleSubagentContext_DoesNotInjectStaticTeamContext`
   - `handleSubagentContext_InjectsLiveTaskStatusChanges`
   - `handleSubagentContext_RetainsToolGuidance`
   - `handleSubagentContext_SkipsInjectionForTeammateSubSubagentsDuringDelegate`
   - `isTeammateSubSubagent_WorktreeCwdDuringDelegate_ReturnsTrue`
   - `isTeammateSubSubagent_OrchestratorCwd_ReturnsFalse`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/__tests__/subagent-context.test.ts`
   - Expected failure: handler still calls `queryModuleHistory` and `synthesizeIntelligence`; no sub-subagent detection
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Remove redundant context injection, add live task status
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/subagent-context.ts`
   - Changes:
     - Remove `queryModuleHistory()` and `synthesizeIntelligence()` calls from `handleSubagentContext()` — this data is in the spawn prompt
     - Remove static team context from `formatTeamContext()` — this data is in the spawn prompt
     - Add `readNativeTaskList(featureId)`: read `~/.claude/tasks/{featureId}/`, return current task statuses
     - Replace team context with `formatLiveCoordinationData()`: only inject current task statuses (what changed since spawn) and newly unblocked tasks
     - Add `isTeammateSubSubagent(cwd, phase)`: detect if SubagentStart event is from a teammate's subprocess (cwd inside a worktree + phase is `delegate`). If true, skip all injection — teammate sub-subagents inherit context from their parent.
     - Retain `filterToolsForPhaseAndRole()` and `formatToolGuidance()` — these are NOT in the spawn prompt
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up unused imports and functions if `queryModuleHistory`/`synthesizeIntelligence` are now dead code
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements
- [ ] Confirm: `queryModuleHistory` and `synthesizeIntelligence` are NOT called from hook path
- [ ] Confirm: teammate sub-subagents during delegate phase receive no injected context

**Dependencies:** None
**Parallelizable:** Yes (Group B — hooks, parallel with 004, 006)

---

### Task 006: SessionStart hook — native team directory detection

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `detectNativeTeam_DirectoryFormat_ReturnsTeamInfo`
   - `detectNativeTeam_FlatFileFormat_ReturnsTeamInfo`
   - `detectNativeTeam_MissingDir_ReturnsNull`
   - `detectNativeTeam_EmptyConfig_ReturnsNull`
   - `handleSessionStart_OrphanedNativeTeam_IncludesCleanupRecommendation`
   - `handleSessionStart_NativeTeamMatchesActiveWorkflow_NoWarning`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/__tests__/session-start.test.ts`
   - Expected failure: `detectNativeTeam` doesn't check `~/.claude/teams/` directory
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement native team directory detection
   - File: `plugins/exarchos/servers/exarchos-mcp/src/cli-commands/session-start.ts`
   - Changes:
     - Add `detectNativeTeam(featureId: string)`: try both `~/.claude/teams/{featureId}/config.json` and `~/.claude/teams/{featureId}.json`; read member list; return team info or null
     - Enhance `handleSessionStart()`: after finding active workflows, check for corresponding native team directories; if team exists but workflow is past delegation phase, include cleanup recommendation
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Reuse shared team config reading utility from Task 004 if available
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group B — hooks, parallel with 004, 005)

---

### Task 007: Delegation SKILL.md — event-first saga with batched events and tiered monitoring

**Phase:** Content (no TDD — Markdown)

**Steps:**
1. Read current SKILL.md dispatch flow sections
2. Rewrite Agent Teams dispatch flow with event-first ordering:
   - Step 1: Emit `team.spawned` → `TeamCreate(featureId)`. Idempotency: check team dir exists before retry.
   - Step 2: Emit `team.task.planned` × N via `batch_append` (single MCP call) → `TaskCreate` × N → wire `addBlockedBy` → store `nativeTaskId`. Idempotency: check `TaskList` before retry.
   - Step 3 (PIVOT): Emit `team.teammate.dispatched` × N → `Task(team_name: featureId)` × N. Note: point of no return.
   - Step 4: Tiered monitoring — `workflow_status` for routine (30-60s), `delegation_timeline` on-demand only. Orchestrator reads `team.task.completed` events and updates `workflow.tasks[]` (single-writer).
   - Step 5: Emit `team.disbanded` → shutdown + `TeamDelete`
   - Step 6: Transition to review via `exarchos_workflow set`
3. Add saga compensation table with idempotency checks per step
4. Document pivot transaction at Step 3 with rationale
5. Add pre-delegation intelligence query sequence (TeamPerformanceView)
6. Add task dependency wiring instructions (sequential TaskCreate, then addBlockedBy)
7. Ensure backward compatibility: subagent mode dispatch flow unchanged

**Verification:**
- [ ] All 6 saga steps documented with event + side effect
- [ ] Compensation table includes idempotency checks
- [ ] Pivot transaction explicitly identified at Step 3
- [ ] Monitoring uses tiered strategy (workflow_status for polling, delegation_timeline on-demand)
- [ ] Step 2 uses `batch_append` not individual `append` calls
- [ ] Single-writer: orchestrator updates workflow.tasks[], NOT hooks
- [ ] Native API calls use exact tool names (TeamCreate, TaskCreate, TaskUpdate, SendMessage, TeamDelete)
- [ ] Event types match schema (team.spawned, team.task.planned, team.teammate.dispatched, team.disbanded)

**Dependencies:** Tasks 001, 002, 003 (types, event schemas, batch_append must be defined)
**Parallelizable:** Yes (Group C — content, parallel with 008)

---

### Task 008: Implementer prompt template — native API and Exarchos tool guidance

**Phase:** Content (no TDD — Markdown)

**Steps:**
1. Read current implementer-prompt.md
2. Add "Coordination (Native APIs)" section:
   - `TaskList` — see available tasks and statuses
   - `TaskUpdate` — mark tasks `in_progress` / `completed`
   - `SendMessage` — communicate with teammates and lead
3. Add "Workflow Intelligence (Exarchos MCP)" section:
   - `exarchos_workflow get` — query workflow state
   - `exarchos_view tasks` — task details across team
   - `exarchos_event append` — report TDD phase transitions
4. Add "Team Context" section (populated at spawn time by orchestrator — NOT by SubagentStart hook)
5. Add "Historical Context" section (populated at spawn time by orchestrator — NOT by SubagentStart hook)
6. Note in both sections: "This data is injected at spawn time. The SubagentStart hook provides only live coordination updates (task status changes, newly unblocked tasks)."

**Verification:**
- [ ] Native API section covers TaskList, TaskUpdate, SendMessage
- [ ] Exarchos section covers workflow get, view tasks, event append
- [ ] Team Context and Historical Context populated at spawn time
- [ ] Clear note that hooks provide live updates only, not redundant re-injection
- [ ] No TDD process change (still Red-Green-Refactor)

**Dependencies:** None
**Parallelizable:** Yes (Group C — content, parallel with 007)

---

### Task 009: Workflow reconcile — extend with native task status reconciliation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write tests:
   - `reconcileTasks_DriftDetected_EmitsCorrectionEvent`
   - `reconcileTasks_NativeCompleted_WorkflowPending_FixesStatus`
   - `reconcileTasks_NoNativeTaskList_SkipsReconciliation`
   - `reconcileTasks_AllConsistent_ReturnsCleanReport`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/__tests__/query.test.ts`
   - Expected failure: `reconcileTasks` function doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement task reconciliation in workflow reconcile action
   - File: `plugins/exarchos/servers/exarchos-mcp/src/workflow/query.ts`
   - Changes:
     - Add `reconcileTasks(state, nativeTaskDir)`: reads native task files from `~/.claude/tasks/{featureId}/`, compares with `workflow.tasks[]`, returns drift report with correction events
     - Wire into existing `handleReconcile()`: after worktree/branch reconciliation, run task reconciliation if `workflow.tasks[].nativeTaskId` exists
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Share native task reading logic with subagent-context.ts (`readNativeTaskList`)
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Tasks 001, 005 (TaskSchema fields + readNativeTaskList utility)
**Parallelizable:** No (depends on Group A + B)

---

### Task 010: Validation script — verify-delegation-saga.sh

**Phase:** RED → GREEN (bash script with co-located test)

**TDD Steps:**
1. [RED] Write test: `verify-delegation-saga.test.sh`
   - File: `scripts/verify-delegation-saga.test.sh`
   - Test cases:
     - Valid saga: events in correct order → exit 0
     - Missing team.spawned before team.task.planned → exit 1
     - Missing compensation events after failure → exit 1
     - Empty event stream → exit 2
     - Batched team.task.planned events validate correctly → exit 0
   - Expected failure: script doesn't exist
   - Run: `bash scripts/verify-delegation-saga.test.sh` - MUST FAIL

2. [GREEN] Implement validation script
   - File: `scripts/verify-delegation-saga.sh`
   - Behavior:
     - Reads event stream JSONL for a given featureId
     - Verifies event ordering: `team.spawned` before `team.task.planned` before `team.teammate.dispatched`
     - Verifies all planned tasks have corresponding teammate dispatch events
     - Handles batched events (multiple team.task.planned at same sequence range)
     - Exit 0 on valid, exit 1 on violations, exit 2 on usage error
   - Run: `bash scripts/verify-delegation-saga.test.sh` - MUST PASS

**Verification:**
- [ ] Script validates correct saga ordering
- [ ] Script handles batched events correctly
- [ ] Script detects missing or out-of-order events
- [ ] Exit codes match convention (0/1/2)

**Dependencies:** Task 002 (event schemas define valid types)
**Parallelizable:** Yes (Group C — independent)

---

## Parallelization Strategy

```
Group A (Foundation — run first):
  ├── Task 001: Extend WorkflowTask schema         [worktree: wt-schemas]
  ├── Task 002: Add event type schemas              [worktree: wt-schemas]
  └── Task 003: Event store batch_append action     [worktree: wt-schemas]
      (same worktree — all touch files in the MCP server module)

Group B (Hooks — run after Group A):
  ├── Task 004: TeammateIdle single-writer + config [worktree: wt-gates]
  ├── Task 005: SubagentStart live data only        [worktree: wt-subagent]
  └── Task 006: SessionStart team detection         [worktree: wt-session]
      (parallel — each hook is in a separate file)

Group C (Content + Reconcile — run after Group B):
  ├── Task 007: Delegation SKILL.md rewrite         [worktree: wt-skill]
  ├── Task 008: Implementer prompt update           [worktree: wt-skill]
  ├── Task 009: Workflow reconcile extension         [worktree: wt-reconcile]
  └── Task 010: Validation script                   [worktree: wt-scripts]
      (parallel — independent files)

Dependency Graph:
  001 ──┬──> 004 ──┐
        │          ├──> 007
  002 ──┤──> 005 ──┤      ├──> 009
        │          ├──> 008
  003 ──┤──> 006 ──┘
        │              └──> 010
        └──────────────────────┘
```

## Audit Revisions Incorporated

| Audit Finding | Severity | Resolution | Task(s) |
|---------------|----------|------------|---------|
| Event emission overhead (15 MCP calls) | HIGH | Added `batch_append` action — Step 2 uses single call for N events | 003 |
| State update double-writes (CAS races) | HIGH | Single-writer: hooks emit events only, orchestrator owns state | 004, 007 |
| Hook/prompt redundancy (~465 tokens + repeated sub-subagent firings) | MEDIUM-HIGH | SubagentStart injects live data only, no historical re-injection. Skip injection entirely for teammate sub-subagents during monitoring. | 005, 008 |
| Saga pivot transaction not identified | MEDIUM | Documented pivot at Step 3 with idempotency checks | 007 |
| Monitoring triple-read | MEDIUM | Tiered monitoring: `workflow_status` (~85 tokens) routine, `delegation_timeline` (~120 tokens) on-demand | 007 |
| Team config path ambiguity | LOW | Handle both directory and flat file formats in all hooks | 004, 005, 006 |

## Deferred Items

| Item | Rationale |
|------|-----------|
| TaskCreate return value validation | Can only validate at integration time when Agent Teams is running. Design assumption: tool returns task ID. Fallback: match by subject string. |
| Team cleanup timing (poll vs. timeout) | Handled by skill instructions (shutdown requests + wait). No code needed unless timeout enforcement is required. |
| Delegate mode enforcement | UI action (Shift+Tab). Orchestrator constraint rule provides sufficient enforcement. No programmatic API exists. |
| Basileus event projection | Out of scope — forward compatibility preserved via self-contained event payloads. Phase 4 work per ADR. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Single-writer compliance verified (hooks don't mutate workflow.tasks[])
- [ ] SubagentStart deduplication verified (no historical/team re-injection, sub-subagent skip)
- [ ] batch_append action functional with atomic semantics
- [ ] Code coverage meets standards
- [ ] Typecheck passes (`npm run typecheck`)
- [ ] Delegation skill documents full saga with batched events and tiered monitoring
- [ ] Implementer prompt includes native API + Exarchos tool guidance
- [ ] Validation script verifies saga event ordering (including batched events)
- [ ] Ready for review
