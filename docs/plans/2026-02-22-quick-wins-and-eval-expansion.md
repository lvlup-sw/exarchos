# Implementation Plan: Quick Wins Batch + Core Workflow Eval Expansion

## Source Design
Link: `docs/designs/2026-02-22-quick-wins-and-eval-expansion.md`

## Scope
**Target:** Full design
**Excluded:** None

## Summary
- Total tasks: 14
- Parallel groups: 3
- Estimated test count: 22
- Design coverage: 8 of 8 sections covered

## Spec Traceability

### Scope Declaration

**Target:** Full design
**Excluded:** None

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Part 1 > 1A. Fix #775 | Add `explore: {}` to initStateFile, guard passes on transition | 1, 2 | Covered |
| Part 1 > 1B. Stale @planned | Remove @planned from 3 schemas, add promotion tests | 3, 4 | Covered |
| Part 1 > 1C. Shepherd schemas | Add 4 shepherd event schemas to schemas.ts | 5, 6 | Covered |
| Part 1 > 1D. CQRS cleanup | Remove/update legacy team.task.assigned handling | 7 | Covered |
| Part 2 > Brainstorming suite | suite.json + golden.jsonl + regression.jsonl | 8, 9 | Covered |
| Part 2 > Implementation-planning suite | suite.json + golden.jsonl + regression.jsonl | 10, 11 | Covered |
| Part 2 > Refactor suite | suite.json + golden.jsonl + regression.jsonl | 12 | Covered |
| Part 2 > Debug suite | suite.json + golden.jsonl + regression.jsonl | 13 | Covered |
| Integration > Suite discovery | discoverSuites() finds new suites, datasets parse | 14 | Covered |

## Task Breakdown

### Task 1: Test explore field initialization and guard pass

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `initStateFile_RefactorWorkflow_IncludesExploreField`
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Expected failure: `explore` field not present in initial state
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `handleSet_ExploreScope_ThenTransitionToBrief_Succeeds`
   - File: `servers/exarchos-mcp/src/workflow/state-store.test.ts`
   - Expected failure: Guard rejects transition because `explore.scopeAssessment` lost during re-materialization
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Add `explore: {}` to initial state in `initStateFile()`
   - File: `servers/exarchos-mcp/src/workflow/state-store.ts`
   - Changes: Add `explore: {}` to `rawState` object at ~line 86-116
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 2: Verify guard integration end-to-end

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `scopeAssessmentComplete_WithExploreSet_ReturnsTrue`
   - File: `servers/exarchos-mcp/src/workflow/guards.test.ts`
   - Expected failure: Test should pass if guard implementation is correct (verify guard works with properly initialized state)
   - Run: `npm run test:run` - verify existing guard logic

