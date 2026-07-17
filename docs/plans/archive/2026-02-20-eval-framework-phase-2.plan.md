# Implementation Plan: SDLC Eval Framework Phase 2

## Source Design

Link: `docs/designs/2026-02-20-eval-framework-phase-2.md`

## Scope

**Target:** Full Phase 2 — Promptfoo LLM graders, eval event schema + emission, EvalResultsView CQRS projection, `eval_results` view action, CI reporter + eval-gate workflow, and a capability eval suite with LLM assertions.

**Excluded:**
- Phase 3 items (trace capture hook, `eval-capture` CLI, `eval-compare` CLI)
- Phase 4 items (flywheel iteration, synthetic dataset generation)
- Reliability eval suites (Phase 3)
- Promptfoo caching configuration (optimization, not MVP)

## Summary

- Total tasks: 14
- Parallel streams: 3
- Estimated test count: ~55
- Design coverage: All 5 Technical Design sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Technical Design > 1. Promptfoo LLM Graders > 1a. LLM Rubric Grader | `LlmRubricGrader` implementing `IGrader`, wraps `matchesLlmRubric`, configurable rubric + model | T03, T04 | Covered |
| Technical Design > 1. Promptfoo LLM Graders > 1b. Similarity Grader | `LlmSimilarityGrader` implementing `IGrader`, wraps `matchesSimilarity`, threshold config | T03, T05 | Covered |
| Technical Design > 1. Promptfoo LLM Graders > 1c. Registration | Register in `GraderRegistry`, extend `AssertionConfigSchema` type enum | T06 | Covered |
| Technical Design > 1. Promptfoo LLM Graders > 1d. API Key | `ANTHROPIC_API_KEY` env var (no code — existing infrastructure) | — | Covered (no-op) |
| Technical Design > 2. Eval Event Schema > New Event Types | 3 event types in `EventTypes` array | T07 | Covered |
| Technical Design > 2. Eval Event Schema > New Data Schemas | `EvalRunStartedData`, `EvalCaseCompletedData`, `EvalRunCompletedData` Zod schemas | T07 | Covered |
| Technical Design > 2. Eval Event Schema > Harness Integration | Optional `EventStore` param on `runSuite()`, emit events during execution | T08 | Covered |
| Technical Design > 3. EvalResultsView > View State | `EvalResultsViewState` with skills, runs, regressions | T09 | Covered |
| Technical Design > 3. EvalResultsView > Projection | `evalResultsProjection` handling `eval.run.completed` + `eval.case.completed` | T09 | Covered |
| Technical Design > 3. EvalResultsView > Registration | Register in `createMaterializer()` | T10 | Covered |
| Technical Design > 4. `eval_results` View Action | Routing in `composite.ts`, `handleViewEvalResults` handler | T10 | Covered |
| Technical Design > 5. CI Eval Gate > 5a. CI Reporter | `formatCIReport()` with GitHub Actions annotation format | T11 | Covered |
| Technical Design > 5. CI Eval Gate > 5b. CLI Integration | `--ci` flag on `eval-run`, exit code logic | T12 | Covered |
| Technical Design > 5. CI Eval Gate > 5c. GitHub Actions Workflow | `.github/workflows/eval-gate.yml` | T13 | Covered |
| Cross-cutting > Capability eval suite | Suite with `llm-rubric` assertions for at least 1 skill | T14 | Covered |

## Task Breakdown

### Stream 1: Promptfoo LLM Graders

---

### Task T01: Install promptfoo devDependency

**Phase:** Setup (no TDD — dependency installation)

1. Add `promptfoo` to `devDependencies` in `servers/exarchos-mcp/package.json`
2. Run `npm install` to verify successful installation
3. Verify `import { assertions } from 'promptfoo'` compiles in TypeScript

**Dependencies:** None
**Parallelizable:** Yes (Stream 1 start)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T02: Implement extractOutputText helper

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write test: `extractOutputText_WithDotPath_ReturnsNestedValue`
   - File: `servers/exarchos-mcp/src/evals/graders/output-extractor.test.ts`
   - Tests:
     - `extractOutputText_NoPath_ReturnsStringifiedOutput`
     - `extractOutputText_WithSimplePath_ReturnsFieldValue`
     - `extractOutputText_WithDotPath_ReturnsNestedValue`
     - `extractOutputText_WithMissingPath_ReturnsStringifiedOutput`
     - `extractOutputText_WithArrayPath_ReturnsStringifiedArray`
     - `extractOutputText_WithStringValue_ReturnsDirectly`
   - Expected failure: `Cannot find module './output-extractor.js'`

