# Eval Framework Phase 3 — Post-Merge Follow-Ups

**Date:** 2026-02-20
**Design:** `docs/designs/2026-02-20-eval-framework-phase-2.md`
**Depends on:** Phase 2 PRs #640-642 merged

## Overview

Four focused improvements identified during Phase 2 review: connect the event pipeline, reduce duplication, fix CI gate behavior, and fix a script bug.

---

## Stream A: Wire EventStore into CLI eval-run

**Goal:** Connect the event emission infrastructure so eval runs produce events that the EvalResultsView can materialize.

### Task A1: Wire EventStore into handleEvalRun

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `HandleEvalRun_WithEventStore_PassesOptionsToRunAll`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-run.test.ts`
   - Verify `runAll` is called with `{ eventStore, streamId, trigger }` options
   - Expected failure: runAll called without EventStore options

2. **[GREEN]** Wire EventStore in `handleEvalRun()`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-run.ts`
   - Import `getOrCreateEventStore` from `../views/tools.js`
   - Create EventStore with `resolveStateDir()` pattern
   - Pass `{ eventStore, streamId: 'evals', trigger: ciMode ? 'ci' : 'local' }` to `runAll()`

3. **[REFACTOR]** Extract state dir resolution if duplicated

**Dependencies:** None
**Parallelizable:** Yes

### Task A2: Verify EvalResultsView materializes from CLI events

**Phase:** RED → GREEN

1. **[RED]** Write integration test: `EvalResultsView_AfterCliRun_MaterializesResults`
   - File: `servers/exarchos-mcp/src/views/eval-results-view.test.ts`
   - Run eval through CLI pipeline → check view materializes correct scores

2. **[GREEN]** Fix any stream ID mismatches between CLI emission and view subscription

**Dependencies:** Task A1
**Parallelizable:** No

---

## Stream B: Extract shared LLM grader helper

**Goal:** DRY the duplicated error handling between `llm-rubric.ts` and `llm-similarity.ts`.

### Task B1: Extract LLM assertion helper

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `CallLlmAssertion_NoApiKey_ReturnsSkipped`
   - File: `servers/exarchos-mcp/src/evals/graders/llm-helper.test.ts`
   - Test: helper returns skipped GradeResult when no API key
   - Expected failure: module does not exist

2. **[RED]** Write test: `CallLlmAssertion_ApiError_ReturnsGracefulFailure`
   - Test: helper catches promptfoo errors and returns structured GradeResult

3. **[GREEN]** Implement `callLlmAssertion()` helper
   - File: `servers/exarchos-mcp/src/evals/graders/llm-helper.ts`
   - Handles: API key check, dynamic import, error wrapping, score normalization
   - Signature: `callLlmAssertion(fn: (...args) => Promise<Result>, args: unknown[], details: Record<string, unknown>): Promise<GradeResult>`

4. **[REFACTOR]** Simplify both graders to use the helper
   - Files: `llm-rubric.ts`, `llm-similarity.ts`
   - Each grader reduces to: validate config → prepare args → call helper

**Dependencies:** None
**Parallelizable:** Yes (with Stream A and C)

---

## Stream C: Fix CI gate exit code

**Goal:** Make the eval gate actually fail CI when regressions are detected.

### Task C1: Set process.exitCode on eval failures

**Phase:** RED → GREEN

1. **[RED]** Write test: `HandleEvalRun_Failures_SetsExitCode1`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-run.test.ts`
   - Verify `process.exitCode` is set to 1 when `passed: false`
   - Expected failure: exitCode not set

2. **[GREEN]** Add exit code logic to `cli.ts`
   - File: `servers/exarchos-mcp/src/cli.ts`
   - After `routeCommand()`, check if command is `eval-run` and `result.passed === false`
   - Set `process.exitCode = 1`

**Dependencies:** None
**Parallelizable:** Yes

---

## Stream D: Fix verify-plan-coverage.sh unbound variable

**Goal:** Fix GitHub issue #639 — script fails with unbound variable when no tasks found.

### Task D1: Fix PLAN_TASKS array iteration

**Phase:** RED → GREEN

1. **[RED]** Write test case in `scripts/verify-plan-coverage.test.sh`
   - Test: script handles plan with no `### Task` headers gracefully
   - Expected: exit code 1 (no tasks found) instead of unbound variable crash

2. **[GREEN]** Fix array references
   - File: `scripts/verify-plan-coverage.sh`
   - Change `"${PLAN_TASKS[@]}"` → `"${PLAN_TASKS[@]:-}"` at lines 157 and 172
   - Add guard: `if [[ ${#PLAN_TASKS[@]} -eq 0 ]]; then ... fi`

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization

All 4 streams are independent:

```text
Stream A (EventStore wiring)  ─── T:A1 → T:A2
Stream B (LLM helper DRY)     ─── T:B1
Stream C (CI exit code)        ─── T:C1
Stream D (Script bug fix)      ─── T:D1
```

**Estimated tasks:** 5 (across 4 streams)
**All parallelizable** — can use 4 worktrees.
