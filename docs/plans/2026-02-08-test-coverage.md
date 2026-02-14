# Implementation Plan: Exarchos MCP Server Test Coverage

## Source
Refactor brief in workflow state: `refactor-test-coverage`

## Scope
**Target:** All low-coverage modules in `plugins/exarchos/servers/exarchos-mcp/src/`
**Excluded:** Root installer (already 100%), workflow/types.ts (type-only file)

## Summary
- Total tasks: 8
- Parallel groups: 4
- Estimated test count: ~60 new test cases
- Coverage target: 88% → 95%+

## Spec Traceability

| Brief Goal | Task ID(s) | Status |
|------------|-----------|--------|
| tasks/tools.ts 65% → 95% | 1 | Planned |
| team/tools.ts 67% → 95% + fix source bugs | 2 | Planned |
| stack/tools.ts 78% → 95% | 3 | Planned |
| views/tools.ts 77% → 95% | 4 | Planned |
| views/materializer.ts 56% func → 90% | 5 | Planned |
| workflow/state-store.ts 77% → 95% | 6 | Planned |
| workflow/state-machine.ts 49% func → 90% | 7 | Planned |
| workflow/compensation.ts 86% → 95% | 8 | Planned |

## Task Breakdown

### Task 1: tasks/tools.ts coverage — validation and error paths

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/tasks/tools.test.ts`:
   - `handleTaskClaim_MissingAgentId_ReturnsInvalidInput`
   - `handleTaskClaim_StoreAppendFails_ReturnsClaimFailed`
   - `handleTaskComplete_StoreAppendFails_ReturnsCompleteFailed`
   - `handleTaskComplete_PartialFields_OmitsMissingFromEvent`
   - `handleTaskFail_StoreAppendFails_ReturnsFailFailed`
   - `handleTaskFail_NonErrorException_ReturnsStringifiedMessage`
   - Run: `npx vitest run src/tasks/tools.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — these paths exist but lack tests
   - Run: `npx vitest run src/tasks/tools.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: team/tools.ts coverage — fix missing validations + test error paths

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/team/tools.test.ts`:
   - `handleTeamSpawn_WhitespaceOnlyName_ReturnsInvalidInput`
   - `handleTeamSpawn_EmptyTaskTitle_ReturnsInvalidInput`
   - `handleTeamMessage_WhitespaceFrom_ReturnsInvalidInput`
   - `handleTeamMessage_WhitespaceTo_ReturnsInvalidInput`
   - `handleTeamMessage_WhitespaceContent_ReturnsInvalidInput`
   - `handleTeamBroadcast_CoordinatorThrows_ReturnsBroadcastFailed`
   - `handleTeamShutdown_CoordinatorThrows_ReturnsShutdownFailed`
   - `handleTeamStatus_CoordinatorThrows_ReturnsStatusFailed`
   - Run: `npx vitest run src/team/tools.test.ts` — MUST FAIL (some tests fail because source validation is missing)

