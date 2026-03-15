# Implementation Plan: ICPC 2025 World Finals Benchmark Comparison

## Source Design
Link: `docs/designs/2026-03-14-icpc-benchmark-comparison.md`

## Scope
**Target:** Full design — all 8 design requirements (DR-1 through DR-8)
**Excluded:** None. The eval adapter (DR-6) is included as a lightweight task since it's a thin transformation layer.

## Summary
- Total tasks: 14
- Parallel groups: 3
- Estimated test count: 28
- Design coverage: 8 of 8 requirements covered

## Spec Traceability

| Design Section | DR | Tasks | Coverage |
|---|---|---|---|
| Problem Corpus | DR-1 | 001, 002 | Full |
| Three-Arm Execution Model | DR-2 | 003, 010, 011 | Full |
| Solution Execution and Correctness | DR-3 | 004, 005 | Full |
| Metric Collection | DR-4 | 006 | Full |
| Comparison Report Generation | DR-5 | 012 | Full |
| Eval-Compatible Output | DR-6 | 013 | Full |
| HN-Manual Workflow Definition | DR-7 | 003 | Full |
| Error Handling and Edge Cases | DR-8 | 007, 008, 009 | Full |

## Task Breakdown

### Task 001: Core types and result schema

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-1, DR-3, DR-4

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**TDD Steps:**
1. [RED] Write test: `BenchmarkRunSchema_ValidRun_ParsesSuccessfully`
   - File: `benchmarks/icpc-2025/runner/types.test.ts`
   - Additional tests:
     - `ArmResultSchema_AllVerdicts_AcceptsValidVerdicts`
     - `SampleResultSchema_MissingExpected_Rejects`
     - `ProblemResultSchema_EmptyArms_Rejects`
   - Expected failure: No types module exists

2. [GREEN] Implement Zod schemas and TypeScript types
   - File: `benchmarks/icpc-2025/runner/types.ts`
   - Types: `BenchmarkRun`, `ProblemResult`, `ArmResult`, `SampleResult`, `ArmConfig`, `Verdict`

3. [REFACTOR] Extract shared verdict enum, ensure strict mode compliance

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 002: Problem corpus loader

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-1

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `loadProblem_ValidProblemDir_ReturnsProblemDefinition`
   - File: `benchmarks/icpc-2025/runner/corpus.test.ts`
   - Additional tests:
     - `loadCorpus_AllTenProblems_ReturnsCompleteSet`
     - `loadProblem_MissingSamples_ThrowsError`
     - `loadProblem_ParsesMetaJson_ExtractsTimeLimit`
   - Expected failure: No corpus module exists

2. [GREEN] Implement corpus loader
   - File: `benchmarks/icpc-2025/runner/corpus.ts`
   - Reads `problems/<id>/problem.md`, `meta.json`, `samples/*.in`, `samples/*.out`
   - Returns typed `ProblemDefinition` objects

3. [REFACTOR] Clean up path resolution

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 003: Arm configuration loader and prompt templates

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2, DR-7

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `loadArm_Exarchos_ReturnsFullWorkflowConfig`
   - File: `benchmarks/icpc-2025/runner/arms.test.ts`
   - Additional tests:
     - `loadArm_VanillaPlan_DisablesMcpServers`
     - `loadArm_HnManual_ContainsStructuredPhases`
     - `buildPrompt_ProblemAndArm_IncludesSamplesAndStatement`
     - `loadArm_UnknownArm_ThrowsError`
   - Expected failure: No arms module exists

2. [GREEN] Implement arm loader and prompt builder
   - File: `benchmarks/icpc-2025/runner/arms.ts`
   - Reads arm configs from `arms/*.md`
   - Builds prompts by interpolating problem statement + samples into arm template

3. [GREEN] Create arm definition files
   - Files: `benchmarks/icpc-2025/arms/exarchos.md`, `vanilla-plan.md`, `hn-manual.md`
   - HN-Manual template: 6 phases (read, classify, pseudocode, implement, test, debug)

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 004: Solution compiler and executor

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-3, DR-8

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `compile_ValidCpp_ReturnsExecutablePath`
   - File: `benchmarks/icpc-2025/runner/compiler.test.ts`
   - Additional tests:
     - `compile_SyntaxError_ReturnsCeVerdict`
     - `execute_ValidProgram_ReturnsStdout`
     - `execute_TimeLimitExceeded_ReturnsTleVerdict`
     - `execute_RuntimeError_ReturnsRteVerdict`
     - `execute_LargeOutput_TruncatesAndCaptures`
   - Expected failure: No compiler module exists