2. **[GREEN]** Implement `extractOutputText(output, outputPath?)` in `output-extractor.ts`
   - File: `servers/exarchos-mcp/src/evals/graders/output-extractor.ts`
   - Dot-notation path traversal (e.g., `"tasks.0.title"`)
   - Falls back to `JSON.stringify(output)` when path is missing or undefined

3. **[REFACTOR]** Extract dot-path traversal into standalone `getByPath` utility if needed

**Dependencies:** None
**Parallelizable:** Yes (parallel with T01)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T03: Implement LlmRubricGrader

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/evals/graders/llm-rubric.test.ts`
   - Tests (mock `promptfoo` assertions module):
     - `LlmRubricGrader_PassingRubric_ReturnsPassedWithScore`
     - `LlmRubricGrader_FailingRubric_ReturnsFailedWithReason`
     - `LlmRubricGrader_WithModelConfig_PassesProviderString`
     - `LlmRubricGrader_WithOutputPath_ExtractsNestedField`
     - `LlmRubricGrader_NoRubricInConfig_ThrowsError`
     - `LlmRubricGrader_NullScore_DefaultsBasedOnPass`
     - `LlmRubricGrader_PartialScore_ReturnsExactScore`
   - Expected failure: `Cannot find module './llm-rubric.js'`

2. **[GREEN]** Implement `LlmRubricGrader` class
   - File: `servers/exarchos-mcp/src/evals/graders/llm-rubric.ts`
   - Implements `IGrader` interface
   - Wraps `assertions.matchesLlmRubric` from `promptfoo`
   - Uses `extractOutputText` from T02
   - Config: `{ rubric: string, model?: string, outputPath?: string }`
   - Maps Promptfoo result `{ pass, score, reason }` → `GradeResult`

3. **[REFACTOR]** Extract common Promptfoo result mapping if pattern emerges

**Dependencies:** T01 (promptfoo installed), T02 (extractOutputText)
**Parallelizable:** No (sequential within Stream 1 after T01+T02)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T04: Verify Promptfoo provider string format

**Phase:** RED → GREEN

1. **[RED]** Write integration smoke test:
   - File: `servers/exarchos-mcp/src/evals/graders/llm-rubric.test.ts` (append)
   - Test (marked `describe.skipIf(!process.env.ANTHROPIC_API_KEY)`):
     - `LlmRubricGrader_RealAnthropicCall_ReturnsValidGradeResult`
   - Uses a trivial rubric: "Does the output contain the word 'hello'?" against input "hello world"
   - Expected failure: Test fails if provider string format is wrong

2. **[GREEN]** Fix provider string format if needed (e.g., `anthropic:messages:model-id` vs `anthropic:chat:model-id`)

**Dependencies:** T03
**Parallelizable:** No (sequential after T03)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T05: Implement LlmSimilarityGrader

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/evals/graders/llm-similarity.test.ts`
   - Tests (mock `promptfoo` assertions module):
     - `LlmSimilarityGrader_SimilarTexts_ReturnsPassedWithHighScore`
     - `LlmSimilarityGrader_DissimilarTexts_ReturnsFailed`
     - `LlmSimilarityGrader_WithCustomThreshold_UsesConfigThreshold`
     - `LlmSimilarityGrader_WithOutputPath_ExtractsNestedField`
     - `LlmSimilarityGrader_WithExpectedInConfig_UsesConfigExpected`
     - `LlmSimilarityGrader_NoExpectedInConfig_FallsBackToExpectedParam`
   - Expected failure: `Cannot find module './llm-similarity.js'`

2. **[GREEN]** Implement `LlmSimilarityGrader` class
   - File: `servers/exarchos-mcp/src/evals/graders/llm-similarity.ts`
   - Implements `IGrader` interface
   - Wraps `assertions.matchesSimilarity` from `promptfoo`
   - Uses `extractOutputText` from T02
   - Config: `{ expected?: string, threshold?: number, outputPath?: string }`

3. **[REFACTOR]** Factor shared config extraction patterns with T03 if duplicated

