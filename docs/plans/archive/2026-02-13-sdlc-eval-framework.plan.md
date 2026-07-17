# Implementation Plan: SDLC Eval Framework — Phase 1 (Foundation)

## Source Design

Link: `docs/designs/2026-02-13-sdlc-eval-framework.md`

## Scope

**Target:** Design Phase 1 (Foundation) — core type definitions, JSONL dataset loader, code-based graders, eval harness, CLI reporter, and `eval-run` CLI command.

**Excluded:**
- Design Phase 2 (LLM grading, Promptfoo integration, eval events, CQRS views) — requires Phase 1 foundation + Promptfoo dependency investigation
- Design Phase 3 (CI pipeline, trace capture hook, eval-capture/eval-compare CLI) — requires Phase 2
- Design Phase 4 (flywheel iteration) — ongoing work, not plannable
- `EvalResultsView` CQRS projection — Phase 2 (depends on eval event schema)
- `eval_results` action in view composite — Phase 2
- LLM-as-judge graders — Phase 2 (requires Promptfoo library decision)
- Synthetic dataset generation — Phase 4

## Summary

- Total tasks: 14
- Parallel groups: 3
- Estimated test count: ~48
- Design coverage: 7 of 10 Technical Design sections covered (3 deferred to Phase 2+)

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| Technical Design > 1. Eval Suite Structure | Suite YAML schema, directory convention, `evals/` placement | 001, 002 | Covered |
| Technical Design > 2. Dataset Format | JSONL format, single/trace types, tag filtering, schema validation | 003, 004 | Covered |
| Technical Design > 3. Eval Harness | Suite discovery, case execution, grading, result aggregation | 009, 010 | Covered |
| Technical Design > 4. Three Eval Layers | Regression/capability/reliability layer definitions, layer filtering | 010 | Covered |
| Technical Design > 5. Eval Event Schema | Event types for eval results | — | Deferred: Phase 2 (requires event schema extension) |
| Technical Design > 6. CQRS View: EvalResultsView | View projection for eval results | — | Deferred: Phase 2 (requires eval events) |
| Technical Design > 7. CLI Integration | `eval-run` command with `--suite`, `--layer`, `--skill`, `--ci` flags | 012, 013 | Covered |
| Technical Design > 8. CI Pipeline | GitHub Actions workflow | — | Deferred: Phase 3 |
| Technical Design > 9. Trace Capture Hook | PostToolUse hook for trace collection | — | Deferred: Phase 3 |
| Technical Design > 10. LLM Judge Configuration | Judge config, rubric design | — | Deferred: Phase 2 |
| Code-based graders (§4 Layer 1) | Exact match, schema validation, tool call verification | 005, 006, 007, 008 | Covered |
| CLI reporter | Terminal output for local runs | 011 | Covered |
| Initial regression dataset | 2-3 skills with captured traces | 014 | Covered |

## Task Breakdown

---

### Task 001: Define core eval type interfaces

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `EvalCase_ParseValidCase_ReturnsTypedObject`
   - File: `src/evals/types.test.ts`
   - Tests: Verify `EvalCaseSchema` parses valid JSONL entries, rejects invalid ones
   - Expected failure: Module `./types.js` does not exist

2. [RED] Write test: `EvalResult_CreateFromGradeResults_ComputesAggregateScore`
   - File: `src/evals/types.test.ts`
   - Expected failure: `createEvalResult` function does not exist

3. [RED] Write test: `EvalSuiteConfig_ParseValidYaml_ReturnsTypedConfig`
   - File: `src/evals/types.test.ts`
   - Expected failure: `EvalSuiteConfigSchema` does not exist

4. [GREEN] Implement type definitions and Zod schemas
   - File: `src/evals/types.ts`
   - Contents: `EvalCaseSchema`, `EvalResultSchema`, `EvalSuiteConfigSchema`, `GradeResultSchema`, `AssertionConfigSchema`, `IGrader` interface, `createEvalResult` helper

5. [REFACTOR] Extract shared schema patterns if any duplication

**Verification:**
- [ ] All 3 test groups fail for the right reason (missing module)
- [ ] Tests pass after implementation
- [ ] Zod schemas enforce required fields (id, type, description, input, expected, tags)
- [ ] `IGrader` interface has `name`, `type`, `grade()` method

