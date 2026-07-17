# Implementation Plan: Codebase Audit + Fix Sprint

**Design:** `docs/designs/2026-02-21-codebase-audit-fix.md`
**Issues:** #660, #563, #568
**Feature ID:** `codebase-audit-fix`

---

## Parallelization Strategy

```
Worktree A (Event Hygiene)         ──── Tasks 1-2   ── independent
Worktree B (Telemetry Auto-Corr)   ──── Tasks 3-6   ── independent
Worktree C (Integration Tests)     ──── Tasks 7-9   ── independent
Worktree D (Script Test Companions) ── Tasks 10-12  ── independent
```

All 4 worktrees are fully independent — no cross-dependencies.

---

## Worktree A: Event Hygiene

### Task 1: Annotate orphan event types with @planned markers
**Phase:** GREEN (no behavioral change, documentation only)

1. [GREEN] Add `/** @planned — not yet emitted in production */` JSDoc to 7 orphan events in schema
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Events: `stack.restacked`, `team.disbanded`, `team.context.injected`, `quality.regression`, `review.finding`, `review.escalated`, `quality.hint.generated`

2. [GREEN] Verify existing tests still pass (no schema shape change)

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 2: Add tests for 3 untested production event emissions
**Phase:** RED → GREEN

1. [RED] Write test: `EmitTeamTaskEvent_CircuitBreakerOpened_EmitsTeamTaskFailedEvent`
   - File: `servers/exarchos-mcp/src/cli-commands/gates.test.ts` (new or existing)
   - Expected failure: No test exists for team.task.failed emission path
   - Verify: event shape includes `taskId`, `teammateName`, `failureReason`, `gateResults`