**Dependencies:** T01 (promptfoo installed), T02 (extractOutputText)
**Parallelizable:** Yes (parallel with T03)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T06: Register LLM graders and extend AssertionConfigSchema

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/evals/graders/index.test.ts` (extend)
   - Tests:
     - `createDefaultRegistry_ResolvesLlmRubricGrader`
     - `createDefaultRegistry_ResolvesLlmSimilarityGrader`
   - File: `servers/exarchos-mcp/src/evals/types.test.ts` (extend)
   - Tests:
     - `AssertionConfigSchema_LlmRubricType_ParsesValid`
     - `AssertionConfigSchema_LlmSimilarityType_ParsesValid`
   - Expected failure: `Unknown grader type: llm-rubric`

2. **[GREEN]** Update `createDefaultRegistry()` in `graders/index.ts` to register both LLM graders. Extend `AssertionConfigSchema` type enum in `types.ts` to include `'llm-rubric'` and `'llm-similarity'`.

3. **[REFACTOR]** Ensure imports are clean — lazy-load promptfoo graders to avoid import errors when promptfoo isn't installed (optional peer dependency pattern)

**Dependencies:** T03, T05 (both graders implemented)
**Parallelizable:** No (requires T03 + T05)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Stream 2: Eval Events + EvalResultsView

---

### Task T07: Add eval event types and data schemas

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` (extend)
   - Tests:
     - `EvalRunStartedData_ValidPayload_Parses`
     - `EvalRunStartedData_MissingRunId_Fails`
     - `EvalRunStartedData_InvalidTrigger_Fails`
     - `EvalCaseCompletedData_ValidPayload_Parses`
     - `EvalCaseCompletedData_ScoreOutOfRange_Fails`
     - `EvalCaseCompletedData_EmptyAssertions_Parses`
     - `EvalRunCompletedData_ValidPayload_Parses`
     - `EvalRunCompletedData_NegativeFailed_Fails`
     - `WorkflowEventBase_EvalRunStartedType_Parses`
     - `WorkflowEventBase_EvalCaseCompletedType_Parses`
     - `WorkflowEventBase_EvalRunCompletedType_Parses`
   - Expected failure: Zod enum doesn't include `eval.run.started`

2. **[GREEN]** Add to `schemas.ts`:
   - 3 event types to `EventTypes` array: `'eval.run.started'`, `'eval.case.completed'`, `'eval.run.completed'`
   - 3 data schemas: `EvalRunStartedData`, `EvalCaseCompletedData`, `EvalRunCompletedData`
   - 3 type exports: `EvalRunStarted`, `EvalCaseCompleted`, `EvalRunCompleted`

3. **[REFACTOR]** Ensure consistent ordering in `EventTypes` (group eval events together)

**Dependencies:** None
**Parallelizable:** Yes (Stream 2 start, parallel with Stream 1)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T08: Extend harness runSuite with event emission

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/evals/harness.test.ts` (extend)
   - Tests:
     - `runSuite_WithEventStore_EmitsRunStartedEvent`
     - `runSuite_WithEventStore_EmitsCaseCompletedPerCase`
     - `runSuite_WithEventStore_EmitsRunCompletedWithSummary`
     - `runSuite_WithEventStore_EventsInCorrectOrder`
     - `runSuite_WithoutEventStore_NoEventsEmitted`
     - `runSuite_WithTriggerOption_PassesTriggerInStartedEvent`
   - Expected failure: `runSuite` doesn't accept options parameter (or ignores it)

2. **[GREEN]** Extend `runSuite()` signature:
   - Add optional `options?: { eventStore?: EventStore; streamId?: string; trigger?: 'ci' | 'local' | 'scheduled' }`
   - Emit `eval.run.started` before grading loop
   - Emit `eval.case.completed` after each case grades
   - Emit `eval.run.completed` with aggregated summary after all cases
   - Use mock/spy on EventStore in tests — no real file I/O

3. **[REFACTOR]** Extract event emission into a helper if it clutters the grading loop

**Dependencies:** T07 (eval event types exist in schemas)
**Parallelizable:** No (sequential after T07)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T09: Implement EvalResultsView CQRS projection

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/views/eval-results-view.test.ts`
   - Tests:
     - `evalResultsProjection_Init_ReturnsEmptyState`
     - `evalResultsProjection_EvalRunCompleted_AddsRunRecord`
     - `evalResultsProjection_EvalRunCompleted_UpdatesSkillMetrics`
     - `evalResultsProjection_MultipleRuns_CalculatesTrend`
     - `evalResultsProjection_ThreeImprovingRuns_TrendIsImproving`
     - `evalResultsProjection_ThreeDegradingRuns_TrendIsDegrading`
     - `evalResultsProjection_StableScores_TrendIsStable`
     - `evalResultsProjection_EvalCaseCompleted_TracksPassHistory`
     - `evalResultsProjection_CasePreviouslyPassedNowFails_DetectsRegression`
     - `evalResultsProjection_CaseFailsThenPasses_ClearsRegression`
     - `evalResultsProjection_ConsecutiveFailures_IncrementsRegressionCount`
     - `evalResultsProjection_UnknownEventType_ReturnsUnchanged`
     - `evalResultsProjection_RunWithRegressions_UpdatesRegressionCount`
   - Expected failure: `Cannot find module './eval-results-view.js'`