2. [GREEN] Implement compiler and executor
   - File: `benchmarks/icpc-2025/runner/compiler.ts`
   - `compile(solutionPath, language)` → `{ success, executablePath?, error? }`
   - `execute(executablePath, input, timeLimitMs)` → `{ stdout, stderr, exitCode, timedOut }`
   - Uses `child_process.execFile` with timeout enforcement via `AbortController`

3. [REFACTOR] Extract language-specific compiler commands into a registry

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 005: Output verifier

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-3

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": true,
  "benchmarks": false,
  "testLayer": "unit",
  "properties": [
    "reflexivity: verify(x, x) === pass for all non-empty outputs",
    "whitespace invariance: verify(x, normalize(x)) === pass"
  ]
}
```

**TDD Steps:**
1. [RED] Write test: `verify_ExactMatch_ReturnsPass`
   - File: `benchmarks/icpc-2025/runner/verifier.test.ts`
   - Additional tests:
     - `verify_TrailingWhitespace_ReturnsPass`
     - `verify_TrailingNewline_ReturnsPass`
     - `verify_WrongAnswer_ReturnsFail`
     - `verify_EmptyActual_ReturnsFail`
     - `verify_MultiLineOutput_ComparesLineByLine`
     - Property: `verify_AnyOutput_MatchesItself`
   - Expected failure: No verifier module exists

2. [GREEN] Implement verifier
   - File: `benchmarks/icpc-2025/runner/verifier.ts`
   - `verify(actual, expected)` → `{ passed, diff? }`
   - Normalizes: trailing whitespace, trailing newlines, \r\n → \n

3. [REFACTOR] Extract normalization into a shared utility

**Dependencies:** None
**Parallelizable:** Yes

---

### Task 006: Metrics collector

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-4

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**TDD Steps:**
1. [RED] Write test: `MetricsCollector_RecordTokens_AggregatesCorrectly`
   - File: `benchmarks/icpc-2025/runner/metrics.test.ts`
   - Additional tests:
     - `MetricsCollector_RecordWallClock_CapturesDuration`
     - `MetricsCollector_RecordIteration_IncrementsCount`
     - `MetricsCollector_CountLinesOfCode_ReturnsAccurateCount`
     - `MetricsCollector_ToArmResult_MapsAllFields`
   - Expected failure: No metrics module exists

2. [GREEN] Implement metrics collector
   - File: `benchmarks/icpc-2025/runner/metrics.ts`
   - `MetricsCollector` class: `recordTokens()`, `recordTime()`, `recordIteration()`, `countLoc()`, `toMetrics()`
   - Token estimation fallback: `bytes / 4` when API counts unavailable

3. [REFACTOR] None expected

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 007: Timeout and process sandboxing

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-8

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `sandbox_InfiniteLoop_KilledWithinTimeout`
   - File: `benchmarks/icpc-2025/runner/sandbox.test.ts`
   - Additional tests:
     - `sandbox_ForkBomb_ContainedByProcessGroup`
     - `sandbox_FileSystemWrite_RestrictedToWorkdir`
     - `sandbox_NormalExecution_CompletesSuccessfully`
   - Expected failure: No sandbox module exists

2. [GREEN] Implement sandbox wrapper
   - File: `benchmarks/icpc-2025/runner/sandbox.ts`
   - Wraps `child_process.spawn` with: process group kill on timeout, working directory isolation, resource limits
   - Returns `SandboxResult` with exit code, stdout, stderr, timedOut flag

3. [REFACTOR] Merge sandbox into compiler.ts if abstraction isn't pulling its weight

**Dependencies:** Task 004
**Parallelizable:** No (depends on 004)

---

### Task 008: Resume-safe run state

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-8

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `RunState_SaveAfterProblem_PersistsToJson`
   - File: `benchmarks/icpc-2025/runner/run-state.test.ts`
   - Additional tests:
     - `RunState_LoadExisting_SkipsCompletedProblems`
     - `RunState_CorruptedFile_StartsFromScratch`
     - `RunState_PartialResults_MergesWithNewResults`
   - Expected failure: No run-state module exists

2. [GREEN] Implement run state manager
   - File: `benchmarks/icpc-2025/runner/run-state.ts`
   - `RunStateManager`: saves progress after each problem-arm pair, loads on restart, identifies remaining work
   - State file: `results/<run-id>.partial.json`

3. [REFACTOR] None expected

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 009: Partial result recording

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-3, DR-8

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**TDD Steps:**
1. [RED] Write test: `recordResult_PartialSamplePass_RecordsPartialVerdict`
   - File: `benchmarks/icpc-2025/runner/results.test.ts`
   - Additional tests:
     - `recordResult_AllSamplesPass_RecordsPassVerdict`
     - `recordResult_NoSolution_RecordsNoSolutionWithReason`
     - `recordResult_CompileError_CapturesErrorOutput`
     - `aggregateResults_MixedVerdicts_ComputesCorrectTotals`
   - Expected failure: No results module exists

2. [GREEN] Implement result recorder
   - File: `benchmarks/icpc-2025/runner/results.ts`
   - `recordResult(problem, arm, sampleResults, metrics)` → `ArmResult`
   - `aggregateResults(problemResults)` → summary statistics

3. [REFACTOR] None expected

**Dependencies:** Task 001, Task 005
**Parallelizable:** Yes (after 001, 005)

---

### Task 010: Session executor (Claude Code subprocess)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `spawnSession_VanillaArm_DisablesMcpInEnvironment`
   - File: `benchmarks/icpc-2025/runner/executor.test.ts`
   - Additional tests:
     - `spawnSession_ExarchosArm_EnablesMcpServers`
     - `spawnSession_CollectsSolutionFile_ReturnsPath`
     - `spawnSession_ContextExhaustion_ReturnsNoSolution`
     - `spawnSession_ExtractsTokenUsage_PopulatesMetrics`
   - Expected failure: No executor module exists
   - Note: Tests use a mock Claude Code subprocess (shell script that writes a known solution)

2. [GREEN] Implement session executor
   - File: `benchmarks/icpc-2025/runner/executor.ts`
   - `spawnSession(problem, armConfig, outputDir)` → `SessionResult`
   - Spawns `claude` CLI as subprocess with arm-specific flags/environment
   - Monitors for solution file output, captures token usage from session summary
   - Enforces session-level timeout (configurable, default 10 minutes per problem)

3. [REFACTOR] Extract Claude CLI argument building into a helper

**Dependencies:** Task 003, Task 006
**Parallelizable:** No (depends on 003, 006)

---

### Task 011: Runner orchestrator (main entry point)

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** integration
**Implements:** DR-2, DR-8

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "integration"
}
```