**Dependencies:** None
**Parallelizable:** Yes (foundation — start of Chain A)

---

### Task 002: Implement suite config YAML parser

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `parseSuiteConfig_ValidYaml_ReturnsParsedSuite`
   - File: `src/evals/suite-loader.test.ts`
   - Expected failure: Module `./suite-loader.js` does not exist

2. [RED] Write test: `parseSuiteConfig_MissingRequiredFields_ThrowsValidationError`
   - File: `src/evals/suite-loader.test.ts`
   - Expected failure: Same module error

3. [RED] Write test: `parseSuiteConfig_InvalidAssertionType_ThrowsValidationError`
   - File: `src/evals/suite-loader.test.ts`
   - Expected failure: Same module error

4. [RED] Write test: `discoverSuites_SkillsWithEvalDirs_ReturnsAllSuites`
   - File: `src/evals/suite-loader.test.ts`
   - Tests: Given a mock filesystem with `skills/*/evals/suite.yaml`, discovers all suites
   - Expected failure: `discoverSuites` does not exist

5. [GREEN] Implement suite loader
   - File: `src/evals/suite-loader.ts`
   - Contents: `parseSuiteConfig()` (YAML → validated schema), `discoverSuites()` (walk skill dirs)
   - Note: Use `yaml` npm package or inline YAML parsing (check if dependency acceptable)

6. [REFACTOR] Clean up error messages

**Verification:**
- [ ] Valid YAML with all required fields parses correctly
- [ ] Missing `description` or `metadata.skill` causes validation error
- [ ] Suite discovery finds suites in nested `skills/*/evals/` directories

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (Chain A)

---

### Task 003: Implement JSONL dataset loader — happy path

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `loadDataset_ValidJsonl_ReturnsEvalCases`
   - File: `src/evals/dataset-loader.test.ts`
   - Tests: Parse a multi-line JSONL string into `EvalCase[]`
   - Expected failure: Module `./dataset-loader.js` does not exist

2. [RED] Write test: `loadDataset_FilterByTag_ReturnsMatchingCases`
   - File: `src/evals/dataset-loader.test.ts`
   - Tests: Filter dataset by `tags` array (e.g., only "regression" tagged cases)
   - Expected failure: Same module error

3. [RED] Write test: `loadDataset_FilterByLayer_MapsToTags`
   - File: `src/evals/dataset-loader.test.ts`
   - Tests: `layer: "regression"` filters to cases tagged "regression"
   - Expected failure: Same module error

4. [GREEN] Implement dataset loader
   - File: `src/evals/dataset-loader.ts`
   - Contents: `loadDataset(path, options?)` — reads JSONL file, validates each line against `EvalCaseSchema`, filters by tag/layer

5. [REFACTOR] Extract line parsing into a helper

**Verification:**
- [ ] Parses 5-line JSONL correctly
- [ ] Tag filtering works with single and multiple tags
- [ ] Layer mapping works (regression, capability, reliability)

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (Chain A, can run alongside Task 002)

---

### Task 004: Implement JSONL dataset loader — error handling

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `loadDataset_InvalidJsonLine_SkipsAndReportsError`
   - File: `src/evals/dataset-loader.test.ts`
   - Tests: Malformed JSON on line 3 of 5 — returns 4 valid cases + error report
   - Expected failure: Current implementation throws instead of skipping

2. [RED] Write test: `loadDataset_SchemaViolation_SkipsAndReportsError`
   - File: `src/evals/dataset-loader.test.ts`
   - Tests: Valid JSON but missing `id` field — skip with error
   - Expected failure: Current implementation doesn't validate schema per-line

3. [RED] Write test: `loadDataset_EmptyFile_ReturnsEmptyArray`
   - File: `src/evals/dataset-loader.test.ts`
   - Expected failure: Edge case not handled

4. [RED] Write test: `loadDataset_FileNotFound_ThrowsDescriptiveError`
   - File: `src/evals/dataset-loader.test.ts`
   - Expected failure: Raw ENOENT error instead of descriptive message

5. [GREEN] Add error handling to dataset loader
   - File: `src/evals/dataset-loader.ts`
   - Changes: Per-line try/catch with error accumulation, schema validation per line, empty file handling, descriptive file-not-found error