2. [RED] Write test: `scopeAssessmentComplete_WithoutExplore_ReturnsFailure`
   - File: `servers/exarchos-mcp/src/workflow/guards.test.ts`
   - Expected failure: Guard correctly returns failure object when explore is missing
   - Run: `npm run test:run` - MUST FAIL (if test doesn't exist yet)

3. [GREEN] Ensure guard handles both initialized and missing explore
   - File: `servers/exarchos-mcp/src/workflow/guards.ts`
   - Changes: Verify guard at line 373-385 handles the `explore: {}` initial state (should already work with optional chaining)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Guard returns true when explore.scopeAssessment is set
- [ ] Guard returns failure when explore is empty or missing
- [ ] Integration: init → set explore → transition to brief works

**Dependencies:** 1
**Parallelizable:** No (depends on 1)

---

### Task 3: Remove @planned from 3 promoted schemas

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests (following existing QualityHintGenerated promotion test pattern):
   - `schemas_ReviewFindingData_NotMarkedPlanned`
   - `schemas_ReviewEscalatedData_NotMarkedPlanned`
   - `schemas_QualityRegressionData_NotMarkedPlanned`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: @planned annotation still present in preceding 3 lines
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Remove `@planned` comments from schemas.ts
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes: Remove `@planned` comment preceding `ReviewFindingData` (~line 228), `ReviewEscalatedData` (~line 239), `QualityRegressionData` (~line 343)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Three new promotion tests fail before @planned removal
- [ ] All three pass after removal
- [ ] Existing tests remain green

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 4: Add schema validation tests for promoted events

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `ReviewFindingData_ValidPayload_PassesValidation`
   - `ReviewEscalatedData_ValidPayload_PassesValidation`
   - `QualityRegressionData_ValidPayload_PassesValidation`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: Tests should pass since schemas already exist (verify correct validation)
   - Run: `npm run test:run` - verify schemas validate correctly

2. [GREEN] Fix any schema validation issues found
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes: Adjust schemas if validation tests reveal issues
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Each schema validates a realistic sample payload
- [ ] Invalid payloads are rejected

**Dependencies:** 3
**Parallelizable:** No (depends on 3)

---

### Task 5: Add shepherd event schemas

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write tests:
   - `ShepherdStartedData_ValidPayload_PassesValidation`
   - `ShepherdIterationData_ValidPayload_PassesValidation`
   - `ShepherdApprovalRequestedData_ValidPayload_PassesValidation`
   - `ShepherdCompletedData_ValidPayload_PassesValidation`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: Schemas not yet defined
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Add 4 shepherd Zod schemas + EventType union entries
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes:
     - Add `ShepherdStartedData` schema: `{ prUrl: string, stackSize: number, ciStatus: string }`
     - Add `ShepherdIterationData` schema: `{ prUrl: string, iteration: number, action: string, outcome: string }`
     - Add `ShepherdApprovalRequestedData` schema: `{ prUrl: string, reviewers: string[] }`
     - Add `ShepherdCompletedData` schema: `{ prUrl: string, merged: boolean, iterations: number, duration: number }`
     - Add `shepherd.started`, `shepherd.iteration`, `shepherd.approval_requested`, `shepherd.completed` to EventType union
     - Mark all with `@planned` (shepherd skill not yet emitting typed events)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] All 4 schemas validate correct payloads
- [ ] All 4 event types in EventType union
- [ ] Marked @planned

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 6: Add shepherd event type constants

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `EventType_ShepherdTypes_ExistInUnion`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: Shepherd event types not in union (if not already covered by T5)
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Ensure EventType union includes all 4 shepherd types
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes: Verify shepherd types added in T5 compile correctly in the union
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] TypeScript compiler accepts shepherd event types
- [ ] All shepherd events listed in EventType

**Dependencies:** 5
**Parallelizable:** No (depends on 5)

---

### Task 7: Clean up legacy team.task.assigned CQRS handling

**Phase:** RED → GREEN → REFACTOR

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `DelegationTimelineView_TeamTaskAssigned_UsesCurrentSchema`
   - File: `servers/exarchos-mcp/src/views/delegation-timeline-view.test.ts`
   - Expected failure: If legacy code paths exist that don't use `TeamTaskAssignedData` schema
   - Run: `npm run test:run` - verify current behavior