2. [RED] Write test: `HandleSet_CASExhaustedAfterMaxRetries_EmitsWorkflowCasFailedEvent`
   - File: `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (add to existing)
   - Expected failure: No test covers CAS retry exhaustion → event emission
   - Verify: event has `featureId`, `phase`, `retries: 3`

3. [RED] Write test: `HandleReviewTriage_DispatchedPR_EmitsReviewRoutedEvent`
   - File: `servers/exarchos-mcp/src/review/tools.test.ts` (new or existing)
   - Expected failure: No test covers review.routed emission
   - Verify: event has `pr`, `riskScore`, `factors`, `destination`, `velocityTier`

4. [GREEN] Tests should pass against existing production code (events are already emitted, just untested). If mocking is needed for EventStore.append, use `vi.mock()`.

**Dependencies:** None
**Parallelizable:** Yes

---

## Worktree B: Telemetry Auto-Correction (#568)

### Task 3: Extract threshold constants from hints.ts into constants.ts
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `ThresholdConstants_AllHintThresholds_ExportedFromConstants`
   - File: `servers/exarchos-mcp/src/telemetry/constants.test.ts` (new)
   - Expected failure: constants not yet exported
   - Verify: `VIEW_TASKS_BYTES_THRESHOLD`, `WORKFLOW_GET_BYTES_THRESHOLD`, `EVENT_QUERY_BYTES_THRESHOLD`, `WORKFLOW_SET_DURATION_THRESHOLD`, `EVENT_QUERY_INVOCATION_THRESHOLD`, `ERROR_RATE_THRESHOLD`, `TEAM_STATUS_INVOCATION_THRESHOLD`, `CONSISTENCY_WINDOW_SIZE` are all exported numbers

2. [GREEN] Move threshold constants from `hints.ts` to `constants.ts`, add `CONSISTENCY_WINDOW_SIZE = 5`
   - File: `servers/exarchos-mcp/src/telemetry/constants.ts`

3. [REFACTOR] Update `hints.ts` to import from `constants.ts`
   - File: `servers/exarchos-mcp/src/telemetry/hints.ts`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 4: Build auto-correction rules engine
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `MatchCorrectionRule_ViewTasksExceedsThreshold_NoFields_ReturnsFieldsCorrection`
   - File: `servers/exarchos-mcp/src/telemetry/auto-correction.test.ts` (new)
   - Expected failure: module does not exist
   - Input: toolName `exarchos_view`, action `tasks`, args without `fields`, metrics with p95Bytes > 1200 for 5+ calls
   - Expected: correction `{ param: 'fields', value: ['id','title','status','assignee'] }`

2. [RED] Write test: `MatchCorrectionRule_EventQueryExceedsThreshold_NoLimit_ReturnsLimitCorrection`
   - Same file
   - Input: toolName `exarchos_event`, action `query`, args without `limit`, metrics with p95Bytes > 2000
   - Expected: correction `{ param: 'limit', value: 50 }`

3. [RED] Write test: `MatchCorrectionRule_WorkflowGetExceedsThreshold_NoFieldsNoQuery_ReturnsFieldsCorrection`
   - Same file
   - Input: toolName `exarchos_workflow`, action `get`, args without `fields` or `query`
   - Expected: correction `{ param: 'fields', value: ['phase','tasks','artifacts'] }`

4. [RED] Write test: `MatchCorrectionRule_ExplicitFieldsProvided_ReturnsNull`
   - Same file — additive-only constraint
   - Input: args already has `fields`, metrics exceed threshold
   - Expected: no correction (returns null)

5. [RED] Write test: `MatchCorrectionRule_BelowConsistencyWindow_ReturnsNull`
   - Same file — consistency window constraint
   - Input: metrics with only 3 consecutive breaches (below CONSISTENCY_WINDOW_SIZE of 5)
   - Expected: no correction

6. [RED] Write test: `ApplyCorrections_SkipAutoCorrection_ReturnsOriginalArgs`
   - Same file — opt-out constraint
   - Input: args with `skipAutoCorrection: true`
   - Expected: args returned unchanged

7. [GREEN] Implement `auto-correction.ts`:
   - File: `servers/exarchos-mcp/src/telemetry/auto-correction.ts`
   - Export `CorrectionRule` interface: `{ toolName, action, param, threshold, defaultValue, check }`
   - Export `CORRECTION_RULES: CorrectionRule[]` — 3 rules matching design
   - Export `matchCorrection(toolName, action, args, metrics): Correction | null`
   - Export `applyCorrections(args, corrections): { args, applied }`
   - Imports thresholds from `constants.ts`

**Dependencies:** Task 3
**Parallelizable:** Yes (within worktree, sequential with Task 3)

---

### Task 5: Integrate auto-correction into middleware
**Phase:** RED → GREEN

1. [RED] Write test: `WithTelemetry_ThresholdExceeded_AppliesAutoCorrection`
   - File: `servers/exarchos-mcp/src/telemetry/middleware.test.ts` (add to existing)
   - Expected failure: middleware doesn't call auto-correction
   - Setup: mock metrics showing 5+ breaches, handler that returns success
   - Verify: handler receives corrected args, response includes `_autoCorrection`

2. [RED] Write test: `WithTelemetry_SkipAutoCorrection_BypassesCorrection`
   - Same file
   - Input: args with `skipAutoCorrection: true`, metrics above threshold
   - Verify: handler receives original args, no `_autoCorrection` in response

3. [RED] Write test: `WithTelemetry_AutoCorrectionApplied_EmitsQualityHintGenerated`
   - Same file
   - Verify: `quality.hint.generated` event emitted to event store (activates orphan event type)

4. [GREEN] Modify `withTelemetry()` to check metrics and apply corrections before calling handler
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts`
   - Add: read recent metrics from TelemetryProjection state
   - Add: call `matchCorrection()` with current metrics
   - Add: inject corrected params if match found
   - Add: append `_autoCorrection` to response
   - Add: emit `quality.hint.generated` event on correction

**Dependencies:** Task 4
**Parallelizable:** Yes (within worktree, sequential with Task 4)

---

### Task 6: Add consistency window tracking to middleware
**Phase:** RED → GREEN

1. [RED] Write test: `ConsistencyTracker_RecordBreach_TracksConsecutiveCount`
   - File: `servers/exarchos-mcp/src/telemetry/auto-correction.test.ts` (add to existing)
   - Expected failure: tracker not implemented
   - Verify: consecutive breach count increments, resets on non-breach

2. [RED] Write test: `ConsistencyTracker_BelowWindowSize_NoCorrection`
   - Same file
   - Verify: 4 breaches → no correction, 5th breach → correction fires