6. [REFACTOR] Clean up

**Verification:**
- [ ] Invalid JSON lines are skipped with error messages
- [ ] Schema violations are caught per-line
- [ ] Error report includes line numbers
- [ ] Empty file returns empty array without throwing

**Dependencies:** Task 003 (dataset loader happy path)
**Parallelizable:** No (extends Task 003)

---

### Task 005: Implement exact match grader

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `ExactMatchGrader_MatchingValues_ReturnsPass`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: `grade(input, "hello", { value: "hello" })` returns `{ passed: true, score: 1.0 }`
   - Expected failure: Module `./code-graders.js` does not exist

2. [RED] Write test: `ExactMatchGrader_DifferentValues_ReturnsFail`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: `grade(input, "hello", { value: "world" })` returns `{ passed: false, score: 0.0 }`
   - Expected failure: Same module error

3. [RED] Write test: `ExactMatchGrader_CaseInsensitive_MatchesIgnoringCase`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: With `caseInsensitive: true`, "Hello" matches "hello"
   - Expected failure: Same module error

4. [RED] Write test: `ExactMatchGrader_NestedPath_ExtractsAndCompares`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: `outputPath: "result.status"` extracts nested value for comparison
   - Expected failure: Same module error

5. [GREEN] Implement exact match grader
   - File: `src/evals/graders/code-graders.ts`
   - Contents: `ExactMatchGrader` implementing `IGrader` — compares output value at path against expected value

6. [REFACTOR] Extract path resolution utility

**Verification:**
- [ ] Exact match works for strings, numbers, booleans
- [ ] Case-insensitive mode works
- [ ] Nested path extraction works (dot notation)
- [ ] Implements `IGrader` interface correctly

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (start of Chain B)

---

### Task 006: Implement schema validation grader

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `SchemaGrader_OutputMatchesSchema_ReturnsPass`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Output matches expected Zod schema → pass
   - Expected failure: `SchemaGrader` does not exist

2. [RED] Write test: `SchemaGrader_OutputMissingField_ReturnsFail`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Output missing a required field → fail with descriptive reason
   - Expected failure: Same

3. [RED] Write test: `SchemaGrader_OutputExtraFields_ReturnsPassWithStrip`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Extra fields are tolerated (Zod passthrough mode)
   - Expected failure: Same

4. [GREEN] Implement schema validation grader
   - File: `src/evals/graders/code-graders.ts`
   - Contents: `SchemaGrader` — validates output against a Zod schema, returns pass/fail with Zod error details

5. [REFACTOR] Clean up error formatting

**Verification:**
- [ ] Valid output passes
- [ ] Missing required field fails with field name in reason
- [ ] Zod error messages are human-readable in grade result

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (Chain B, can run alongside Task 005)

---

### Task 007: Implement tool call verification grader

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `ToolCallGrader_AllExpectedToolsCalled_ReturnsPass`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Trace contains all expected tool calls → pass
   - Expected failure: `ToolCallGrader` does not exist

2. [RED] Write test: `ToolCallGrader_MissingToolCall_ReturnsFail`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Trace missing `exarchos_workflow:set` → fail with missing tool listed
   - Expected failure: Same

3. [RED] Write test: `ToolCallGrader_ForbiddenToolCalled_ReturnsFail`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: Trace contains forbidden tool call → fail
   - Expected failure: Same

4. [RED] Write test: `ToolCallGrader_OrderEnforced_ReturnsFailOnWrongOrder`
   - File: `src/evals/graders/code-graders.test.ts`
   - Tests: With `enforceOrder: true`, tool calls in wrong order → fail
   - Expected failure: Same

5. [GREEN] Implement tool call verification grader
   - File: `src/evals/graders/code-graders.ts`
   - Contents: `ToolCallGrader` — checks that trace tool calls match expected/forbidden lists, optionally enforces order

6. [REFACTOR] Clean up

**Verification:**
- [ ] Required tool calls verified
- [ ] Forbidden tool calls detected
- [ ] Order enforcement works
- [ ] Partial match reports which tools are missing/extra

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (Chain B)

---

### Task 008: Implement grader registry

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `GraderRegistry_RegisterAndRetrieve_ReturnsGrader`
   - File: `src/evals/graders/index.test.ts`
   - Tests: Register a grader by name, retrieve it
   - Expected failure: Module `./index.js` does not exist