2. **[GREEN]** Implement `eval-results-view.ts`:
   - `EVAL_RESULTS_VIEW` constant
   - Interfaces: `SkillEvalMetrics`, `EvalRunRecord`, `EvalRegression`, `EvalResultsViewState`
   - `evalResultsProjection: ViewProjection<EvalResultsViewState>` with `init()` and `apply()`
   - `handleEvalRunCompleted()` — updates skills, appends run record, calculates trend
   - `handleEvalCaseCompleted()` — tracks per-case history, detects regressions
   - Follow `CodeQualityView` patterns: `runningAverage`, `calculateTrend`, internal tracking state

3. **[REFACTOR]** Extract trend calculation into shared utility if duplicated with `CodeQualityView`

**Dependencies:** T07 (event types for switch cases)
**Parallelizable:** Yes (parallel with T08 — both depend on T07 but not on each other)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T10: Register EvalResultsView and add eval_results view action

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/views/eval-results-view.test.ts` (extend, integration)
   - Tests:
     - `handleViewEvalResults_NoEvents_ReturnsEmptyState`
     - `handleViewEvalResults_WithSkillFilter_FiltersResults`
     - `handleViewEvalResults_WithLimit_LimitsRunsAndRegressions`
   - File: `servers/exarchos-mcp/src/views/composite.test.ts` (extend if exists)
   - Tests:
     - `handleView_EvalResultsAction_RoutesToHandler`
     - `handleView_UnknownAction_IncludesEvalResultsInValidTargets`
   - Expected failure: `Unknown view action: eval_results`

2. **[GREEN]** Implementation:
   - Add `handleViewEvalResults` to `tools.ts` (follows `handleViewCodeQuality` pattern)
   - Import and register `evalResultsProjection` in `createMaterializer()` in `tools.ts`
   - Add `'eval_results'` case to `composite.ts` switch
   - Add `'eval_results'` to `validTargets` array in default case
   - Import `EvalResultsViewState` and `EVAL_RESULTS_VIEW` in `tools.ts`

3. **[REFACTOR]** Ensure handler follows exact same error handling pattern as other view handlers

**Dependencies:** T09 (projection exists)
**Parallelizable:** No (sequential after T09)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Stream 3: CI Gate

---

### Task T11: Implement CI reporter

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/evals/reporters/ci-reporter.test.ts`
   - Tests:
     - `formatCIReport_AllPassing_ReturnsNoticeAnnotations`
     - `formatCIReport_WithFailures_ReturnsErrorAnnotations`
     - `formatCIReport_ErrorAnnotation_IncludesCaseId`
     - `formatCIReport_ErrorAnnotation_IncludesFailedAssertionReasons`
     - `formatCIReport_NoticeAnnotation_IncludesPassCount`
     - `formatCIReport_NoticeAnnotation_IncludesScorePercentage`
     - `formatCIReport_MultipleSuites_ReportsEachSuite`
     - `formatCIReport_EmptySummaries_ReturnsEmptyString`
     - `formatFailedAssertions_SingleFailure_FormatsReason`
     - `formatFailedAssertions_MultipleFailures_JoinsReasons`
   - Expected failure: `Cannot find module './ci-reporter.js'`

2. **[GREEN]** Implement `ci-reporter.ts`:
   - `formatCIReport(summaries: RunSummary[]): string`
   - `formatFailedAssertions(result: EvalResult): string`
   - Uses `::error title=...::message` and `::notice title=...::message` formats
   - Groups output by suite

3. **[REFACTOR]** Ensure annotation text is properly escaped (no unbalanced `::`)

**Dependencies:** None
**Parallelizable:** Yes (Stream 3 start, parallel with all streams)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T12: Add --ci flag to eval-run CLI command

**Phase:** RED → GREEN → REFACTOR

1. **[RED]** Write tests:
   - File: `servers/exarchos-mcp/src/cli-commands/eval-run.test.ts` (extend)
   - Tests:
     - `handleEvalRun_CiFlag_UsesFormatCIReport`
     - `handleEvalRun_CiFlag_AllPass_ExitCodeZero`
     - `handleEvalRun_CiFlag_Failures_ExitCodeOne`
     - `handleEvalRun_NoCiFlag_UsesCliReporter`
   - Expected failure: `handleEvalRun` doesn't accept CI flag