2. [GREEN] Update delegation-timeline-view handler to use current `TeamTaskAssignedData` schema
   - File: `servers/exarchos-mcp/src/views/delegation-timeline-view.ts`
   - Changes: At lines 82-118, ensure handler uses typed `data` from `TeamTaskAssignedData` schema. Remove any untyped `data` access patterns.
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Remove dead code paths in workflow-state-projection
   - File: `servers/exarchos-mcp/src/views/workflow-state-projection.ts`
   - Changes: At lines 264-293, verify team.task.assigned is listed as observational-only — clean up if redundant
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] All view tests pass
- [ ] No untyped data access for team.task.assigned
- [ ] Existing delegation timeline behavior preserved

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 8: Create brainstorming eval suite.json + assertions

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `discoverSuites_FindsBrainstormingSuite`
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts`
   - Expected failure: No brainstorming suite directory exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create suite configuration
   - File: `evals/brainstorming/suite.json`
   - Content: Suite with 3 assertions:
     - `tool-call` (threshold 1.0): requires `exarchos_workflow.init`, `exarchos_workflow.set`
     - `trace-pattern` (threshold 0.8): ordered `workflow.started` → `workflow.transition`
     - `exact-match` (threshold 1.0): `artifacts.design` non-null in output
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Suite discovered by harness
- [ ] Assertions match SKILL.md spec

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 9: Create brainstorming eval datasets (dataset construction)

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**Dataset Construction approach:** Hand-craft golden cases from SKILL.md specifications, model after existing delegation golden.jsonl format. Mine historical state file shapes for realistic regression data. Tag regression cases for CI gate enforcement.

**TDD Steps:**
1. [RED] Write test: `DatasetLoader_BrainstormingGolden_ParsesWithoutErrors`
   - File: `servers/exarchos-mcp/src/evals/dataset-loader.test.ts`
   - Expected failure: Dataset file doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create golden and regression datasets
   - File: `evals/brainstorming/datasets/golden.jsonl`
   - Content: 3-5 golden cases following delegation golden.jsonl format:
     - `brs-g001`: Simple feature brainstorm → design doc produced
     - `brs-g002`: Brainstorm with constraints → design reflects constraints
     - `brs-g003`: Multi-approach brainstorm → 2-3 options documented
   - File: `evals/brainstorming/datasets/regression.jsonl`
   - Content: 2-3 known-good ideation traces
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] All JSONL entries parse correctly
- [ ] Dataset covers skill's critical paths
- [ ] Regression entries match spec expectations

**Dependencies:** 8
**Parallelizable:** No (depends on 8 for suite structure)

---

### Task 10: Create implementation-planning eval suite.json + assertions

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `discoverSuites_FindsImplementationPlanningSuite`
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts`
   - Expected failure: No implementation-planning suite directory exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create suite configuration
   - File: `evals/implementation-planning/suite.json`
   - Content: Suite with 3 assertions:
     - `tool-call` (threshold 1.0): requires `exarchos_workflow.set` with tasks populated
     - `trace-pattern` (threshold 0.8): ordered `workflow.transition` (plan→plan-review)
     - `exact-match` (threshold 1.0): `artifacts.plan` non-null, `tasks` array non-empty
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Suite discovered by harness
- [ ] Assertions match SKILL.md spec

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 11: Create implementation-planning eval datasets

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `DatasetLoader_ImplementationPlanningGolden_ParsesWithoutErrors`
   - File: `servers/exarchos-mcp/src/evals/dataset-loader.test.ts`
   - Expected failure: Dataset file doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create golden and regression datasets
   - File: `evals/implementation-planning/datasets/golden.jsonl`
   - Content: 3-5 golden cases:
     - `pln-g001`: Small design (3 tasks) → plan with dependencies
     - `pln-g002`: Large design (10+ tasks) → parallel groups identified
     - `pln-g003`: Design with testing strategy → PBT/benchmark flags set
   - File: `evals/implementation-planning/datasets/regression.jsonl`
   - Content: 2-3 known-good planning traces mined from historical state
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] All JSONL entries parse correctly
- [ ] Dataset covers plan skill's critical paths

**Dependencies:** 10
**Parallelizable:** No (depends on 10 for suite structure)

---