3. [GREEN] Add `ConsistencyTracker` class to `auto-correction.ts`
   - In-memory map: `toolName:action` → consecutive breach count
   - `record(key, breached: boolean): number` — returns current count
   - `shouldCorrect(key): boolean` — count >= CONSISTENCY_WINDOW_SIZE

**Dependencies:** Task 4
**Parallelizable:** Yes (within worktree, sequential with Task 4)

---

## Worktree C: Integration Tests

### Task 7: MCP tool round-trip integration tests (workflow + event)
**Phase:** RED → GREEN

1. [RED] Write test: `Workflow_InitGetSet_RoundTrip`
   - File: `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts` (new)
   - Expected failure: test file doesn't exist
   - Flow: `handleWorkflow({ action: 'init', featureId: 'test', workflowType: 'feature' }, tmpDir)` → `handleWorkflow({ action: 'get', featureId: 'test' }, tmpDir)` → assert phase = 'ideate' → `handleWorkflow({ action: 'set', featureId: 'test', phase: 'plan' }, tmpDir)` → get again → assert phase = 'plan'
   - Setup: tmpDir with mkdtemp, resetMaterializerCache in beforeEach

2. [RED] Write test: `Event_AppendQuery_RoundTrip`
   - Same file
   - Flow: init workflow → `handleEvent({ action: 'append', streamId: 'test', type: 'workflow.started', data: {...} }, tmpDir)` → `handleEvent({ action: 'query', streamId: 'test' }, tmpDir)` → assert 1 event returned with correct type

3. [RED] Write test: `Event_BatchAppend_SequenceOrdering`
   - Same file
   - Flow: batch_append 3 events → query → assert sequences 1,2,3 in order

4. [RED] Write test: `UnknownAction_AllTools_ReturnsError`
   - Same file
   - Flow: call each handler with `action: 'nonexistent'` → assert `error.code === 'UNKNOWN_ACTION'`

5. [RED] Write test: `InvalidSchema_WorkflowInit_MissingFeatureId_ReturnsValidationError`
   - Same file
   - Flow: `handleWorkflow({ action: 'init' }, tmpDir)` (missing required featureId) → assert error

6. [GREEN] Tests should pass against existing handlers. Only file creation needed.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 8: Integration tests for view + orchestrate + sync tools
**Phase:** RED → GREEN

1. [RED] Write test: `View_Pipeline_MaterializesFromEvents`
   - File: `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts` (add to existing from Task 7)
   - Flow: init workflow → append transition events → `handleView({ action: 'pipeline' }, tmpDir)` → assert view reflects current phase

2. [RED] Write test: `Orchestrate_TaskClaim_EmitsEvent`
   - Same file
   - Flow: init workflow with tasks → `handleOrchestrate({ action: 'task_claim', featureId: 'test', taskId: 'T1', teammateName: 'agent-1' }, tmpDir)` → query events → assert `task.claimed` event present

3. [RED] Write test: `View_Telemetry_ReflectsToolUsage`
   - Same file
   - Flow: instrument a mock handler with withTelemetry → call it → `handleView({ action: 'telemetry' }, tmpDir)` → assert invocation count > 0

4. [GREEN] Tests use existing handlers + mock state setup

**Dependencies:** Task 7 (shared test file)
**Parallelizable:** Yes (within worktree, sequential with Task 7)

---

### Task 9: Cross-tool lifecycle integration test
**Phase:** RED → GREEN

1. [RED] Write test: `CrossTool_WorkflowLifecycle_InitTransitionView`
   - File: `servers/exarchos-mcp/src/__tests__/mcp-tools.integration.test.ts` (add to existing)
   - Flow: init → set phase to 'plan' (emits workflow.transition) → query events → assert transition event → get workflow status view → assert phase matches → set planReview.approved → transition to delegate → verify full round-trip

2. [RED] Write test: `CrossTool_EventAppend_ViewMaterialization_Consistency`
   - Same file
   - Flow: append tool.completed events → telemetry view reflects metrics → append more → view updates consistently

3. [GREEN] Tests use existing handlers

**Dependencies:** Task 7 (shared test file)
**Parallelizable:** Yes (within worktree, sequential with Task 8)

---

## Worktree D: Script Test Companions