2. **[GREEN]** Extend `handleEvalRun`:
   - Accept `ci` flag from stdin data (or detect `--ci` in process.argv)
   - When `ci: true`: use `formatCIReport` from CI reporter, write to stdout, set exit code
   - When `ci: false/absent`: existing behavior (CLI reporter to stderr)
   - Exit code 1 on any failure in CI mode

3. **[REFACTOR]** Clean up the branching — keep the reporter selection clear

**Dependencies:** T11 (CI reporter exists)
**Parallelizable:** No (sequential after T11)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task T13: Create eval-gate GitHub Actions workflow

**Phase:** Content only (YAML, no TDD — infrastructure)

1. Create `.github/workflows/eval-gate.yml`:
   - Triggers on `pull_request` with paths filter: `skills/**`, `commands/**`, `rules/**`, `servers/exarchos-mcp/src/**`, `evals/**`
   - Job `eval-regression`:
     - `actions/checkout@v4`
     - `actions/setup-node@v4` with `node-version: '22'`
     - `npm ci` in `servers/exarchos-mcp`
     - `npm run build` in `servers/exarchos-mcp`
     - Run `node dist/cli.js eval-run` with `--ci` flag via stdin JSON `{"ci": true}`
     - `ANTHROPIC_API_KEY` from secrets
     - `EVALS_DIR` pointing to `../../../evals`

**Dependencies:** T12 (--ci flag works)
**Parallelizable:** No (sequential after T12)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Stream Cross-Cutting

---

### Task T14: Create capability eval suite with LLM rubric assertions

**Phase:** Content + RED → GREEN

1. **[RED]** Extend existing delegation eval suite (`evals/delegation/suite.json`):
   - Add `llm-rubric` assertion for task decomposition quality
   - Create `evals/delegation/datasets/capability-llm.jsonl` with 3-5 cases that require LLM judgment (e.g., "does this decomposition cover all design sections?")

2. **[GREEN]** Verify the suite runs end-to-end:
   - `node dist/cli.js eval-run` with `{"skill": "delegation"}` resolves LLM graders
   - LLM rubric assertion produces valid scores
   - CLI reporter shows LLM-graded results alongside code-graded results

3. **[REFACTOR]** Tune rubric wording based on initial results if scores are miscalibrated

**Dependencies:** T06 (LLM graders registered), T01 (promptfoo installed)
**Parallelizable:** No (requires all Stream 1 tasks)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

## Parallelization Map

```
Stream 1 (Graders):      T01 ─┬─ T03 → T04
                               │          ↘
                          T02 ─┤           T06 → T14
                               │          ↗
                               └─ T05 ──┘

Stream 2 (Events+View):  T07 ─┬─ T08
                               │
                               └─ T09 → T10

Stream 3 (CI):            T11 → T12 → T13
```

**Three independent streams, maximal parallelism:**

| Stream | Tasks | Dependencies |
|--------|-------|-------------|
| Stream 1 (Graders) | T01, T02, T03, T04, T05, T06, T14 | T01+T02 parallel start, T03 needs T01+T02, T05 parallel with T03, T06 needs T03+T05, T14 needs T06 |
| Stream 2 (Events+View) | T07, T08, T09, T10 | T07 starts immediately, T08+T09 parallel after T07, T10 needs T09 |
| Stream 3 (CI) | T11, T12, T13 | T11 starts immediately, sequential chain |

**Cross-stream dependencies:** None. All 3 streams are fully independent. T14 (cross-cutting) requires Stream 1 completion only.

## Dispatch Strategy

| Worktree | Tasks | Rationale |
|----------|-------|-----------|
| `eval-llm-graders` | T01, T02, T03, T04, T05, T06, T14 | All Promptfoo grader work + capability suite |
| `eval-events-views` | T07, T08, T09, T10 | Event schemas, harness emission, CQRS view |
| `eval-ci-gate` | T11, T12, T13 | CI reporter, CLI flag, workflow YAML |

Three worktrees, three agents. No cross-worktree file conflicts — each stream touches distinct file sets:
- Stream 1: `evals/graders/*`, `evals/types.ts`, `evals/delegation/`
- Stream 2: `event-store/schemas.ts`, `evals/harness.ts`, `views/eval-results-view.ts`, `views/tools.ts`, `views/composite.ts`
- Stream 3: `evals/reporters/ci-reporter.ts`, `cli-commands/eval-run.ts`, `.github/workflows/`

**Schema conflict note:** Stream 1 modifies `evals/types.ts` (AssertionConfigSchema), Stream 2 modifies `event-store/schemas.ts`. No overlap — clean merge expected.