### Task 12: Create refactor eval suite + datasets

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `discoverSuites_FindsRefactorSuite`
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts`
   - Expected failure: No refactor suite directory exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create suite + datasets
   - File: `evals/refactor/suite.json`
   - Content: Suite with 3 assertions:
     - `tool-call` (threshold 1.0): requires `exarchos_workflow.init` with workflowType=refactor
     - `trace-pattern` (threshold 0.8): `workflow.started` → `workflow.transition` sequence (explore→brief→implement→validate)
     - `exact-match` (threshold 1.0): `workflowType` = "refactor"
   - File: `evals/refactor/datasets/golden.jsonl`
   - Content: 3 cases:
     - `ref-g001`: Polish track (small refactor) → direct implementation
     - `ref-g002`: Overhaul track → delegation to worktrees
     - `ref-g003`: Track selection → correct track based on scope
   - File: `evals/refactor/datasets/regression.jsonl`
   - Content: 2 known-good refactor traces
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Suite discovered, datasets parse
- [ ] Assertions match refactor SKILL.md phase sequence

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 13: Create debug eval suite + datasets

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `discoverSuites_FindsDebugSuite`
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts`
   - Expected failure: No debug suite directory exists
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create suite + datasets
   - File: `evals/debug/suite.json`
   - Content: Suite with 3 assertions:
     - `tool-call` (threshold 1.0): requires `exarchos_workflow.init` with workflowType=debug
     - `trace-pattern` (threshold 0.8): `workflow.started` → `workflow.transition` sequence (triage→investigate→fix→validate)
     - `exact-match` (threshold 1.0): `workflowType` = "debug"
   - File: `evals/debug/datasets/golden.jsonl`
   - Content: 3 cases:
     - `dbg-g001`: Hotfix track → quick fix applied
     - `dbg-g002`: Thorough track → root cause analysis documented
     - `dbg-g003`: Track selection → correct track based on severity
   - File: `evals/debug/datasets/regression.jsonl`
   - Content: 2 known-good debug traces
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Suite discovered, datasets parse
- [ ] Assertions match debug SKILL.md phase sequence

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Task 14: End-to-end eval verification run

**Phase:** RED → GREEN

**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

**TDD Steps:**
1. [RED] Write test: `runAll_AllSuites_RegressionLayerPasses`
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts`
   - Expected failure: New suites not yet discovered or datasets missing
   - Run: `npm run test:run` - MUST FAIL (until all suites created)

2. [GREEN] Verify all 7 suites (3 existing + 4 new) discover and pass regression layer
   - Run: `cd servers/exarchos-mcp && npm run test:run`
   - Changes: Fix any dataset parsing or assertion configuration issues
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Run full eval suite to confirm CI gate compatibility
   - Run: `npm run build && echo '{"ci": false, "layer": "regression"}' | node servers/exarchos-mcp/dist/cli.js eval-run`
   - Verify: All suites report passed

**Verification:**
- [ ] `discoverSuites()` returns 7 suites
- [ ] All regression-layer cases pass
- [ ] No regressions in existing suites
- [ ] CI gate format output works

**Dependencies:** 8, 9, 10, 11, 12, 13
**Parallelizable:** No (depends on all eval suite tasks)

## Parallelization Strategy

### Group A — Quick Wins (independent, can run in parallel worktrees)
- **Worktree 1:** Tasks 1 + 2 (explore field fix + guard verification)
- **Worktree 2:** Tasks 3 + 4 (@planned removal + schema validation)
- **Worktree 3:** Tasks 5 + 6 (shepherd schemas + type constants)
- **Worktree 4:** Task 7 (CQRS cleanup)

### Group B — Eval Suites (independent suite creation, parallel)
- **Worktree 5:** Tasks 8 + 9 (brainstorming suite + datasets)
- **Worktree 6:** Tasks 10 + 11 (implementation-planning suite + datasets)
- **Worktree 7:** Task 12 (refactor suite + datasets)
- **Worktree 8:** Task 13 (debug suite + datasets)

### Group C — Integration (sequential, after A+B)
- Task 14 (end-to-end verification — depends on all Group A and B tasks)

**Note:** Groups A and B can run concurrently. Group C runs after both complete.

## Deferred Items

| Item | Rationale |
|------|-----------|
| LLM rubric grader for plan suite | Requires ANTHROPIC_API_KEY; capability-llm layer is advisory-only. Add as follow-up when expanding eval coverage depth. |
| Historical state file mining script | Design calls for mining historical data. For this batch, hand-craft datasets based on historical state file shapes. Automated mining is a follow-up. |
| Shepherd skill typed event emission | Shepherd schemas marked @planned; updating the skill to emit typed events is a separate task (P2 in priorities doc). |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards (>91% statements, >96% functions)
- [ ] Ready for review