2. [RED] Write test: `GraderRegistry_RetrieveUnknown_ThrowsError`
   - File: `src/evals/graders/index.test.ts`
   - Tests: Requesting unregistered grader name throws descriptive error
   - Expected failure: Same

3. [RED] Write test: `GraderRegistry_CreateFromAssertionConfig_ReturnsConfiguredGrader`
   - File: `src/evals/graders/index.test.ts`
   - Tests: `createGrader({ type: 'exact-match', outputPath: 'status', expected: 'ok' })` returns configured `ExactMatchGrader`
   - Expected failure: `createGrader` does not exist

4. [RED] Write test: `GraderRegistry_BuiltinGraders_AllRegistered`
   - File: `src/evals/graders/index.test.ts`
   - Tests: `exact-match`, `schema`, `tool-calls` are registered by default
   - Expected failure: Same

5. [GREEN] Implement grader registry
   - File: `src/evals/graders/index.ts`
   - Contents: `GraderRegistry` class with `register()`, `get()`, `createGrader()` factory, built-in registrations

6. [REFACTOR] Clean up

**Verification:**
- [ ] All three built-in graders registered
- [ ] Factory creates configured graders from assertion config
- [ ] Unknown grader type gives clear error message

**Dependencies:** Tasks 005, 006, 007 (grader implementations)
**Parallelizable:** No (depends on all graders)

---

### Task 009: Implement eval harness — single suite execution

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `EvalHarness_RunSuite_ReturnsResultsForAllCases`
   - File: `src/evals/harness.test.ts`
   - Tests: Given a suite with 3 cases and 1 grader, returns 3 `EvalResult`s
   - Expected failure: Module `./harness.js` does not exist

2. [RED] Write test: `EvalHarness_RunSuite_AggregatesScores`
   - File: `src/evals/harness.test.ts`
   - Tests: Run summary has correct `total`, `passed`, `failed`, `avgScore`
   - Expected failure: Same

3. [RED] Write test: `EvalHarness_MultipleAssertions_AllAppliedPerCase`
   - File: `src/evals/harness.test.ts`
   - Tests: Suite with 2 assertions — each case graded by both, composite score
   - Expected failure: Same

4. [RED] Write test: `EvalHarness_GraderThrows_CaseMarkedAsErrored`
   - File: `src/evals/harness.test.ts`
   - Tests: If a grader throws, the case result is `errored` not `failed`
   - Expected failure: Same

5. [GREEN] Implement eval harness
   - File: `src/evals/harness.ts`
   - Contents: `EvalHarness` class with `runSuite(suite, dataset)` method — iterates cases, applies graders, aggregates results

6. [REFACTOR] Extract result aggregation

**Verification:**
- [ ] All cases graded
- [ ] Scores correctly averaged
- [ ] Multiple assertions compose correctly
- [ ] Grader errors don't crash the run

**Dependencies:** Task 008 (grader registry)
**Parallelizable:** No (start of Chain C)

---

### Task 010: Implement eval harness — suite discovery and layer filtering

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `EvalHarness_RunAll_DiscoverAndRunAllSuites`
   - File: `src/evals/harness.test.ts`
   - Tests: Given a skills directory with 2 suites, runs both and returns combined results
   - Expected failure: `runAll` method does not exist

2. [RED] Write test: `EvalHarness_FilterByLayer_RunsOnlyMatchingCases`
   - File: `src/evals/harness.test.ts`
   - Tests: With `layer: 'regression'`, only runs cases tagged 'regression'
   - Expected failure: Layer filtering not implemented

3. [RED] Write test: `EvalHarness_FilterBySkill_RunsOnlyMatchingSuites`
   - File: `src/evals/harness.test.ts`
   - Tests: With `skill: 'delegation'`, only runs the delegation suite
   - Expected failure: Skill filtering not implemented

4. [RED] Write test: `EvalHarness_DetectsRegressions_ComparesWithBaseline`
   - File: `src/evals/harness.test.ts`
   - Tests: Given a baseline where case X passed, if case X now fails, it's reported as a regression
   - Expected failure: Regression detection not implemented

