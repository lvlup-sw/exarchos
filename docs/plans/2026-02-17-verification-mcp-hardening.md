# Implementation Plan: Verification Infrastructure + MCP Hardening

**Design:** `docs/designs/2026-02-17-verification-mcp-hardening.md`
**Issues:** #341, #342, #343, #344 (close), #345, #408 (P0+P1)
**Scope:** Full — all design sections covered

## Traceability Matrix

| Design Section | Tasks | Key Requirements |
|---------------|-------|------------------|
| A1: testingStrategy Schema (#341) | T1-T4 | Zod schemas, backward compat, /plan skill update |
| A2: check-property-tests.sh (#343) | T5-T8 | Script conventions, TS+.NET patterns, exit codes |
| A3: PBT Prompt Enrichment (#342) | T9-T10 | Conditional section, pattern catalog, framework examples |
| B: CodeQualityView (#345) | T11-T19 | Interfaces, projection, registry, regression detection |
| C1: PID Lock (#408) | T20-T23 | Atomic lock, stale reclaim, exit cleanup |
| C2: Sequence Invariant (#408) | T24-T25 | Cold-start validation, clear errors |
| C3: CAS Diagnostic (#408) | T26-T28 | Event type, emission on exhaustion |
| C4: Configurable LRU (#408) | T29-T30 | Env var, default preservation |
| C5: Configurable Idempotency (#408) | T31-T32 | Env var, increased default |
| C6: Exponential Backoff (#408) | T33-T34 | Backoff formula, jitter |

## Dispatch Strategy

Three parallel worktrees, no cross-worktree dependencies during development:

```
Worktree: pbt-verification     Tasks: T1-T10   Issues: #341, #343, #342
Worktree: code-quality-view    Tasks: T11-T19  Issues: #345
Worktree: mcp-hardening        Tasks: T20-T34  Issues: #408 P0+P1
```

---

## Worktree 1: pbt-verification

### Review Unit 1: testingStrategy Schema (#341)

#### Task T1: Add PerformanceSLASchema and TestingStrategySchema
**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests in `workflow/schemas.test.ts`:
   - `TestingStrategySchema_ValidMinimal_Parses` — `{ exampleTests: true, propertyTests: false, benchmarks: false }` parses
   - `TestingStrategySchema_WithProperties_Parses` — includes optional `properties` array
   - `TestingStrategySchema_WithPerformanceSLAs_Parses` — includes optional `performanceSLAs` array
   - `TestingStrategySchema_MissingRequired_Rejects` — missing `exampleTests` fails
   - `PerformanceSLASchema_Valid_Parses` — `{ metric: "p95", threshold: 100, unit: "ms" }` parses
   - `PerformanceSLASchema_InvalidUnit_Rejects` — `unit: "seconds"` fails (not in enum)
   - Expected failure: `TestingStrategySchema` not defined

2. **[GREEN]** Implement in `workflow/schemas.ts`:
   - Add `PerformanceSLASchema` with `metric: z.string()`, `threshold: z.number()`, `unit: z.enum(['ms', 'ops/s', 'MB'])`
   - Add `TestingStrategySchema` with required `exampleTests: z.literal(true)`, `propertyTests: z.boolean()`, `benchmarks: z.boolean()`, optional `properties: z.array(z.string())`, optional `performanceSLAs: z.array(PerformanceSLASchema)`

3. **[REFACTOR]** Export types: `TestingStrategy`, `PerformanceSLA`

**Dependencies:** None
**Files:** `workflow/schemas.ts`, `workflow/schemas.test.ts`

#### Task T2: Extend TaskSchema with testingStrategy field
**Phase:** RED → GREEN

1. **[RED]** Write tests in `workflow/schemas.test.ts`:
   - `TaskSchema_WithTestingStrategy_Parses` — task with valid testingStrategy parses
   - `TaskSchema_WithoutTestingStrategy_StillValid` — existing tasks without field still parse (backward compat)
   - `TaskSchema_InvalidTestingStrategy_Rejects` — task with malformed testingStrategy fails
   - Expected failure: `testingStrategy` not recognized by TaskSchema

2. **[GREEN]** Add `testingStrategy: TestingStrategySchema.optional()` to `TaskSchema` in `workflow/schemas.ts`

**Dependencies:** T1
**Files:** `workflow/schemas.ts`, `workflow/schemas.test.ts`

#### Task T3: Update WorkflowStateSchema validation for tasks with testingStrategy
**Phase:** RED → GREEN

1. **[RED]** Write integration test in `workflow/schemas.test.ts`:
   - `WorkflowState_TasksWithTestingStrategy_Parses` — full workflow state with tasks containing testingStrategy validates through WorkflowStateSchema
   - Expected failure: Should pass immediately after T2 (validation test)

2. **[GREEN]** Verify existing schema composition picks up the change (no code needed if T2 is correct — this is a confidence check)

**Dependencies:** T2
**Files:** `workflow/schemas.test.ts`

#### Task T4: Update /plan skill with testingStrategy category guidance
**Phase:** Content update (no TDD — markdown only)

1. Add category → requirement mapping to `skills/implementation-planning/SKILL.md` or a new reference file `skills/implementation-planning/references/testing-strategy-guide.md`
2. Categories: data transformations, state machines, collections, concurrency, serialization → `propertyTests: true`
3. Reference: `docs/designs/2026-02-15-autonomous-code-verification.md#when-to-require-property-based-tests`

**Dependencies:** T2
**Files:** `skills/implementation-planning/SKILL.md` or `skills/implementation-planning/references/testing-strategy-guide.md`

### Review Unit 2: check-property-tests.sh (#343)

#### Task T5: Script scaffold with arg parsing and usage
**Phase:** RED → GREEN

1. **[RED]** Write `scripts/check-property-tests.test.sh`:
   - `exits_2_on_no_args` — script with no arguments exits 2
   - `exits_2_on_missing_plan_file` — `--plan-file` without value exits 2
   - `exits_2_on_missing_worktree_dir` — `--worktree-dir` without value exits 2
   - Expected failure: script doesn't exist

2. **[GREEN]** Create `scripts/check-property-tests.sh`:
   - `set -euo pipefail`
   - Parse `--plan-file` and `--worktree-dir` arguments
   - Print usage and exit 2 on missing args

**Dependencies:** None (parallel with T1-T4)
**Files:** `scripts/check-property-tests.sh`, `scripts/check-property-tests.test.sh`

#### Task T6: Plan JSON extraction for PBT-required tasks
**Phase:** RED → GREEN

1. **[RED]** Add tests to `scripts/check-property-tests.test.sh`:
   - `exits_0_when_no_tasks_require_pbt` — plan JSON with all `propertyTests: false` exits 0
   - `exits_0_when_required_tasks_have_pbt_files` — plan JSON with `propertyTests: true` + matching test files exits 0
   - Expected failure: no extraction logic

2. **[GREEN]** Implement plan JSON parsing:
   - Extract task IDs where `testingStrategy.propertyTests === true`
   - If no tasks require PBT, exit 0 with "No tasks require property-based tests"

**Dependencies:** T5
**Files:** `scripts/check-property-tests.sh`, `scripts/check-property-tests.test.sh`

#### Task T7: PBT pattern detection (TypeScript + .NET)
**Phase:** RED → GREEN

1. **[RED]** Add tests to `scripts/check-property-tests.test.sh`:
   - `detects_typescript_fast_check_patterns` — files with `fc.property`, `fc.assert`, `from 'fast-check'` are recognized
   - `detects_dotnet_fscheck_patterns` — files with `Prop.ForAll`, `using FsCheck`, `[Property]` are recognized
   - Expected failure: no pattern matching logic

2. **[GREEN]** Implement grep-based pattern detection:
   - TypeScript patterns: `fc\.property|fc\.assert|it\.prop|test\.prop|from 'fast-check'`
   - .NET patterns: `Prop\.ForAll|using FsCheck|\[Property\]`

**Dependencies:** T6
**Files:** `scripts/check-property-tests.sh`, `scripts/check-property-tests.test.sh`

#### Task T8: Cross-reference and failure reporting
**Phase:** RED → GREEN

1. **[RED]** Add test to `scripts/check-property-tests.test.sh`:
   - `exits_1_when_required_task_lacks_pbt` — plan has `propertyTests: true` but no matching test file found in worktree → exit 1 with task IDs listed
   - Expected failure: no cross-reference logic

2. **[GREEN]** Implement task → file cross-reference:
   - For each PBT-required task, check if at least one detected PBT file maps to the task
   - On failure: list uncovered task IDs, exit 1
   - On success: report all tasks covered, exit 0

**Dependencies:** T7
**Files:** `scripts/check-property-tests.sh`, `scripts/check-property-tests.test.sh`

### Review Unit 3: PBT Prompt Enrichment (#342)

#### Task T9: Create PBT patterns reference file
**Phase:** Content creation (markdown)

1. Create `skills/delegation/references/pbt-patterns.md` with:
   - Roundtrip pattern (encode/decode, serialize/deserialize) with fast-check + FsCheck examples
   - Invariant pattern (sorted stays sorted, size always >= 0) with examples
   - Idempotence pattern (f(f(x)) === f(x)) with examples
   - Commutativity pattern (order independence) with examples
   - Integration with TDD RED phase: property tests as first test

**Dependencies:** None (parallel with T1-T8)
**Files:** `skills/delegation/references/pbt-patterns.md`

#### Task T10: Add conditional PBT section to implementer prompt
**Phase:** Content update (markdown)

1. Add `## Property-Based Testing Patterns (Conditional)` section to `skills/delegation/references/implementer-prompt.md` after TDD Requirements section
2. Section header: `## Property-Based Testing Patterns`
3. Content: include-by-reference to `pbt-patterns.md` patterns
4. Add injection note in `skills/delegation/SKILL.md` documenting the conditional: "When task has `testingStrategy.propertyTests: true`, include the PBT patterns section from `references/pbt-patterns.md`"

**Dependencies:** T9, T2 (testingStrategy field must exist for the condition to reference)
**Files:** `skills/delegation/references/implementer-prompt.md`, `skills/delegation/SKILL.md`

---

## Worktree 2: code-quality-view

### Review Unit 1: Event Schema + Interfaces (#345 foundation)

#### Task T11: Add quality.regression event type to schema
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/schemas.test.ts`:
   - `QualityRegressionData_Valid_Parses` — `{ skill: "delegation", gate: "typecheck", consecutiveFailures: 3, firstFailureCommit: "abc", lastFailureCommit: "def" }` parses
   - `EventTypes_IncludesQualityRegression` — `EventTypes` array contains `'quality.regression'`
   - Expected failure: `quality.regression` not in EventTypes

2. **[GREEN]** Add to `event-store/schemas.ts`:
   - Add `'quality.regression'` to `EventTypes` array
   - Add `QualityRegressionData` schema
   - Export `QualityRegression` type

**Dependencies:** None
**Files:** `event-store/schemas.ts`, `event-store/schemas.test.ts`

#### Task T12: Define CodeQualityView interfaces and initial projection
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/code-quality-view.test.ts`:
   - `codeQualityProjection_Init_ReturnsEmptyState` — `init()` returns `{ skills: {}, gates: {}, regressions: [], benchmarks: [] }`
   - Expected failure: module doesn't exist

2. **[GREEN]** Create `views/code-quality-view.ts`:
   - Define `SkillQualityMetrics`, `GateMetrics`, `BenchmarkTrend`, `QualityRegression`, `CodeQualityViewState` interfaces
   - Export `CODE_QUALITY_VIEW = 'code-quality'` constant
   - Implement `codeQualityProjection` with `init()` returning empty state and `apply()` returning view unchanged (stub)

**Dependencies:** T11
**Files:** `views/code-quality-view.ts`, `views/code-quality-view.test.ts`

### Review Unit 2: Projection Event Handlers (#345 core)

#### Task T13: Handle gate.executed events in projection
**Phase:** RED → GREEN

1. **[RED]** Write tests in `views/code-quality-view.test.ts`:
   - `Apply_GateExecuted_Passed_UpdatesGateMetrics` — gate pass increments `executionCount` and `passRate`
   - `Apply_GateExecuted_Failed_UpdatesGateMetrics` — gate failure increments count, adds failure reason
   - `Apply_GateExecuted_UpdatesSkillMetrics` — gate execution with skill attribution updates `SkillQualityMetrics`
   - Expected failure: `apply()` returns view unchanged

2. **[GREEN]** Implement `gate.executed` case in `apply()`:
   - Extract `gateName`, `layer`, `passed`, `duration`, `details` from event data
   - Update `gates[gateName]` metrics (count, pass rate, avg duration, failure reasons)
   - Update `skills[skill]` metrics if skill is present in event data or metadata

**Dependencies:** T12
**Files:** `views/code-quality-view.ts`, `views/code-quality-view.test.ts`

#### Task T14: Handle benchmark.completed events in projection
**Phase:** RED → GREEN

1. **[RED]** Write tests in `views/code-quality-view.test.ts`:
   - `Apply_BenchmarkCompleted_AppendsTrend` — benchmark result appends to `benchmarks[]`
   - `Apply_BenchmarkCompleted_UpdatesTrendDirection` — multiple results set `trend` to 'improving'/'stable'/'degrading'
   - Expected failure: no benchmark.completed handler

2. **[GREEN]** Implement `benchmark.completed` case in `apply()`:
   - Extract `results` array from event data
   - For each result: find or create `BenchmarkTrend` for `operation+metric`, append value
   - Calculate `trend` from last 3+ values: improving (decreasing), degrading (increasing), stable

**Dependencies:** T12
**Files:** `views/code-quality-view.ts`, `views/code-quality-view.test.ts`

#### Task T15: Implement regression detection
**Phase:** RED → GREEN

1. **[RED]** Write tests in `views/code-quality-view.test.ts`:
   - `Apply_ThreeConsecutiveGateFailures_CreatesRegression` — 3 sequential `gate.executed` with `passed: false` for same gate creates a `QualityRegression` entry
   - `Apply_GatePass_ResetsFailureCounter` — pass after failures clears the regression
   - Expected failure: no regression tracking

2. **[GREEN]** Implement consecutive failure tracking:
   - Track per-gate consecutive failure count in view state (internal tracking object)
   - When count >= 3, create `QualityRegression` entry with skill, gate, commits, timestamp
   - On pass, reset counter and remove active regression for that gate

**Dependencies:** T13
**Files:** `views/code-quality-view.ts`, `views/code-quality-view.test.ts`

#### Task T16: Handle unrelated events gracefully
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/code-quality-view.test.ts`:
   - `Apply_UnrelatedEvent_ReturnsViewUnchanged` — `task.assigned` event returns same state
   - `Apply_NullData_ReturnsViewUnchanged` — event with undefined data doesn't crash

2. **[GREEN]** Verify default case in switch returns view (should already work from T12 stub, but validates robustness)

**Dependencies:** T12
**Files:** `views/code-quality-view.test.ts`

### Review Unit 3: Registry + Routing (#345 integration)

#### Task T17: Add handleViewCodeQuality handler
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/tools.test.ts`:
   - `HandleViewCodeQuality_ReturnsEmptyState_WhenNoEvents` — returns success with empty CodeQualityViewState
   - `HandleViewCodeQuality_WithWorkflowId_FiltersToStream` — filters events by workflow ID
   - Expected failure: function doesn't exist

2. **[GREEN]** Implement `handleViewCodeQuality` in `views/tools.ts`:
   - Accept `{ workflowId?, skill?, gate?, limit? }` args
   - Get/create materializer, register `codeQualityProjection`
   - Query events, materialize view, apply optional filters
   - Return formatted result

**Dependencies:** T15 (projection must be complete)
**Files:** `views/tools.ts`, `views/tools.test.ts`

#### Task T18: Register code_quality in composite router
**Phase:** RED → GREEN

1. **[RED]** Write test in `views/composite.test.ts`:
   - `HandleView_CodeQuality_RoutesToHandler` — `{ action: 'code_quality' }` dispatches to handler
   - `HandleView_UnknownAction_IncludesCodeQuality` — error's `validTargets` includes `code_quality`
   - Expected failure: `code_quality` not in switch

2. **[GREEN]** Add `case 'code_quality'` to `handleView()` switch in `views/composite.ts`:
   - Import and call `handleViewCodeQuality`
   - Add `'code_quality'` to the `validTargets` array in the default error case

**Dependencies:** T17
**Files:** `views/composite.ts`, `views/composite.test.ts`

#### Task T19: Register code_quality action in tool registry
**Phase:** RED → GREEN

1. **[RED]** Write test in `registry.test.ts`:
   - `ViewActions_IncludesCodeQuality` — `exarchos_view` composite tool has a `code_quality` action
   - Expected failure: action not registered

2. **[GREEN]** Add `code_quality` action to `viewActions` array in `registry.ts`:
   - Schema: `{ workflowId?: string, skill?: string, gate?: string, limit?: coercedPositiveInt }`
   - Phases: `ALL_PHASES`, Roles: `ROLE_ANY`
   - Update `exarchos_view` description to include "code quality"

**Dependencies:** T18
**Files:** `registry.ts`, `registry.test.ts`

---

## Worktree 3: mcp-hardening

### Review Unit 1: P0 — Data Integrity (#408)

#### Task T20: Implement PID lock file acquisition
**Phase:** RED → GREEN

1. **[RED]** Write tests in `event-store/store.test.ts`:
   - `AcquirePidLock_CreatesLockFile_WithCurrentPid` — lock file created at `.event-store.lock` containing process PID
   - `AcquirePidLock_ThrowsWhenLivePidHoldsLock` — throws when another live PID holds the lock
   - Expected failure: no `acquirePidLock` method

2. **[GREEN]** Implement `acquirePidLock()` in `EventStore`:
   - Use `fs.open(lockPath, 'wx')` for atomic creation (O_CREAT|O_EXCL)
   - Write PID to lock file
   - On EEXIST: read existing PID, check if alive

**Dependencies:** None
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T21: Implement stale lock reclaim
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `AcquirePidLock_ReclaimsStaleLock_WhenPidDead` — stale lock file (PID not alive) is reclaimed
   - Expected failure: no stale detection logic

2. **[GREEN]** Add to `acquirePidLock()`:
   - `isPidAlive(pid)` helper using `process.kill(pid, 0)` (signal 0 tests existence)
   - If PID not alive: overwrite lock file with current PID

**Dependencies:** T20
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T22: Add lock file cleanup on process exit
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `AcquirePidLock_RegistersExitCleanup` — verify cleanup handler registered (mock process.on)
   - Expected failure: no cleanup registration

2. **[GREEN]** Register `process.on('exit', ...)` handler that removes the lock file synchronously

**Dependencies:** T21
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T23: Call acquirePidLock during EventStore initialization
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `EventStore_Initialize_AcquiresPidLock` — constructing/initializing EventStore acquires the PID lock
   - Expected failure: constructor doesn't call lock

2. **[GREEN]** Add `initialize()` async method to EventStore, called before first `append()` or `query()`:
   - Call `acquirePidLock()`
   - Guard with `initialized` flag to run only once

**Dependencies:** T22
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T24: Add sequence invariant validation at cold-start
**Phase:** RED → GREEN

1. **[RED]** Write tests in `event-store/store.test.ts`:
   - `InitializeSequence_ValidInvariant_Succeeds` — file where line N has sequence N passes
   - `InitializeSequence_BrokenInvariant_Throws` — file where line 1 has sequence 5 throws descriptive error
   - Expected failure: no invariant validation in `initializeSequence()`

2. **[GREEN]** Add to `initializeSequence()` fallback path (line-counting branch):
   - After reading lines, sample-validate: check first and last line's `sequence` field matches expected position
   - Throw `Error('Sequence invariant violated: line N has sequence M')` on mismatch

**Dependencies:** None (parallel with T20-T23)
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T25: Validate sequence invariant with blank-line tolerance
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/store.test.ts`:
   - `InitializeSequence_WithBlankLines_ValidatesCorrectly` — JSONL with interspersed blank lines still validates correctly (blank lines filtered before checking)
   - Expected failure: blank lines may throw off line count vs sequence

2. **[GREEN]** Ensure blank-line filtering occurs before invariant validation (use same `filter(Boolean)` pattern)

**Dependencies:** T24
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

### Review Unit 2: P1 — Observability + Configuration (#408)

#### Task T26: Add workflow.cas-failed event type to schema
**Phase:** RED → GREEN

1. **[RED]** Write test in `event-store/schemas.test.ts`:
   - `WorkflowCasFailedData_Valid_Parses` — `{ featureId: "test", phase: "delegate", retries: 3 }` parses
   - `EventTypes_IncludesWorkflowCasFailed` — `EventTypes` contains `'workflow.cas-failed'`
   - Expected failure: type not defined

2. **[GREEN]** Add to `event-store/schemas.ts`:
   - Add `'workflow.cas-failed'` to `EventTypes` array
   - Add `WorkflowCasFailedData` schema: `{ featureId: z.string(), phase: z.string(), retries: z.number().int() }`
   - Export type

**Dependencies:** None
**Files:** `event-store/schemas.ts`, `event-store/schemas.test.ts`

#### Task T27: Emit diagnostic event on CAS retry exhaustion
**Phase:** RED → GREEN

1. **[RED]** Write test in `workflow/tools.test.ts`:
   - `HandleSet_CasExhausted_EmitsWorkflowCasFailed` — when CAS retries exhaust, a `workflow.cas-failed` event is appended before throwing
   - Expected failure: no event emission on exhaustion

2. **[GREEN]** Modify `handleSet()` in `workflow/tools.ts`:
   - Before the final `throw` after loop exhaustion (line ~496-499), append `workflow.cas-failed` event to the stream
   - Include `featureId`, current `phase`, and `MAX_CAS_RETRIES` in event data

**Dependencies:** T26
**Files:** `workflow/tools.ts`, `workflow/tools.test.ts`

#### Task T28: Add CAS retry count to error message
**Phase:** REFACTOR

1. Ensure the error message from CAS exhaustion includes the feature ID and phase for diagnostics
2. Verify existing test expectations still pass

**Dependencies:** T27
**Files:** `workflow/tools.ts`

#### Task T29: Make LRU cache size configurable via env var
**Phase:** RED → GREEN

1. **[RED]** Write tests in `views/materializer.test.ts`:
   - `ViewMaterializer_RespectsEnvVar_MaxCacheEntries` — set `EXARCHOS_MAX_CACHE_ENTRIES=5`, verify eviction at 5
   - `ViewMaterializer_DefaultsTo100_WhenNoEnvVar` — without env var, default is 100
   - Expected failure: env var not read

2. **[GREEN]** Modify `views/materializer.ts`:
   - Read `process.env.EXARCHOS_MAX_CACHE_ENTRIES` in module scope
   - Parse to int, fall back to `DEFAULT_MAX_CACHE_ENTRIES` (100)
   - Pass as default `maxCacheEntries` in constructor

**Dependencies:** None
**Files:** `views/materializer.ts`, `views/materializer.test.ts`

#### Task T30: Validate env var parsing edge cases
**Phase:** RED → GREEN

1. **[RED]** Write tests:
   - `ViewMaterializer_InvalidEnvVar_FallsBackToDefault` — `EXARCHOS_MAX_CACHE_ENTRIES=abc` falls back to 100
   - `ViewMaterializer_ZeroEnvVar_FallsBackToDefault` — `EXARCHOS_MAX_CACHE_ENTRIES=0` falls back to 100

2. **[GREEN]** Add validation: `isNaN` or `<= 0` → use default

**Dependencies:** T29
**Files:** `views/materializer.ts`, `views/materializer.test.ts`

#### Task T31: Make idempotency cache size configurable
**Phase:** RED → GREEN

1. **[RED]** Write tests in `event-store/store.test.ts`:
   - `EventStore_RespectsEnvVar_MaxIdempotencyKeys` — set `EXARCHOS_MAX_IDEMPOTENCY_KEYS=50`, verify eviction at 50
   - `EventStore_DefaultsTo200_WhenNoEnvVar` — default increased from 100 to 200
   - Expected failure: static field ignores env var

2. **[GREEN]** Modify `event-store/store.ts`:
   - Change `private static readonly MAX_IDEMPOTENCY_KEYS = 100` to a computed value
   - Read `process.env.EXARCHOS_MAX_IDEMPOTENCY_KEYS`, parse to int, default 200
   - Store as module-level constant or static getter

**Dependencies:** None
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T32: Validate idempotency env var edge cases
**Phase:** RED → GREEN

1. **[RED]** Write tests:
   - `EventStore_InvalidIdempotencyEnvVar_FallsBackToDefault` — `EXARCHOS_MAX_IDEMPOTENCY_KEYS=abc` falls back to 200
   - Expected failure: no validation

2. **[GREEN]** Add same `isNaN`/`<= 0` guard as T30

**Dependencies:** T31
**Files:** `event-store/store.ts`, `event-store/store.test.ts`

#### Task T33: Add exponential backoff to task claim retries
**Phase:** RED → GREEN

1. **[RED]** Write tests in `tasks/tools.test.ts`:
   - `HandleTaskClaim_Retries_WithExponentialBackoff` — mock clock to verify delays are ~50ms, ~100ms, ~200ms (with jitter)
   - `HandleTaskClaim_StillReturnsClaimFailed_AfterRetries` — final error message unchanged
   - Expected failure: retries are immediate (no delay)

2. **[GREEN]** Modify `handleTaskClaim()` in `tasks/tools.ts`:
   - Add `await sleep(baseDelay * 2^attempt + jitter)` between retries
   - `baseDelay = 50`, jitter = `Math.random() * baseDelay`
   - Extract `sleep` helper: `const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))`

**Dependencies:** None
**Files:** `tasks/tools.ts`, `tasks/tools.test.ts`

#### Task T34: Validate backoff doesn't exceed reasonable bounds
**Phase:** RED → GREEN

1. **[RED]** Write test:
   - `HandleTaskClaim_BackoffCapped_AtReasonableMax` — with MAX_CLAIM_RETRIES=3, total delay < 500ms

2. **[GREEN]** Verify formula: 50 + 100 + 200 = 350ms base + jitter (< 500ms total). No code change needed if formula is correct.

**Dependencies:** T33
**Files:** `tasks/tools.test.ts`

---

## Task Summary

| ID | Title | Issue | Worktree | Dependencies |
|----|-------|-------|----------|--------------|
| T1 | PerformanceSLA + TestingStrategy schemas | #341 | pbt-verification | — |
| T2 | Extend TaskSchema with testingStrategy | #341 | pbt-verification | T1 |
| T3 | WorkflowState integration validation | #341 | pbt-verification | T2 |
| T4 | /plan skill category guidance | #341 | pbt-verification | T2 |
| T5 | Script scaffold + arg parsing | #343 | pbt-verification | — |
| T6 | Plan JSON extraction | #343 | pbt-verification | T5 |
| T7 | PBT pattern detection (TS + .NET) | #343 | pbt-verification | T6 |
| T8 | Cross-reference + failure reporting | #343 | pbt-verification | T7 |
| T9 | PBT patterns reference file | #342 | pbt-verification | — |
| T10 | Conditional PBT section in prompt | #342 | pbt-verification | T9, T2 |
| T11 | quality.regression event schema | #345 | code-quality-view | — |
| T12 | CodeQualityView interfaces + init | #345 | code-quality-view | T11 |
| T13 | gate.executed handler | #345 | code-quality-view | T12 |
| T14 | benchmark.completed handler | #345 | code-quality-view | T12 |
| T15 | Regression detection | #345 | code-quality-view | T13 |
| T16 | Unrelated event handling | #345 | code-quality-view | T12 |
| T17 | handleViewCodeQuality handler | #345 | code-quality-view | T15 |
| T18 | Composite router registration | #345 | code-quality-view | T17 |
| T19 | Tool registry registration | #345 | code-quality-view | T18 |
| T20 | PID lock file acquisition | #408 | mcp-hardening | — |
| T21 | Stale lock reclaim | #408 | mcp-hardening | T20 |
| T22 | Lock cleanup on exit | #408 | mcp-hardening | T21 |
| T23 | Lock during EventStore init | #408 | mcp-hardening | T22 |
| T24 | Sequence invariant validation | #408 | mcp-hardening | — |
| T25 | Blank-line tolerance for invariant | #408 | mcp-hardening | T24 |
| T26 | workflow.cas-failed event schema | #408 | mcp-hardening | — |
| T27 | CAS exhaustion diagnostic event | #408 | mcp-hardening | T26 |
| T28 | CAS error message improvement | #408 | mcp-hardening | T27 |
| T29 | Configurable LRU cache size | #408 | mcp-hardening | — |
| T30 | LRU env var edge cases | #408 | mcp-hardening | T29 |
| T31 | Configurable idempotency cache | #408 | mcp-hardening | — |
| T32 | Idempotency env var edge cases | #408 | mcp-hardening | T31 |
| T33 | Exponential backoff for claims | #408 | mcp-hardening | — |
| T34 | Backoff bounds validation | #408 | mcp-hardening | T33 |

## Parallel Execution Within Worktrees

**pbt-verification** internal parallelism:
- Chain 1: T1 → T2 → T3 → T4 → T10
- Chain 2: T5 → T6 → T7 → T8 (parallel with Chain 1)
- Chain 3: T9 → T10 (parallel with Chain 2, joins with Chain 1 at T10)

**code-quality-view** internal sequence:
- T11 → T12 → [T13, T14, T16 parallel] → T15 → T17 → T18 → T19

**mcp-hardening** internal parallelism (4 independent chains):
- Chain 1: T20 → T21 → T22 → T23
- Chain 2: T24 → T25
- Chain 3: T26 → T27 → T28
- Chain 4: T29 → T30 (parallel with T31 → T32, parallel with T33 → T34)