2. [GREEN] Fix source in `src/team/tools.ts`:
   - Add `streamId` validation in `handleTeamMessage` (line ~145)
   - Add `streamId` validation in `handleTeamBroadcast` (line ~172)
   - Add `streamId` validation in `handleTeamShutdown` (line ~213)
   - Add whitespace-trimmed validation where missing
   - Run: `npx vitest run src/team/tools.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 3: stack/tools.ts coverage — position validation and error handling

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/stack/tools.test.ts`:
   - `handleStackPlace_NegativePosition_ReturnsInvalidInput`
   - `handleStackPlace_FloatPosition_ReturnsInvalidInput`
   - `handleStackPlace_NaNPosition_ReturnsInvalidInput`
   - `handleStackPlace_StoreAppendFails_ReturnsPlaceFailed`
   - `handleStackStatus_StoreQueryFails_ReturnsStatusFailed`
   - `handleStackPlace_MinimalFields_IncludesOnlyRequired`
   - Run: `npx vitest run src/stack/tools.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — validation paths exist
   - Run: `npx vitest run src/stack/tools.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: views/tools.ts coverage — error handling and filter edge cases

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/views/tools.test.ts`:
   - `handleViewTasks_MaterializerThrows_ReturnsViewError`
   - `handleViewTasks_EmptyFilterObject_ReturnsAllTasks`
   - `handleViewTasks_FilterMatchesNothing_ReturnsEmptyArray`
   - `handleViewPipeline_DiscoveryFails_ReturnsViewError`
   - `handleViewPipeline_NoStreams_ReturnsEmptyWorkflows`
   - `handleViewTeamStatus_CoordinatorThrows_ReturnsViewError`
   - `handleViewWorkflowStatus_InvalidWorkflowId_ReturnsGracefulError`
   - Run: `npx vitest run src/views/tools.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — error paths exist
   - Run: `npx vitest run src/views/tools.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 5: views/materializer.ts coverage — uncovered functions and snapshot logic

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/views/materializer.test.ts`:
   - `hasProjection_RegisteredView_ReturnsTrue`
   - `hasProjection_UnregisteredView_ReturnsFalse`
   - `getProjection_RegisteredView_ReturnsInstance`
   - `getProjection_UnregisteredView_ReturnsUndefined`
   - `materialize_SnapshotIntervalCrossed_CreatesSnapshot`
   - `materialize_SnapshotIntervalNotCrossed_SkipsSnapshot`
   - `materialize_SnapshotSaveFails_ContinuesGracefully`
   - `loadFromSnapshot_CorruptSnapshot_ReturnsFalse`
   - `loadState_ValidState_PopulatesView`
   - `materialize_NoSnapshotStore_SkipsSnapshotting`
   - Run: `npx vitest run src/views/materializer.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — functions exist but untested
   - Run: `npx vitest run src/views/materializer.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 6: workflow/state-store.ts coverage — file I/O edge cases and git fallback

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/workflow/state-store.test.ts`:
   - `listStateFiles_CorruptFileInDir_ReturnsOnlyValidFiles`
   - `listStateFiles_ReadDirFails_ReturnsEmptyArray`
   - `listStateFiles_MixedFiles_ProcessesOnlyStateJson`
   - `resolveStateDir_GitCommandFails_FallsBackToCwd`
   - `initStateFile_MkdirFails_ThrowsStateStoreError`
   - `writeStateFile_TempWriteFails_CleansUpTempFile`
   - `writeStateFile_RenameFails_CleansUpTempFile`
   - `readStateFile_ReservedFieldInUpdate_ThrowsError`
   - Run: `npx vitest run src/workflow/state-store.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — edge cases exist in source
   - Run: `npx vitest run src/workflow/state-store.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 7: workflow/state-machine.ts coverage — execution logic and HSM transitions

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/workflow/state-machine.test.ts`:
   - `executeTransition_InvalidWorkflowType_ReturnsError`
   - `executeTransition_GuardThrowsException_ReturnsError`
   - `executeTransition_NoValidTransitions_ReturnsError`
   - `getValidTransitions_AtomicState_ReturnsCorrectTransitions`
   - `getValidTransitions_CompoundState_ReturnsCorrectTransitions`
   - `debugHSM_InvestigateToRca_ThoroughTrack`
   - `debugHSM_InvestigateToHotfixImplement_HotfixTrack`
   - `refactorHSM_BriefToPolishImplement_PolishTrack`
   - `refactorHSM_BriefToOverhaulPlan_OverhaulTrack`
   - `featureHSM_BlockedStateWithHumanUnblocked_Transitions`
   - `executeTransition_CompoundStateEntry_TriggersOnEntryEffect`
   - `executeTransition_CompoundStateExit_TriggersOnExitEffect`
   - `executeTransition_IncrementFixCycleEffect_UpdatesCounter`
   - Run: `npx vitest run src/workflow/state-machine.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — transition logic exists
   - Run: `npx vitest run src/workflow/state-machine.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 8: workflow/compensation.ts coverage — partial failures and unknown phases

**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Write tests in `src/workflow/compensation.test.ts`:
   - `deleteFeatureBranchesAction_LocalSuccessRemoteFails_ReturnsExecuted`
   - `deleteFeatureBranchesAction_LocalFailsRemoteSucceeds_ReturnsExecuted`
   - `deleteIntegrationBranchAction_PartialFailure_ReturnsExecuted`
   - `getPhasesInReverseOrder_UnknownPhase_ReturnsAllPhases`
   - `executeCompensation_UnknownCurrentPhase_ExecutesAllActions`
   - `closePrAction_NullPrUrl_ReturnsSkipped`
   - `executeCompensation_UndefinedStateDir_UsesCwd`
   - Run: `npx vitest run src/workflow/compensation.test.ts` — MUST FAIL

2. [GREEN] No source changes needed — paths exist but untested
   - Run: `npx vitest run src/workflow/compensation.test.ts` — MUST PASS

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

All 8 tasks are independent — they modify different test files targeting different source modules. They can all run in parallel worktrees.

### Parallel Group 1 (Tool Handlers)
- Task 1: tasks/tools.ts
- Task 2: team/tools.ts (includes source fix)
- Task 3: stack/tools.ts
- Task 4: views/tools.ts

### Parallel Group 2 (Core Infrastructure)
- Task 5: views/materializer.ts
- Task 6: workflow/state-store.ts
- Task 7: workflow/state-machine.ts
- Task 8: workflow/compensation.ts

All 8 tasks can run simultaneously since they touch disjoint files.

## Deferred Items

- `workflow/types.ts` — 0% coverage but contains only TypeScript type definitions (no runtime code)
- `event-store/tools.ts` — 88% coverage, marginal improvement not worth the effort
- `views/snapshot-store.ts` — 84% coverage, snapshot edge cases are secondary

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage >= 95% statements overall
- [ ] Function coverage >= 85% for all files
- [ ] team/tools.ts source bugs fixed
- [ ] Ready for review
