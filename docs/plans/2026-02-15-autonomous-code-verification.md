# Implementation Plan: Autonomous Code Verification

## Source Design
Link: `docs/designs/2026-02-15-autonomous-code-verification.md`

## Scope

**Target:** Design Phases 1-3 (Property-Based Testing, Benchmark Infrastructure, Gate Result Materialization)

**Excluded:**
- Phase 4: Flywheel Integration — deferred until SDLC Eval Framework (Phase 2+) is implemented. The eval harness, dataset format, and EvalResultsView must exist before code quality correlation can be built.
- CI pipeline YAML changes — infrastructure configuration, not code in this repo. CI definitions are documented in the design for future reference.
- .NET ecosystem (FsCheck, BenchmarkDotNet) — Basileus backend is a separate repo.

## Summary

- Total tasks: 16
- Parallel groups: 5
- Estimated test count: ~45
- Design coverage: 10 of 13 sections covered (3 deferred: Flywheel Integration, CI Integration, Attribution Analysis deep slice)

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Layer 1: Property-Based Testing > When to Require | `testingStrategy` field, category table | T14, T15 | Covered (content layer) |
| Layer 1: Property-Based Testing > Property Test Patterns | Spawn prompt enrichment with PBT patterns | T15 | Covered |
| Layer 1: Property-Based Testing > Validation Script | `check-property-tests.sh` | T12 | Covered |
| Layer 1: Property-Based Testing > Framework Selection | `@fast-check/vitest` integration | T09 | Covered |
| Layer 1: Benchmark > Benchmark Types | Latency, throughput, resource categories | T13 | Covered |
| Layer 1: Benchmark > Benchmark Specification | `PerformanceSLA` interface | T14 | Covered (content layer) |
| Layer 1: Benchmark > Baselines and Regression Detection | `BenchmarkGateResult`, regression logic | T13 | Covered |
| Layer 1: Benchmark > Validation Script | `check-benchmark-regression.sh` | T13 | Covered |
| Layer 1: Benchmark > CI Integration | Per-PR benchmark gate YAML | — | Deferred: CI config, not repo code |
| Layer 2: Gate Result Materialization > CodeQualityView | CQRS projection, interfaces | T03-T06 | Covered |
| Layer 2: Gate Result Materialization > BenchmarkCompleted Event | New event type in taxonomy | T01 | Covered |
| Layer 2: Closed-Loop Flywheel > Data Flow | Eval framework integration | — | Deferred: depends on eval framework |
| Layer 2: Closed-Loop Flywheel > Flywheel Integration Points | Capability/regression eval correlation | — | Deferred: depends on eval framework |
| Layer 2: Closed-Loop Flywheel > Quality-Aware Eval Cases | Extended eval dataset format | — | Deferred: depends on eval framework |
| Layer 2: Closed-Loop Flywheel > Attribution Analysis | Multi-dimensional quality slicing | T06 | Partial: core slicing implemented |
| Integration > SDLC Pipeline | `/plan` testingStrategy, `/delegate` enrichment, `/review` checklist | T14, T15, T16 | Covered (content layer) |
| Integration > Telemetry Benchmarks | Shared infrastructure pattern | T01 | Covered |
| Testing Strategy | Unit + integration + smoke | All tasks | Covered |

---

## Task Breakdown

---

### Group A: Event Schema Extensions

These tasks extend the event store with new event types for benchmark results and quality regressions. Sequential because T02 depends on T01's pattern.

---

### Task 01: Add BenchmarkCompleted event type to event store schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `BenchmarkCompletedData_ValidPayload_ParsesSuccessfully`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts`
   - Test that `BenchmarkCompletedData.parse()` accepts a valid payload with `taskId`, `results` array (operation, metric, value, unit, baseline, regressionPercent, passed)
   - Test that `BenchmarkCompletedData.parse()` rejects payload missing required fields
   - Test that `'benchmark.completed'` is included in `EventTypes` array
   - Expected failure: `BenchmarkCompletedData` is not defined, `'benchmark.completed'` not in EventTypes
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
   - Add `'benchmark.completed'` to `EventTypes` array
   - Add `BenchmarkCompletedData` Zod schema following `GateExecutedData` pattern
   - Export `BenchmarkCompleted` type via `z.infer`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Ensure schema is grouped with other gate/quality event schemas
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A parallel with C, D, E)

---