### Task 10: Test companion for validate-rm.sh
**Phase:** RED → GREEN

1. [RED] Write test: `SafeDelete_PathWithinCWD_ExitsZero`
   - File: `scripts/validate-rm.test.sh` (new)
   - Expected failure: test file doesn't exist
   - Input: JSON stdin `{ "tool_input": { "command": "rm file.txt" }, "cwd": "/tmp/test" }` with actual file
   - Expected: exit 0

2. [RED] Write test: `UnsafeDelete_PathOutsideCWD_ExitsTwo`
   - Same file
   - Input: JSON stdin with `rm /etc/passwd`, cwd = `/tmp/test`
   - Expected: exit 2, stderr contains error

3. [RED] Write test: `UnsafeDelete_UnsetVariable_ExitsTwo`
   - Same file
   - Input: JSON stdin with `rm -rf $UNSET_VAR/foo`
   - Expected: exit 2

4. [RED] Write test: `UnsafeDelete_RootPath_ExitsTwo`
   - Same file
   - Input: JSON stdin with `rm -rf /`
   - Expected: exit 2

5. [RED] Write test: `MissingInput_NoStdin_ExitsTwo`
   - Same file — usage error
   - Expected: exit 2

6. [GREEN] Script already exists and handles all cases. Tests should pass.

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 11: Test companions for validate-installation.sh and setup-worktree.sh
**Phase:** RED → GREEN

1. [RED] Write test: `ValidInstallation_AllSkillsPresent_ExitsZero`
   - File: `scripts/validate-installation.test.sh` (new)
   - Setup: create mock `~/.claude/skills/` with valid SKILL.md files
   - Expected: exit 0

2. [RED] Write test: `InvalidInstallation_MissingSkillMd_ExitsOne`
   - Same file
   - Setup: skill dir without SKILL.md
   - Expected: exit 1

3. [RED] Write test: `SetupWorktree_ValidArgs_CreatesWorktreeExitsZero`
   - File: `scripts/setup-worktree.test.sh` (new)
   - Setup: init git repo in tmpdir
   - Input: `--repo-root $TMPDIR --task-id 001 --task-name test-task --skip-tests`
   - Expected: exit 0, worktree directory exists

4. [RED] Write test: `SetupWorktree_MissingArgs_ExitsTwo`
   - Same file
   - Input: no args
   - Expected: exit 2

5. [GREEN] Scripts exist, tests validate existing behavior

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 12: Test companions for review-diff.sh and extract-task.sh
**Phase:** RED → GREEN

1. [RED] Write test: `ReviewDiff_ValidWorktree_ProducesMarkdownDiff`
   - File: `scripts/review-diff.test.sh` (new)
   - Setup: git repo with committed changes on feature branch
   - Expected: exit 0, output contains diff markers

2. [RED] Write test: `ReviewDiff_NoChanges_ProducesEmptyDiff`
   - Same file
   - Setup: branch with no changes from base
   - Expected: exit 0, output indicates no changes

3. [RED] Write test: `ExtractTask_ValidTaskId_OutputsTaskSection`
   - File: `scripts/extract-task.test.sh` (new)
   - Setup: plan.md with `### Task 001: Build widget`
   - Input: plan path + task ID `001`
   - Expected: exit 0, output contains task title and content

4. [RED] Write test: `ExtractTask_InvalidTaskId_ExitsOne`
   - Same file
   - Input: plan path + nonexistent task ID `999`
   - Expected: exit 1

5. [RED] Write test: `ExtractTask_MissingArgs_ExitsTwo`
   - Same file
   - Input: no args
   - Expected: exit 2

6. [GREEN] Scripts exist, tests validate existing behavior

**Dependencies:** None
**Parallelizable:** Yes

---

## Summary

| Worktree | Tasks | Test Count | New Files | Modified Files |
|----------|-------|-----------|-----------|----------------|
| A: Event Hygiene | 1-2 | 3 | 0 | 3-4 |
| B: Telemetry Auto-Correction | 3-6 | 14 | 2 | 3 |
| C: Integration Tests | 7-9 | 10 | 1 | 0 |
| D: Script Test Companions | 10-12 | 16 | 5 | 0 |
| **Total** | **12** | **43** | **8** | **6-7** |