**TDD Steps:**
1. [RED] Write test: `runBenchmark_SingleProblemSingleArm_ProducesResult`
   - File: `benchmarks/icpc-2025/runner/index.test.ts`
   - Additional tests:
     - `runBenchmark_AllProblemsAllArms_ProducesCompleteMatrix`
     - `runBenchmark_ResumePartial_SkipsCompletedPairs`
     - `runBenchmark_ArmFailure_ContinuesOtherArms`
   - Expected failure: No runner index exists
   - Note: Tests use mock executor that returns fixture results

2. [GREEN] Implement runner orchestrator
   - File: `benchmarks/icpc-2025/runner/index.ts`
   - CLI entry: `npx tsx benchmarks/icpc-2025/runner/index.ts [--arm <arm>] [--problem <id>] [--resume <run-id>]`
   - Loops: for each problem, for each arm → spawn session → compile → verify → record
   - Uses RunStateManager for resume support
   - Writes final results to `results/<run-id>.json`

3. [REFACTOR] None expected

**Dependencies:** Task 002, Task 004, Task 007, Task 008, Task 009, Task 010
**Parallelizable:** No (integration task, depends on most others)

---

### Task 012: Markdown report generator

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-5

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**TDD Steps:**
1. [RED] Write test: `generateReport_FixtureResults_ProducesSummaryTable`
   - File: `benchmarks/icpc-2025/runner/reporter.test.ts`
   - Additional tests:
     - `generateReport_IncludesMethodologySection`
     - `generateReport_PerProblemSections_ContainAllArms`
     - `generateReport_AggregateMetrics_CalculatesCorrectly`
     - `generateReport_MixedVerdicts_FormatsCorrectEmoji`
   - Expected failure: No reporter module exists