5. [GREEN] Implement discovery and filtering
   - File: `src/evals/harness.ts`
   - Changes: `runAll(options)` method with `layer`, `skill`, `suite` filters; regression detection via baseline comparison

6. [REFACTOR] Clean up options interface

**Verification:**
- [ ] Suite discovery finds all `evals/suite.yaml` files
- [ ] Layer filtering works correctly
- [ ] Skill filtering works correctly
- [ ] Regressions detected when comparing against baseline

**Dependencies:** Task 009 (harness core), Task 002 (suite discovery)
**Parallelizable:** No (extends Task 009)

---

### Task 011: Implement CLI reporter

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `CliReporter_FormatResults_OutputsSummaryTable`
   - File: `src/evals/reporters/cli-reporter.test.ts`
   - Tests: Given eval results, formats a readable summary with pass/fail counts
   - Expected failure: Module does not exist

2. [RED] Write test: `CliReporter_FormatResults_HighlightsRegressions`
   - File: `src/evals/reporters/cli-reporter.test.ts`
   - Tests: Regressions are called out separately with case IDs
   - Expected failure: Same

3. [RED] Write test: `CliReporter_FormatResults_ShowsPerAssertionBreakdown`
   - File: `src/evals/reporters/cli-reporter.test.ts`
   - Tests: Each failed assertion shows its name and reason
   - Expected failure: Same

4. [GREEN] Implement CLI reporter
   - File: `src/evals/reporters/cli-reporter.ts`
   - Contents: `formatEvalResults(results)` — returns formatted string with summary table, regression highlights, per-assertion breakdown for failures

5. [REFACTOR] Clean up formatting

**Verification:**
- [ ] Summary shows total/passed/failed/score
- [ ] Regressions highlighted
- [ ] Failed assertions show reasons
- [ ] Output is readable in terminal

**Dependencies:** Task 001 (types)
**Parallelizable:** Yes (independent of graders/harness — can start once types exist)

---

### Task 012: Implement `eval-run` CLI command handler

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `handleEvalRun_NoFlags_RunsAllSuites`
   - File: `src/cli-commands/eval-run.test.ts`
   - Tests: With no options, discovers and runs all eval suites
   - Expected failure: Module does not exist

2. [RED] Write test: `handleEvalRun_LayerFlag_FiltersToLayer`
   - File: `src/cli-commands/eval-run.test.ts`
   - Tests: `--layer regression` passes filter to harness
   - Expected failure: Same

3. [RED] Write test: `handleEvalRun_SkillFlag_FiltersToSkill`
   - File: `src/cli-commands/eval-run.test.ts`
   - Tests: `--skill delegation` passes filter to harness
   - Expected failure: Same

4. [RED] Write test: `handleEvalRun_CiFlag_ExitsNonZeroOnRegressionFailure`
   - File: `src/cli-commands/eval-run.test.ts`
   - Tests: With `--ci` flag, returns exit code 1 when regressions detected
   - Expected failure: Same

5. [GREEN] Implement eval-run command
   - File: `src/cli-commands/eval-run.ts`
   - Contents: `handleEvalRun(stdinData)` — parses flags from stdin, runs harness, formats output via reporter, returns result

6. [REFACTOR] Clean up

**Verification:**
- [ ] No flags runs everything
- [ ] Layer and skill filters work
- [ ] CI mode returns non-zero exit on regression
- [ ] Output formatted via CLI reporter

**Dependencies:** Task 010 (harness discovery), Task 011 (reporter)
**Parallelizable:** No (depends on harness + reporter)

---

### Task 013: Register `eval-run` in CLI entry point

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `cli_evalRun_RoutesToHandler`
   - File: `src/cli.test.ts` (extend existing)
   - Tests: CLI with command `eval-run` routes to `handleEvalRun`
   - Expected failure: `eval-run` not in `KNOWN_COMMANDS`

2. [GREEN] Register eval-run command
   - File: `src/cli.ts`
   - Changes: Add `'eval-run'` to `KNOWN_COMMANDS`, add handler to `commandHandlers` map

3. [REFACTOR] None needed

**Verification:**
- [ ] `node dist/cli.js eval-run` routes correctly
- [ ] Existing commands unaffected

**Dependencies:** Task 012 (eval-run handler)
**Parallelizable:** No