### Task 02: Add QualityRegression event type to event store schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write test: `QualityRegressionData_ValidPayload_ParsesSuccessfully`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/schemas.test.ts`
   - Test that `QualityRegressionData.parse()` accepts valid payload with `gate`, `firstFailedAt`, `consecutiveFailures`, `possibleCauses`
   - Test rejection of invalid data (negative consecutiveFailures, empty gate name)
   - Test that `'quality.regression'` is included in `EventTypes` array
   - Expected failure: `QualityRegressionData` is not defined
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/event-store/schemas.ts`
   - Add `'quality.regression'` to `EventTypes` array
   - Add `QualityRegressionData` Zod schema
   - Export type
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01 (pattern established)
**Parallelizable:** No (sequential with T01)

---

### Group B: CodeQualityView CQRS Projection

Implements the materialized view that aggregates gate results, benchmark data, and quality trends. Sequential chain: T03 → T04 → T05 → T06 → T07 → T08.

---

### Task 03: CodeQualityView projection — init and gate tracking

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `CodeQualityView_Init_ReturnsEmptyState` — `init()` returns `{ skills: {}, models: {}, gates: {}, regressions: [], benchmarks: [] }`
   - `CodeQualityView_ApplyGateExecuted_UpdatesGateMetrics` — apply a `gate.executed` event with `passed: true`, verify `gates[gateName].passRate === 1.0`
   - `CodeQualityView_ApplyMultipleGateEvents_CalculatesPassRate` — apply 3 passed + 1 failed, verify `gates[gateName].passRate === 0.75`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/code-quality-view.test.ts`
   - Expected failure: `code-quality-view.ts` module doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/code-quality-view.ts`
   - Create `CodeQualityViewState` interface
   - Implement `codeQualityProjection: ViewProjection<CodeQualityViewState>`
   - Handle `gate.executed` event type in `apply()`
   - Export view name constant `CODE_QUALITY_VIEW`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract gate metrics accumulator helper
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01, T02 (event types exist)
**Parallelizable:** No (sequential start of Group B)

---

### Task 04: CodeQualityView — benchmark trend tracking

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `CodeQualityView_ApplyBenchmarkCompleted_CreatesTrend` — apply a `benchmark.completed` event, verify `benchmarks[0]` has operation, dataPoints, baseline, trend
   - `CodeQualityView_MultiplesBenchmarks_TracksTrend` — apply 3 benchmark events with improving values, verify `trend === 'improving'`
   - `CodeQualityView_BenchmarkRegression_DetectsDegrading` — apply events where values increase (worsen), verify `trend === 'degrading'`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/code-quality-view.test.ts`
   - Expected failure: `apply()` doesn't handle `benchmark.completed`
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/code-quality-view.ts`
   - Add `benchmark.completed` case to `apply()`
   - Implement trend calculation (compare last 3 data points)
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T03
**Parallelizable:** No

---

### Task 05: CodeQualityView — regression detection

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `CodeQualityView_ConsecutiveGateFailures_DetectsRegression` — apply 3 consecutive `gate.executed` events with `passed: false` for same gate, verify `regressions` contains entry with `consecutiveFailures === 3`
   - `CodeQualityView_GatePassAfterFailures_ClearsRegression` — apply 2 failures then 1 pass, verify `regressions` is empty
   - `CodeQualityView_MultipleGatesRegressing_TracksIndependently` — two different gates failing, verify both appear in `regressions`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/code-quality-view.test.ts`
   - Expected failure: Regression detection not implemented
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/code-quality-view.ts`
   - Track consecutive failures per gate in view state
   - Populate `regressions` array when threshold (default 3) is reached
   - Clear regression when gate passes
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T03
**Parallelizable:** No (depends on T03, parallel with T04 would be ok but both extend same file)

---

### Task 06: CodeQualityView — skill and model attribution

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `CodeQualityView_GateWithSkillMetadata_TracksPerSkill` — apply `gate.executed` events with `data.skill` field, verify `skills[skill].firstPassRate` is correct
   - `CodeQualityView_GateWithModelMetadata_TracksPerModel` — apply events with `data.model` field, verify `models[model].firstPassRate`
   - `CodeQualityView_SkillTopFailingGates_RankedByFailureRate` — apply mixed pass/fail events across multiple gates for one skill, verify `topFailingGates` is sorted by failure rate
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/code-quality-view.test.ts`
   - Expected failure: Attribution not implemented
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/code-quality-view.ts`
   - Extract `skill` and `model` from event data when present
   - Accumulate per-skill and per-model gate results
   - Calculate `firstPassRate`, `topFailingGates`
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Extract shared metrics accumulation logic between gate/skill/model
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T03, T05
**Parallelizable:** No

---

### Task 07: Register code_quality action in registry and composite

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `Registry_ViewTool_ContainsCodeQualityAction` — verify `exarchos_view` composite tool has `code_quality` action
   - `ViewComposite_CodeQualityAction_DispatchesToHandler` — call composite handler with `action: 'code_quality'`, verify it routes correctly (can mock handler)
   - `ViewComposite_CodeQualityAction_UnknownAction_ReturnsError` — verify `code_quality` is listed in `validTargets` of unknown action error
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/composite.test.ts` (or existing registry test file)
   - Expected failure: `code_quality` action not registered
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/registry.ts` — add `code_quality` action to `viewActions`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/composite.ts` — add `case 'code_quality'` dispatch
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T06 (view must exist before registering)
**Parallelizable:** No