2. [GREEN] Implement report generator
   - File: `benchmarks/icpc-2025/runner/reporter.ts`
   - `generateReport(benchmarkRun)` → markdown string
   - Summary matrix table, per-problem details, aggregate metrics, methodology

3. [REFACTOR] None expected

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 013: Eval-compatible adapter

**Phase:** RED → GREEN → REFACTOR
**Test Layer:** unit
**Implements:** DR-6

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**TDD Steps:**
1. [RED] Write test: `toEvalResult_PassingArm_MapsToPassedEvalResult`
   - File: `benchmarks/icpc-2025/eval-adapter.test.ts`
   - Additional tests:
     - `toEvalResult_FailingArm_MapsToFailedEvalResult`
     - `toEvalResults_FullRun_ProducesValidJsonl`
     - `toEvalResult_PreservesMetrics_InMetadataField`
   - Expected failure: No adapter module exists

2. [GREEN] Implement adapter
   - File: `benchmarks/icpc-2025/eval-adapter.ts`
   - `toEvalResult(armResult, problemId)` → `EvalResult`-compatible object
   - `toJsonl(benchmarkRun)` → JSONL string for import into eval pipeline

3. [REFACTOR] None expected

**Dependencies:** Task 001
**Parallelizable:** Yes (after 001)

---

### Task 014: Problem corpus data files

**Phase:** GREEN (content-only, no test-first)
**Implements:** DR-1

**Steps:**
1. Extract all 10 problem statements from the ICPC 2025 PDF into markdown files
2. Create `meta.json` for each problem with title, time limit, tags
3. Create sample input/output files from the PDF

   Structure per problem:
   ```
   problems/<letter>-<slug>/
   ├── problem.md
   ├── meta.json
   └── samples/
       ├── 1.in / 1.out
       ├── 2.in / 2.out
       └── 3.in / 3.out (if exists)
   ```

4. Create the three arm definition files:
   - `arms/exarchos.md` — Full workflow instructions
   - `arms/vanilla-plan.md` — Plan mode only
   - `arms/hn-manual.md` — Structured 6-phase competitive programming process

**Dependencies:** None
**Parallelizable:** Yes

**Note:** This is a content extraction task, not a code task. TDD does not apply. The corpus loader (Task 002) validates that these files are well-formed.

---

## Parallelization Strategy

```
Group A (Foundation — sequential):
  Task 001 (types)

Group B (Parallel after 001):
  Task 002 (corpus loader)     ─┐
  Task 003 (arm loader)        ─┤
  Task 005 (verifier)          ─┤── Can run in parallel worktrees
  Task 006 (metrics)           ─┤
  Task 008 (run state)         ─┤
  Task 012 (reporter)          ─┤
  Task 013 (eval adapter)      ─┤
  Task 014 (problem data)      ─┘

Group C (Sequential after Group B):
  Task 004 (compiler)          → depends on 001
  Task 007 (sandbox)           → depends on 004
  Task 009 (results)           → depends on 001, 005
  Task 010 (executor)          → depends on 003, 006
  Task 011 (orchestrator)      → depends on 002, 004, 007-010
```

**Maximum parallelism:** 8 tasks in Group B can run simultaneously after Task 001 completes.

## Deferred Items

| Item | Rationale |
|---|---|
| CI workflow for scheduled runs | Expensive (30+ Claude sessions). Add after initial manual run proves the framework works. |
| Additional test case authoring | Open Question #2 in design. Can be done post-v1 once sample-only results are published. |
| Multi-run statistical analysis | Open Question #4. Run 3x and report median manually for v1. Automate averaging later. |
| Chart/visualization generation | DR-5 notes "visualization-ready data." JSON supports this; actual chart rendering is a follow-up. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Problem corpus complete (10 problems, 3 arms)
- [ ] Runner executes end-to-end with mock sessions
- [ ] Report generator produces valid markdown from fixture data
- [ ] Ready for review
