# Implementation Plan: Gate-Telemetry Consolidation

**Feature ID:** `refactor-gate-telemetry-consolidation`
**Workflow Type:** refactor (overhaul)
**Date:** 2026-03-01

## Design Reference

No standalone design doc — requirements sourced from:
- `docs/bugs/audit.md` — remaining gaps (per-task enforcement, D5 at plan boundary)
- `docs/adrs/adversarial-convergence-theory.md` §3.3 — graduated depth table
- Brief in workflow state — five goals with success criteria

## Workstream Overview

Five workstreams, organized by dependency:

```
WS1: Per-task gate enforcement ──────────────────────────── (independent)
WS2: D5 task decomposition check ───────────────────────── (independent)
WS3: Telemetry hint activation ─────────────────────────── (independent)
WS4: Telemetry query abstraction ── WS5: Readiness dedup ─ (WS4 before WS5)
```

WS1, WS2, WS3 are fully parallelizable. WS4 must complete before WS5 (shared abstraction).

---

## Tasks

### Task T-01: Gate guard in handleTaskComplete — test

**Phase:** RED
**Implements:** DR-1 (per-task gate enforcement)

1. [RED] Write test: `HandleTaskComplete_NoTddGate_RejectsCompletion`
   - File: `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Arrange: Create event store with `task.assigned` event but NO `gate.executed` event for the task
   - Act: Call `handleTaskComplete({ streamId, taskId, result: {...} }, stateDir)`
   - Assert: Returns `{ success: false, error: { code: 'GATE_NOT_PASSED' } }`
   - Expected failure: handleTaskComplete currently has no gate check

2. [RED] Write test: `HandleTaskComplete_PassingTddGate_AllowsCompletion`
   - File: `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Arrange: Append `gate.executed` event with `gateName: 'tdd-compliance'`, `passed: true`, `details.taskId: taskId`
   - Act: Call `handleTaskComplete({ streamId, taskId, result: {...} }, stateDir)`
   - Assert: Returns `{ success: true }` with `task.completed` event appended

3. [RED] Write test: `HandleTaskComplete_FailingTddGate_RejectsCompletion`
   - File: `servers/exarchos-mcp/src/tasks/tools.test.ts`
   - Arrange: Append `gate.executed` event with `gateName: 'tdd-compliance'`, `passed: false`, `details.taskId: taskId`
   - Act: Call `handleTaskComplete`
   - Assert: Returns `{ success: false, error: { code: 'GATE_NOT_PASSED' } }`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-02: Gate guard in handleTaskComplete — implementation

**Phase:** GREEN → REFACTOR
**Implements:** DR-1 (per-task gate enforcement)

1. [GREEN] Add gate check to `handleTaskComplete`
   - File: `servers/exarchos-mcp/src/tasks/tools.ts`
   - Query event store for `gate.executed` events in the stream
   - Filter for `gateName === 'tdd-compliance'` AND `details.taskId === taskId` AND `passed === true`
   - If no matching event found, return `{ success: false, error: { code: 'GATE_NOT_PASSED', message: 'TDD compliance gate must pass before task completion. Run check_tdd_compliance first.' } }`
   - Place guard BEFORE the existing `task.completed` event append

2. [REFACTOR] Extract gate verification to helper if >10 lines

**Dependencies:** T-01
**Parallelizable:** No (sequential with T-01)

---

### Task T-03: check-task-decomposition.sh script

**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2 (D5 task decomposition quality)

1. [RED] Write test: `scripts/check-task-decomposition.test.sh`
   - Tests (following `verify-plan-coverage.test.sh` pattern):
     - `WellDecomposed_AllFieldsPresent_ExitsZero` — plan with tasks having title, description, files, test expectations
     - `MissingDescription_EmptyTaskBody_ExitsOne` — task with title only
     - `MissingTestExpectations_NoTestSection_ExitsOne` — task without test names
     - `MissingFiles_NoFileTargets_ExitsOne` — task without file paths
     - `CyclicDependencies_CircularBlockedBy_ExitsOne` — task A blocks B blocks A
     - `ParallelConflict_SameFileInParallelTasks_ExitsOne` — two parallel tasks modifying same file
     - `ValidDependencyDAG_LinearChain_ExitsZero` — proper blockedBy chain
     - `EmptyPlan_NoTasks_ExitsTwo` — no tasks found in plan
     - `MissingPlanFile_BadPath_ExitsTwo` — file not found

2. [GREEN] Implement `scripts/check-task-decomposition.sh`
   - Shebang: `#!/usr/bin/env bash`, `set -euo pipefail`
   - Args: `--plan-file <path>` (required), `--help`
   - Exit codes: 0 (pass), 1 (decomposition gaps), 2 (input error)
   - Checks:
     a. Parse `### Task` headers, extract task blocks
     b. Each task must have: description text (>10 words), `**File:**` or `File:` targets, test expectations (`[RED]` section or `**Test:**`)
     c. Parse `**Dependencies:**` fields, build adjacency list, detect cycles (DFS)
     d. Parse `**Parallelizable:** Yes` tasks, verify no shared file targets
   - Output: Markdown report with table (`| Task | Description | Files | Tests | Deps | Status |`), summary, result line