---

### Task 08: code_quality view handler implementation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write tests:
   - `HandleViewCodeQuality_NoEvents_ReturnsEmptyView` — call handler with empty stream, verify empty `CodeQualityViewState`
   - `HandleViewCodeQuality_WithEvents_ReturnsMaterializedView` — seed events, call handler, verify view contains gate metrics
   - `HandleViewCodeQuality_WithWorkflowFilter_ScopesToWorkflow` — verify `workflowId` parameter filters correctly
   - `HandleViewCodeQuality_StoreError_ReturnsErrorResult` — verify error handling
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/tools.test.ts`
   - Expected failure: `handleViewCodeQuality` function doesn't exist
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `plugins/exarchos/servers/exarchos-mcp/src/views/tools.ts`
   - Add `handleViewCodeQuality()` following `handleViewWorkflowStatus()` pattern
   - Register `codeQualityProjection` with materializer in `getOrCreateMaterializer()`
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T07
**Parallelizable:** No

---

### Group C: Property-Based Test Reference Implementations

These tasks add `@fast-check/vitest` and write property tests for existing Exarchos modules as reference implementations. These demonstrate PBT patterns that agents will follow. Parallel with Groups A and B.

---

### Task 09: Add fast-check dependency and state machine property tests

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write property tests:
   - `StateMachine_ValidTransition_ProducesValidState` — for any valid (phase, trigger) pair, `transition()` produces a phase that is in the HSM definition
   - `StateMachine_InvalidTrigger_NeverProducesTransition` — for any phase with invalid trigger, `transition()` returns the same phase or throws
   - `StateMachine_TransitionIdempotence_SameInputSameOutput` — `transition(phase, trigger)` called twice with same args produces same result
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/state-machine.property.test.ts`
   - Expected failure: `@fast-check/vitest` not installed
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Install and implement
   - Run: `npm install --save-dev @fast-check/vitest fast-check` in MCP server package
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/workflow/state-machine.property.test.ts`
   - Implement property tests using `fc.oneof()` over valid phases and triggers from HSM definition
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason (missing dependency)
- [ ] Test passes after implementation
- [ ] Property tests exercise at least 100 random inputs

**Dependencies:** None
**Parallelizable:** Yes (Group C parallel with A, B, D, E)

---

### Task 10: Event store property tests — ordering and idempotency

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write property tests:
   - `EventStore_AppendThenQuery_PreservesOrder` — for any sequence of N events, query returns them in sequence order
   - `EventStore_IdempotentAppend_NoDuplicates` — appending same event with same idempotency key twice produces only one event
   - `EventStore_QueryWithTypeFilter_SubsetOfAll` — filtered query result is always a subset of unfiltered result
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/store.property.test.ts`
   - Expected failure: Property tests not written
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement property tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/event-store/store.property.test.ts`
   - Use `fc.array(fc.record(...))` to generate random event sequences
   - Use temp directories for isolated JSONL files per test run
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Property tests exercise ordering, idempotency, and filtering invariants

**Dependencies:** T09 (fast-check installed)
**Parallelizable:** No (sequential within Group C)

---

### Task 11: View materializer property tests — idempotence and monotonicity

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write property tests:
   - `Materializer_DoubleApplication_Idempotent` — materializing same events twice produces identical view state
   - `Materializer_IncrementalVsBatch_SameResult` — materializing events one-at-a-time vs all-at-once produces same result
   - `Materializer_HighWaterMark_MonotonicallyIncreasing` — after materialization, high-water mark is >= previous
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/materializer.property.test.ts`
   - Expected failure: Property tests not written
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement property tests
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/views/materializer.property.test.ts`
   - Generate random event sequences using `fc.array()` over valid event types
   - Compare materialized results for equivalence
   - Run: `npm run test:run` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Tests verify both existing views (pipeline, workflow-status) and new CodeQualityView

**Dependencies:** T09 (fast-check), T03 (CodeQualityView exists)
**Parallelizable:** No (depends on T09 and T03)

---

### Group D: Validation Scripts

New shell scripts for checking property test presence and benchmark regressions. Parallel with Groups A, B, C.

---

### Task 12: Create check-property-tests.sh and test

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write integration test: `check-property-tests.test.sh`
   - File: `scripts/check-property-tests.test.sh`
   - Test cases:
     - `HasPropertyTests_RequiredByPlan_ExitsZero` — worktree with `it.prop` calls, plan requires propertyTests → exit 0
     - `MissingPropertyTests_RequiredByPlan_ExitsOne` — worktree without property tests, plan requires them → exit 1
     - `NoPropertyTestsRequired_ExitsZero` — plan has `propertyTests: false` → exit 0
     - `UsageError_MissingArgs_ExitsTwo` — no args → exit 2
   - Expected failure: `check-property-tests.sh` doesn't exist
   - Run: `bash scripts/check-property-tests.test.sh` - MUST FAIL

2. [GREEN] Implement script
   - File: `scripts/check-property-tests.sh`
   - Parse plan file for tasks with `propertyTests: true`
   - Scan worktree for property test patterns: `it.prop`, `test.prop`, `fc.`, `@fast-check`
   - Cross-reference: each required task has at least one property test file
   - Output markdown report
   - Run: `bash scripts/check-property-tests.test.sh` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Script follows `set -euo pipefail` pattern, exit codes 0/1/2

**Dependencies:** None
**Parallelizable:** Yes (Group D parallel with A, B, C, E)

---

### Task 13: Create check-benchmark-regression.sh and test

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write integration test: `check-benchmark-regression.test.sh`
   - File: `scripts/check-benchmark-regression.test.sh`
   - Test cases:
     - `NoBenchmarkRegression_ExitsZero` — results within threshold of baselines → exit 0
     - `BenchmarkRegression_ExceedsThreshold_ExitsOne` — result 50% above baseline (threshold 10%) → exit 1
     - `BenchmarkImprovement_ReportsInfo_ExitsZero` — result significantly below baseline → exit 0 with improvement note
     - `NoBaseline_NewBenchmark_ExitsZero` — result has no matching baseline → exit 0 (new benchmark, no regression possible)
     - `CustomThreshold_RespectedInComparison` — custom threshold changes pass/fail boundary
     - `UsageError_MissingArgs_ExitsTwo` — no args → exit 2
   - Expected failure: `check-benchmark-regression.sh` doesn't exist
   - Run: `bash scripts/check-benchmark-regression.test.sh` - MUST FAIL

2. [GREEN] Implement script
   - File: `scripts/check-benchmark-regression.sh`
   - Args: `--results <file>` (JSON benchmark results) `--baselines <file>` (JSON baselines) `[--threshold <percent>]`
   - Parse both JSON files with `jq`
   - Compare each result against its baseline: `measured > baseline * (1 + threshold/100)` → FAIL
   - Output markdown report with per-benchmark pass/fail and percentage change
   - Run: `bash scripts/check-benchmark-regression.test.sh` - MUST PASS

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] Script handles missing baselines gracefully (new benchmarks)
- [ ] Threshold is configurable (default 10%)

**Dependencies:** None
**Parallelizable:** Yes (parallel with T12)

---

### Group E: Content Layer Updates

Updates to skills, rules, and spawn prompts. These are markdown files, not executable code — TDD applies via skill integration tests.

---

### Task 14: Update TDD rules with property-based testing guidance

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Verify current rules lack PBT guidance
   - File: `rules/tdd-typescript.md`
   - Confirm no mention of property-based testing, fast-check, or `it.prop`

2. [GREEN] Add PBT section to TDD rules
   - File: `rules/tdd-typescript.md`
   - Add "Property-Based Testing" section after "Mocking" section
   - Include: when to use PBT, fast-check import pattern, standard property patterns (roundtrip, invariant, idempotence)
   - Keep concise — reference the spawn prompt for detailed patterns

**Verification:**
- [ ] Rules file includes PBT guidance
- [ ] Guidance is actionable (import examples, when-to-use criteria)

**Dependencies:** None
**Parallelizable:** Yes (Group E parallel with all other groups)

---

### Task 15: Add property-based testing patterns to spawn prompt templates

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Verify spawn prompts lack PBT guidance
   - File: `plugins/exarchos/servers/exarchos-mcp/src/team/roles.ts`
   - Confirm `generateSpawnPrompt()` does not include PBT patterns

2. [GREEN] Enrich spawn prompt with PBT patterns
   - File: `plugins/exarchos/servers/exarchos-mcp/src/team/roles.ts`
   - When task context includes `propertyTests: true`, add PBT guidance section to spawn prompt
   - Include the four standard patterns: roundtrip, invariant, idempotence, commutativity
   - Include `@fast-check/vitest` import pattern

3. [RED → GREEN for test] Write unit test: `GenerateSpawnPrompt_PropertyTestsRequired_IncludesPBTGuidance`
   - File: `plugins/exarchos/servers/exarchos-mcp/src/__tests__/team/roles.test.ts`
   - Verify prompt contains `fast-check` and `it.prop` when `propertyTests: true`
   - Verify prompt omits PBT section when `propertyTests: false`

**Verification:**
- [ ] Spawn prompt conditionally includes PBT patterns
- [ ] Unit test covers both branches

**Dependencies:** T09 (fast-check installed so import patterns are valid)
**Parallelizable:** Yes (parallel within Group E)

---

### Task 16: Skill integration test for property test and benchmark references

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**

1. [RED] Write skill integration test
   - File: `scripts/validate-misc-skills.test.sh` (append to existing)
   - Test that relevant SKILL.md files reference the new validation scripts:
     - Delegation skill references `check-property-tests.sh`
     - Quality review skill references `check-benchmark-regression.sh`
   - Expected failure: Skills don't reference new scripts yet

2. [GREEN] Update skill files
   - File: `skills/delegation/SKILL.md` — add reference to `check-property-tests.sh` in post-delegation validation
   - File: `skills/quality-review/SKILL.md` — add reference to `check-benchmark-regression.sh` in review checklist
   - Run: `bash scripts/validate-misc-skills.test.sh` - MUST PASS

**Verification:**
- [ ] Integration test verifies skill-script references
- [ ] Skills reference scripts by correct path

**Dependencies:** T12, T13 (scripts must exist)
**Parallelizable:** No (depends on scripts existing)

---

## Parallelization Strategy

### Parallel Groups

```
Group A (T01-T02): Event Schemas          ─────┐
                                                 ├──→ T03-T08 (Group B: CodeQualityView)