---

### Task 014: Create initial eval suite for delegation skill

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**

1. [RED] Write test: `DelegationEvalSuite_LoadsAndValidates`
   - File: `src/evals/harness.test.ts` (extend)
   - Tests: The actual `skills/delegation/evals/suite.yaml` loads without validation errors
   - Expected failure: File does not exist

2. [RED] Write test: `DelegationEvalSuite_RegressionDatasetLoads`
   - File: `src/evals/harness.test.ts` (extend)
   - Tests: The regression dataset JSONL parses without errors
   - Expected failure: File does not exist

3. [GREEN] Create eval suite and dataset
   - File: `skills/delegation/evals/suite.yaml` — suite config with exact-match and tool-call assertions
   - File: `skills/delegation/evals/datasets/regression.jsonl` — 5 manually crafted eval cases from known-good delegation traces

4. [REFACTOR] Review dataset quality

**Verification:**
- [ ] Suite YAML validates against schema
- [ ] Dataset JSONL parses correctly
- [ ] Running `eval-run --skill delegation` succeeds

**Dependencies:** Tasks 010, 012 (harness + CLI)
**Parallelizable:** No (integration test — must be last)

---

## Parallelization Strategy

```
Chain A (Foundation):           Chain B (Graders):              Chain C (Reporting):
┌─────────────────────┐         ┌─────────────────────┐
│ Task 001: Types     │────┬───>│ Task 005: ExactMatch │        ┌─────────────────────┐
└─────────────────────┘    │    │ Task 006: Schema     │   ┌───>│ Task 011: CLI Report│
         │                 │    │ Task 007: ToolCalls  │   │    └─────────────────────┘
         v                 │    └─────────────────────┘   │
┌─────────────────────┐    │              │               │
│ Task 002: SuiteLoad │    │              v               │
│ Task 003: Dataset   │    │    ┌─────────────────────┐   │
│ Task 004: DatasetErr│    │    │ Task 008: Registry   │   │
└─────────────────────┘    │    └─────────────────────┘   │
                           │              │               │
                           │              v               │
                           │    ┌─────────────────────┐   │
                           └───>│ Task 009: Harness    │<──┘
                                │ Task 010: Discovery  │
                                └─────────────────────┘
                                          │
                                          v
                                ┌─────────────────────┐
                                │ Task 012: eval-run   │
                                │ Task 013: CLI reg    │
                                │ Task 014: Init suite │
                                └─────────────────────┘
```

### Parallel Groups

**Group 1** (after Task 001 completes):
- Worktree A: Tasks 002, 003, 004 (Chain A — suite/dataset loading)
- Worktree B: Tasks 005, 006, 007 (Chain B — graders)
- Worktree C: Task 011 (CLI reporter — only needs types)

**Group 2** (after Groups 1 merges):
- Sequential: Tasks 008 → 009 → 010 → 012 → 013 → 014

### Stack Order

```
main ← T001 ← T002 ← T003 ← T004 ← T005 ← T006 ← T007 ← T008 ← T009 ← T010 ← T011 ← T012 ← T013 ← T014
```

## Deferred Items

| Item | Rationale |
|---|---|
| Promptfoo integration (Phase 2) | Needs API surface investigation — can Promptfoo's assertion engine be used as a library? Must verify before building the integration. |
| LLM-as-judge graders (Phase 2) | Depends on Promptfoo decision. If library, use Promptfoo's `llm-rubric`. If not, build custom. |
| Eval event schema + CQRS view (Phase 2) | Requires extending the event store schemas — meaningful only after Phase 1 proves the harness works. |
| CI pipeline (Phase 3) | Requires Phase 2 (LLM grading) for capability evals. Regression evals could gate earlier, but bundling with Phase 3 is cleaner. |
| Trace capture hook (Phase 3) | Requires PostToolUse hook slot — may need coordination with progressive-disclosure-hooks design. |
| Synthetic dataset generation (Phase 4) | Ongoing work. Start with manual traces, expand to synthetic only after the flywheel is spinning. |

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards (90%+)
- [ ] `npm run test:run` passes from MCP server root
- [ ] `node dist/cli.js eval-run` works end-to-end
- [ ] Initial delegation eval suite runs successfully
- [ ] Ready for review