3. [REFACTOR] Ensure consistent output format with other gate scripts

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-04: Task decomposition orchestrate handler

**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2 (D5 task decomposition quality)

1. [RED] Write test: `servers/exarchos-mcp/src/orchestrate/task-decomposition.test.ts`
   - `HandleTaskDecomposition_PassingScript_EmitsD5GateEvent` — mock execSync to return exit 0 output, verify gate.executed emitted with dimension D5
   - `HandleTaskDecomposition_FailingScript_EmitsD5GateEventWithPassedFalse` — exit 1, verify passed: false
   - `HandleTaskDecomposition_MissingPlanFile_ReturnsScriptError` — exit 2, verify error response
   - `HandleTaskDecomposition_ReturnsStructuredMetrics` — verify response includes wellDecomposedTasks, tasksNeedingRework, totalTasks

2. [GREEN] Implement `servers/exarchos-mcp/src/orchestrate/task-decomposition.ts`
   - Follow `plan-coverage.ts` handler pattern
   - Invoke `check-task-decomposition.sh --plan-file <planPath>`
   - Parse metrics from markdown output via regex
   - Emit `gate.executed` with `gateName: 'task-decomposition'`, `layer: 'planning'`, `dimension: 'D5'`, `phase: 'plan'`
   - Return `{ passed, metrics, report }`

3. [GREEN] Register in `servers/exarchos-mcp/src/orchestrate/composite.ts`
   - Import handler, add `check_task_decomposition` to `ACTION_HANDLERS` map

4. [REFACTOR] Ensure handler follows guard-clause-first pattern

**Dependencies:** T-03
**Parallelizable:** No (sequential with T-03)

---

### Task T-05: Wire D5 check into implementation-planning skill

**Phase:** GREEN
**Implements:** DR-2 (D5 task decomposition quality)

1. [GREEN] Update `skills/implementation-planning/SKILL.md`
   - In Step 5 (Plan Verification), add `check_task_decomposition` call alongside existing `check_plan_coverage` and `check_provenance_chain`
   - Add orchestrate call example:
     ```
     exarchos_orchestrate({ action: "check_task_decomposition", featureId: "<id>", planPath: "<path>" })
     ```
   - Mark as advisory (not blocking) — task decomposition quality is informational at this phase
   - Add note: "Gate auto-emits D5 event for ConvergenceView"

**Dependencies:** T-04
**Parallelizable:** No (sequential with T-04)

---

### Task T-06: Telemetry query abstraction

**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4 (layer violation fix)

1. [RED] Write test: `servers/exarchos-mcp/src/telemetry/telemetry-queries.test.ts`
   - `QueryRuntimeMetrics_WithTelemetryEvents_ReturnsMetrics` — seed telemetry stream, verify sessionTokens/toolCount/totalInvocations
   - `QueryRuntimeMetrics_EmptyStream_ReturnsZeroMetrics` — no events, returns `{ sessionTokens: 0, toolCount: 0, totalInvocations: 0 }`
   - `QueryRuntimeMetrics_MaterializationFailure_ReturnsZeroMetrics` — mock failure, verify graceful degradation

2. [GREEN] Create `servers/exarchos-mcp/src/telemetry/telemetry-queries.ts`
   - Export `RuntimeMetrics` interface: `{ sessionTokens: number; toolCount: number; totalInvocations: number }`
   - Export `queryRuntimeMetrics(store: EventStore, materializer: ViewMaterializer): Promise<RuntimeMetrics>`
   - Encapsulate: query telemetry stream, materialize TelemetryView, extract metrics
   - Graceful degradation: catch errors, return zero metrics

3. [GREEN] Update `servers/exarchos-mcp/src/orchestrate/context-economy.ts`
   - Replace direct telemetry projection import with `queryRuntimeMetrics` import from `../telemetry/telemetry-queries.js`
   - Remove import of `TELEMETRY_VIEW` and `TelemetryViewState` from telemetry projection
   - Call `queryRuntimeMetrics(store, materializer)` instead of inline materialization

4. [REFACTOR] Verify no other orchestrate files import directly from telemetry projection

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-07: Activate telemetry hints in quality pipeline

**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3 (telemetry hint activation)