Group C (T09-T10): Property Tests         ─────┤                    │
                                                 │                    └──→ T11 (View property tests)
Group D (T12-T13): Validation Scripts     ─────┤
                                                 │
Group E (T14-T15): Content Layer          ─────┤
                                                 └──→ T16 (Skill integration test)
```

### Worktree Assignment

| Worktree | Tasks | Rationale |
|---|---|---|
| Worktree 1 | T01, T02, T03-T08 | Event schemas → CodeQualityView (sequential chain) |
| Worktree 2 | T09, T10, T11 | Property test reference implementations (sequential) |
| Worktree 3 | T12, T13 | Validation scripts (parallel within group) |
| Worktree 4 | T14, T15, T16 | Content layer updates (light, sequential) |

### Dependency Graph

```
T01 ──→ T02 ──→ T03 ──→ T04
                  │       │
                  ├──→ T05 ──→ T06 ──→ T07 ──→ T08
                  │
T09 ──→ T10      └──→ T11 (needs T03 + T09)

T12 ─────────────────────→ T16 (needs T12 + T13)
T13 ──────────────────────┘

T14 (independent)
T15 (depends on T09 for valid import patterns)
```

---

## Deferred Items

| Item | Rationale |
|---|---|
| **Phase 4: Flywheel Integration** | Depends on SDLC Eval Framework Phases 2-3 (LLM grading, event emission, EvalResultsView). Cannot implement code quality correlation without eval infrastructure. |
| **CI pipeline YAML** | Infrastructure configuration, not code in this repo. Design document captures the target YAML for future implementation. |
| **Auto-remediation for benchmark failures** | Part of flywheel (Phase 4). Requires eval framework to distinguish optimization hints from correctness fixes. |
| **Cross-model comparison controls** | Requires significant data volume (20+ workflows per model per task type). Implement in flywheel phase after data accumulation. |
| **PerformanceSLA schema in plan format** | Documented in design, but plan files are markdown prose — the schema is guidance for agents, not programmatic validation. Covered by content layer updates (T14). |

---

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Event schemas validate with Zod
- [ ] CodeQualityView materializes from event sequences
- [ ] Property test reference implementations demonstrate all 4 patterns
- [ ] Validation scripts follow exit code convention (0/1/2)
- [ ] Content layer updates reference new scripts
- [ ] Code coverage meets standards
- [ ] Ready for review