1. [RED] Write test: `servers/exarchos-mcp/src/quality/hints.test.ts`
   - `GenerateQualityHints_WithTelemetryHints_IncludesTelemetryCategory` — pass TelemetryViewState with metrics exceeding thresholds, verify quality hints include telemetry-sourced hints with category `'telemetry'`
   - `GenerateQualityHints_WithoutTelemetryState_OmitsTelemetryHints` — null telemetry state, verify no telemetry hints
   - `GenerateQualityHints_TelemetryHintsRankedBySeverity_SortedCorrectly` — verify telemetry hints sort alongside quality hints

2. [GREEN] Update `servers/exarchos-mcp/src/quality/hints.ts`
   - Add `'telemetry'` to `QualityHintCategory` union type
   - Add optional `telemetryState?: TelemetryViewState` parameter to `generateQualityHints()`
   - Import `generateHints` from `../telemetry/hints.js` and `TelemetryViewState`
   - When `telemetryState` provided: call `generateHints(telemetryState)`, convert `Hint[]` to `QualityHint[]` with category `'telemetry'`, severity `'info'`
   - Merge telemetry hints into quality hints before sorting and truncation

3. [GREEN] Update `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
   - After materializing CodeQualityView, also materialize TelemetryView (via `queryRuntimeMetrics` or direct telemetry query)
   - Pass telemetry state to `generateQualityHints(qualityState, undefined, undefined, telemetryState)` (or restructure args)

4. [REFACTOR] Consider whether telemetry hints should also feed into `context-economy` handler findings

**Dependencies:** T-06 (uses telemetry query abstraction)
**Parallelizable:** No (sequential with T-06)

---

### Task T-08: Consolidate readiness computation — DelegationReadinessView

**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-5 (readiness dedup)

1. [RED] Write test: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - `HandlePrepareDelegation_QueriesDelegationReadinessView_UsesViewState` — verify handler materializes DelegationReadinessView and uses its `ready`/`blockers` fields
   - `HandlePrepareDelegation_ViewNotReady_ReturnsBlockers` — seed events where view reports not ready, verify handler returns matching blockers
   - `HandlePrepareDelegation_ViewReady_ProceedsToHints` — seed events where view reports ready, verify quality hints generated

2. [GREEN] Update `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
   - Replace inline `assessReadiness(workflowState, qualityState, taskCount)` with DelegationReadinessView materialization
   - Import and materialize `DELEGATION_READINESS_VIEW` from views
   - Use `delegationReadiness.ready` and `delegationReadiness.blockers` instead of computing inline
   - Keep quality hint generation (still needs CodeQualityView)
   - Remove `assessReadiness()` helper function if now unused

3. [REFACTOR] Verify DelegationReadinessView covers all readiness checks that `assessReadiness` previously computed. If gaps exist, extend the view's `apply()` method rather than keeping inline checks.

**Dependencies:** T-06 (telemetry abstraction may affect materialization pattern)
**Parallelizable:** No (after T-06)

---

### Task T-09: Update documentation

**Phase:** GREEN
**Implements:** All DRs

1. Update `docs/bugs/audit.md`
   - Mark "Per-task gate checks" as RESOLVED: "handleTaskComplete enforces gate.executed check before completion. No bypass."
   - Mark D5 gap as RESOLVED: "check_task_decomposition handler emits D5 gate.executed events at plan boundary."
   - Update the integration tier table to show all phases at Mature tier
   - Note telemetry hint activation and layer violation fix

2. Update `docs/adrs/adversarial-convergence-theory.md`
   - Add resolution note to any relevant open questions about per-task enforcement or D5 coverage

**Dependencies:** T-02, T-05, T-07, T-08 (all implementation complete)
**Parallelizable:** No (final task)

---

## Dependency Graph

```
T-01 → T-02                    (WS1: gate enforcement)
T-03 → T-04 → T-05             (WS2: D5 decomposition)
T-06 → T-07                    (WS3+WS4: telemetry abstraction + hint activation)
T-06 → T-08                    (WS4+WS5: telemetry abstraction + readiness dedup)
T-02, T-05, T-07, T-08 → T-09  (docs update after all implementation)
```

## Parallelization Groups

| Group | Tasks | Can Run Simultaneously |
|-------|-------|----------------------|
| A | T-01, T-03, T-06 | Yes — independent workstreams |
| B | T-02, T-04, T-07 | Yes — each depends only on its group A predecessor |
| C | T-05, T-08 | Yes — T-05 depends on T-04, T-08 depends on T-06 |
| D | T-09 | No — final, depends on all |

## Design Requirements Traceability

| DR | Requirement | Tasks |
|----|------------|-------|
| DR-1 | Strict gate guard in handleTaskComplete | T-01, T-02 |
| DR-2 | D5 task decomposition check at plan boundary | T-03, T-04, T-05 |
| DR-3 | Activate telemetry hints in quality pipeline | T-07 |
| DR-4 | Abstract telemetry queries from orchestrate layer | T-06 |
| DR-5 | Consolidate readiness computation via view | T-08 |
| DR-docs | Update audit.md and ADR | T-09 |
