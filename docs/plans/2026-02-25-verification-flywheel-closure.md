# Implementation Plan: Verification Flywheel Closure

## Source Design
Link: `docs/designs/2026-02-25-verification-flywheel-closure.md`

## Scope
**Target:** Full design — all 4 tracks (Judge Calibration, Capture Pipeline, Signal Wiring, Integration)
**Excluded:** Task 1.3 (curate 100 gold standard cases) — human grading effort, not automatable. Task 1.4/1.5 (calibration runs with real rubric refinement) — requires API calls and iterative human judgment. These are operational tasks, not code tasks.

## Summary
- Total tasks: 22
- Parallel groups: 3 tracks + 1 integration track
- Estimated test count: ~85 tests across 11 new test files
- Design coverage: 18 of 20 technical design subsections covered (2 deferred: operational process + metric targets)

## Spec Traceability

| Design Section | Task(s) | Key Requirements |
|----------------|---------|------------------|
| 1.1 Gold Standard Dataset | T01 | `HumanGradedCase` schema, JSONL structure, Zod validation |
| 1.2 Train/Validation/Test Split | T02 | Deterministic hash-based split, reproducible assignment |
| 1.3 Calibration Harness | T03, T04 | CLI command, confusion matrix, TPR/TNR/F1, disagreements |
| 1.4 Rubric Refinement Protocol | Deferred | Operational process, not code. See Deferred Items. |
| 1.5 Calibration Event | T05 | `eval.judge.calibrated` event type, EvalResultsView handler |
| 2.1 Opt-In Capture Hook | T06 | Env var gating, trace writer in telemetry middleware |
| 2.2 Auto-Triage | T07, T08 | `triageTrace()`, regression/capability/discard rules, dedup |
| 2.3 Dataset Growth CLI | T09 | `--promote` flag, append to dataset, version increment |
| 2.4 Dataset Growth Targets | Deferred | Metric targets, not code. See Deferred Items. |
| 3.1 Remediation Events | T10 | `remediation.attempted` + `remediation.succeeded` schemas |
| 3.2 Wire selfCorrectionRate | T11 | CodeQualityView handler for `remediation.succeeded` |
| 3.3 Wire topFailureCategories | T12 | Propagate `gate.executed` failure reasons to skill metrics |
| 3.4 Wire avgRemediationAttempts | T11 | Running average from `remediation.succeeded` (same handler) |
| 3.5 Enrich gate.executed | T13 | Standardize `GateExecutedDetails`, add `promptVersion` |
| 4.1 Calibrated Correlation | T14 | `CalibratedSkillCorrelation`, signal confidence derivation |
| 4.2 Regression Eval Generator | T15, T16 | Auto-generate regression cases from quality regressions |
| 4.3 Attribution Analysis | T17, T18 | `quality_attribution` view action, multi-dimensional slicing |
| 4.4 Prompt Refinement Signal | T19, T20 | `quality.refinement.suggested` event, emission triggers |
| 4.5 Enrich Hints | T21 | Confidence levels + refinement data in quality hints |
| Integration Tests | T22 | Full loop end-to-end |

## Task Breakdown

---

### Task 01: HumanGradedCase schema and gold standard JSONL structure

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `HumanGradedCaseSchema_ValidCase_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/evals/__tests__/calibration-types.test.ts`
   - Additional tests:
     - `HumanGradedCaseSchema_MissingSkill_ThrowsValidationError`
     - `HumanGradedCaseSchema_ScoreOutOfRange_ThrowsValidationError`
     - `HumanGradedCaseSchema_WithGraderOutput_ParsesSuccessfully`
     - `LoadGoldStandard_ValidJSONL_ReturnsTypedArray`
     - `LoadGoldStandard_EmptyFile_ReturnsEmptyArray`
     - `LoadGoldStandard_InvalidLine_ThrowsWithLineNumber`
   - Expected failure: Module `calibration-types` does not exist

2. [GREEN] Implement `HumanGradedCaseSchema` Zod schema and `loadGoldStandard()` loader
   - File: `servers/exarchos-mcp/src/evals/calibration-types.ts`
   - Changes: Zod schemas for `HumanGradedCase`, `CalibrationReport`, `CalibrateInput`. Loader function reusing `dataset-loader` patterns.

3. [REFACTOR] Extract shared JSONL loading logic if duplicated with `dataset-loader.ts`

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["schema compliance: all valid HumanGradedCase objects parse without error", "rejection: invalid objects are rejected with meaningful error messages"] }`

---

### Task 02: Deterministic train/validation/test split

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `AssignSplit_DeterministicHash_SameInputSameSplit`
   - File: `servers/exarchos-mcp/src/evals/__tests__/calibration-split.test.ts`
   - Additional tests:
     - `AssignSplit_HashMod5_CorrectDistribution`
     - `AssignSplit_TrainSplit_Returns20Percent`
     - `AssignSplit_ValidationSplit_Returns40Percent`
     - `AssignSplit_TestSplit_Returns40Percent`
     - `FilterBySplit_ValidationOnly_ExcludesTrainAndTest`
     - `FilterBySplit_TestOnly_ExcludesTrainAndValidation`
   - Expected failure: Module `calibration-split` does not exist

2. [GREEN] Implement `assignSplit()` and `filterBySplit()`
   - File: `servers/exarchos-mcp/src/evals/calibration-split.ts`
   - Changes: Hash-based split assignment (caseId mod 5), filter function

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["determinism: assignSplit(id) always returns the same split for the same id", "distribution: over many random ids, splits approximate 20/40/40 ratio within tolerance"] }`

---

### Task 03: Calibration harness — confusion matrix computation

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ComputeConfusionMatrix_AllCorrect_PerfectScores`
   - File: `servers/exarchos-mcp/src/evals/__tests__/calibration-metrics.test.ts`
   - Additional tests:
     - `ComputeConfusionMatrix_AllWrong_ZeroScores`
     - `ComputeConfusionMatrix_MixedResults_CorrectTPRTNR`
     - `ComputeConfusionMatrix_NoPositives_TPRIsZero`
     - `ComputeConfusionMatrix_NoNegatives_TNRIsZero`
     - `ComputeConfusionMatrix_SingleCase_CorrectMetrics`
     - `ComputeF1_PrecisionAndRecallZero_ReturnsZero`
     - `ExtractDisagreements_MismatchedVerdicts_ReturnsDetails`
   - Expected failure: Module `calibration-metrics` does not exist

2. [GREEN] Implement `computeConfusionMatrix()` and `extractDisagreements()`
   - File: `servers/exarchos-mcp/src/evals/calibration-metrics.ts`
   - Changes: Confusion matrix from human/judge verdict arrays, TPR/TNR/accuracy/F1, disagreement extraction

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["accuracy identity: TP + TN + FP + FN === totalCases", "score range: 0 <= TPR, TNR, accuracy, F1 <= 1", "perfect classifier: all-correct produces TPR=1, TNR=1, F1=1"] }`

---

### Task 04: Calibration harness — eval-calibrate CLI command

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EvalCalibrate_ValidInput_ReturnsCalibrationReport`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-calibrate.test.ts`
   - Additional tests:
     - `EvalCalibrate_FilterBySkill_OnlyGradesMatchingCases`
     - `EvalCalibrate_ValidationSplit_UsesCorrectSubset`
     - `EvalCalibrate_TestSplit_UsesCorrectSubset`
     - `EvalCalibrate_MissingGoldStandard_ReturnsError`
     - `EvalCalibrate_GraderSkipped_MarksAsSkipped`
     - `EvalCalibrate_EmptySplit_ReturnsEmptyReport`
   - Expected failure: Module `eval-calibrate` does not exist

2. [GREEN] Implement `eval-calibrate` CLI command
   - File: `servers/exarchos-mcp/src/cli-commands/eval-calibrate.ts`
   - Changes: Load gold standard, filter by split, run graders, compute confusion matrix, format report. Follows `eval-run.ts` patterns (stdin JSON input, stderr output).

3. [REFACTOR] Extract shared CLI patterns if duplicated with `eval-run.ts`

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01, T02, T03
**Parallelizable:** No (sequential within Track 1)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 05: Calibration event — eval.judge.calibrated type and EvalResultsView handler

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `JudgeCalibratedDataSchema_ValidData_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/evals/__tests__/judge-calibrated-event.test.ts`
   - Additional tests:
     - `JudgeCalibratedDataSchema_MissingTPR_ThrowsValidationError`
     - `EvalResultsView_JudgeCalibratedEvent_TracksCalibrationHistory`
     - `EvalResultsView_JudgeCalibratedEvent_UpdatesLatestCalibration`
     - `EvalResultsView_MultipleCalibrations_KeepsHistory`
   - Expected failure: `JudgeCalibratedData` not in `EventDataMap`

2. [GREEN] Implement schema + view handler
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts` (add `JudgeCalibratedData` schema, add to `EventType` union and `EventDataMap`)
   - File: `servers/exarchos-mcp/src/views/eval-results-view.ts` (add `eval.judge.calibrated` handler, add `calibrations` field to `EvalResultsViewState`)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T01
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["schema compliance: all valid JudgeCalibratedData objects parse without error", "monotonicity: calibration history length never decreases after apply()"] }`

---

### Task 06: Opt-in trace capture in telemetry middleware

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `WithTelemetry_CaptureEnabled_WritesTraceEntry`
   - File: `servers/exarchos-mcp/src/telemetry/trace-writer.test.ts`
   - Additional tests:
     - `WithTelemetry_CaptureDisabled_NoTraceWritten`
     - `WithTelemetry_CaptureEnabled_TruncatesLargeInput`
     - `WithTelemetry_CaptureEnabled_IncludesSkillContext`
     - `TraceWriter_SessionScoped_WritesToCorrectFile`
     - `TraceWriter_AppendMode_AppendsToExistingFile`
     - `TraceWriter_WriteFailure_DoesNotThrowOrBlockToolCall`
   - Expected failure: `TraceWriter` class does not exist

2. [GREEN] Implement `TraceWriter` class and wire into `withTelemetry`
   - File: `servers/exarchos-mcp/src/telemetry/trace-writer.ts` (new: `TraceWriter` with env var check, JSONL append, truncation)
   - File: `servers/exarchos-mcp/src/telemetry/middleware.ts` (modify: conditionally invoke `TraceWriter` after tool completion)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 07: Auto-triage — triageTrace() with regression/capability/discard rules

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `TriageTrace_SuccessfulWorkflow_ClassifiesAsRegression`
   - File: `servers/exarchos-mcp/src/evals/auto-triage.test.ts`
   - Additional tests:
     - `TriageTrace_WorkflowWithRetries_ClassifiesAsCapability`
     - `TriageTrace_ShortTrace_Discards`
     - `TriageTrace_IncompleteWorkflow_Discards`
     - `TriageTrace_DuplicateOfExisting_Discards`
     - `TriageTrace_NovelPattern_ClassifiesAsCapability`
     - `TriageTrace_EmptyEvents_ReturnsEmptyResult`
     - `TriageTrace_AllCategories_SumEqualsInput`
   - Expected failure: Module `auto-triage` does not exist

2. [GREEN] Implement `triageTrace()`
   - File: `servers/exarchos-mcp/src/evals/auto-triage.ts`
   - Changes: Triage logic with three classification buckets, input validation

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["conservation: regression.length + capability.length + discarded === input.length (no events lost)", "determinism: triageTrace(events) returns same result for same input"] }`

---

### Task 08: Deduplication logic for trace triage

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `IsDuplicate_IdenticalInput_ReturnsTrue`
   - File: `servers/exarchos-mcp/src/evals/deduplication.test.ts`
   - Additional tests:
     - `IsDuplicate_CompletelyDifferent_ReturnsFalse`
     - `IsDuplicate_SlightVariation_BelowThreshold_ReturnsFalse`
     - `IsDuplicate_SlightVariation_AboveThreshold_ReturnsTrue`
     - `IsDuplicate_DifferentTypes_ReturnsFalse`
     - `ComputeSimilarity_NestedObjects_ComparesStructurally`
     - `ComputeSimilarity_EmptyObjects_Returns1`
   - Expected failure: Module `deduplication` does not exist

2. [GREEN] Implement `isDuplicate()` and `computeStructuralSimilarity()`
   - File: `servers/exarchos-mcp/src/evals/deduplication.ts`
   - Changes: Structural comparison on `input` fields, configurable threshold (default 0.9)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["symmetry: similarity(a,b) === similarity(b,a)", "identity: similarity(a,a) === 1.0", "range: 0 <= similarity(a,b) <= 1.0"] }`

---

### Task 09: eval-capture --promote CLI extension

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EvalCapture_PromoteFlag_AppendsToCaseToDataset`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-capture.test.ts` (extend existing)
   - Additional tests:
     - `EvalCapture_PromoteWithIds_OnlyAddsSelectedCases`
     - `EvalCapture_PromoteToNonexistentSuite_ReturnsError`
     - `EvalCapture_PromoteDuplicate_SkipsDuplicateCase`
     - `EvalCapture_Promote_IncrementsMetadataVersion`
   - Expected failure: `promote` code path does not exist in `eval-capture.ts`

2. [GREEN] Implement `--promote` flag in `eval-capture`
   - File: `servers/exarchos-mcp/src/cli-commands/eval-capture.ts` (modify: add promote input handling, dataset append, version increment)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T07, T08
**Parallelizable:** No (sequential within Track 2)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 10: remediation.attempted and remediation.succeeded event schemas

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RemediationAttemptedSchema_ValidData_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/__tests__/remediation-schemas.test.ts`
   - Additional tests:
     - `RemediationAttemptedSchema_MissingTaskId_ThrowsValidationError`
     - `RemediationAttemptedSchema_ZeroAttemptNumber_ThrowsValidationError`
     - `RemediationSucceededSchema_ValidData_ParsesSuccessfully`
     - `RemediationSucceededSchema_MissingTotalAttempts_ThrowsValidationError`
     - `EventDataMap_IncludesRemediationTypes_InUnion`
   - Expected failure: `RemediationAttemptedData` not in `EventDataMap`

2. [GREEN] Add schemas to `schemas.ts`
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts` (add `RemediationAttemptedData`, `RemediationSucceededData` Zod schemas, add `remediation.attempted` + `remediation.succeeded` to `EventType` union and `EventDataMap`)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["schema compliance: all valid RemediationAttemptedData/SucceededData parse without error", "rejection: invalid data rejected with meaningful error paths"] }`

---

### Task 11: Wire selfCorrectionRate and avgRemediationAttempts in CodeQualityView

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `CodeQualityView_RemediationSucceeded_UpdatesSelfCorrectionRate`
   - File: `servers/exarchos-mcp/src/views/code-quality-view.test.ts` (extend existing)
   - Additional tests:
     - `CodeQualityView_RemediationSucceeded_UpdatesAvgRemediationAttempts`
     - `CodeQualityView_MultipleRemediations_CorrectRunningAverage`
     - `CodeQualityView_RemediationForUnknownSkill_CreatesSkillEntry`
     - `CodeQualityView_NoRemediations_RateRemainsZero`
     - `CodeQualityView_RemediationAfterGateFailure_CorrelatesCorrectly`
   - Expected failure: `remediation.succeeded` case not handled in `apply()`

2. [GREEN] Add `remediation.succeeded` handler to CodeQualityView
   - File: `servers/exarchos-mcp/src/views/code-quality-view.ts` (add handler computing `selfCorrectionRate` as fraction of failures remediated, `avgRemediationAttempts` as running average of `totalAttempts`)

3. [REFACTOR] Extract running average helper if reusable

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T10
**Parallelizable:** No (depends on schema)
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["range: 0 <= selfCorrectionRate <= 1.0", "monotonicity: avgRemediationAttempts >= 1 when any remediations exist", "consistency: more successful remediations never decrease selfCorrectionRate"] }`

---

### Task 12: Wire topFailureCategories from gate.executed failure reasons

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `CodeQualityView_GateFailedWithReason_PopulatesTopFailureCategories`
   - File: `servers/exarchos-mcp/src/views/code-quality-view.test.ts` (extend existing)
   - Additional tests:
     - `CodeQualityView_MultipleFailureReasons_SortedByCount`
     - `CodeQualityView_MoreThan10Categories_TruncatesToTop10`
     - `CodeQualityView_GatePassedNoReason_DoesNotAddCategory`
     - `CodeQualityView_FailureNoReason_UsesGateNameAsCategory`
     - `CodeQualityView_SameCategory_IncrementsCount`
   - Expected failure: `topFailureCategories` remains empty array after `gate.executed`

2. [GREEN] Extend `gate.executed` handler to propagate failure reasons to skill metrics
   - File: `servers/exarchos-mcp/src/views/code-quality-view.ts` (modify existing handler: on failure, aggregate reason/gateName into `topFailureCategories`, sort desc, truncate to 10)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["sorted invariant: topFailureCategories is always sorted by count descending", "bounded: topFailureCategories.length <= 10", "non-negative: all count values >= 1"] }`

---

### Task 13: Standardize GateExecutedDetails and add promptVersion

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `GateExecutedDetailsSchema_WithPromptVersion_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/__tests__/gate-details-schema.test.ts`
   - Additional tests:
     - `GateExecutedDetailsSchema_AllFieldsOptional_EmptyObjectValid`
     - `GateExecutedDetailsSchema_WithAllFields_ParsesSuccessfully`
     - `CodeQualityView_GateWithPromptVersion_StoresInMetrics`
   - Expected failure: `GateExecutedDetailsSchema` does not exist

2. [GREEN] Add `GateExecutedDetailsSchema` Zod schema and extend gate handler
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts` (add `GateExecutedDetailsSchema` with all optional fields including `promptVersion`)
   - File: `servers/exarchos-mcp/src/views/code-quality-view.ts` (extract `promptVersion` from details if present)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 14: Calibrated quality correlation — CalibratedSkillCorrelation and signal confidence

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `CorrelateWithCalibration_CalibratedJudge_ReturnsHighConfidence`
   - File: `servers/exarchos-mcp/src/quality/calibrated-correlation.test.ts`
   - Additional tests:
     - `CorrelateWithCalibration_UncalibratedJudge_ReturnsLowConfidence`
     - `CorrelateWithCalibration_CalibratedButLowData_ReturnsMediumConfidence`
     - `CorrelateWithCalibration_BelowThresholdTPR_ReturnsLowConfidence`
     - `CorrelateWithCalibration_NoEvalResults_SkillExcluded`
     - `DeriveSignalConfidence_AllThresholdsMet_ReturnsHigh`
     - `DeriveSignalConfidence_InsufficientVolume_ReturnsMedium`
   - Expected failure: Module `calibrated-correlation` does not exist

2. [GREEN] Implement `correlateWithCalibration()`
   - File: `servers/exarchos-mcp/src/quality/calibrated-correlation.ts`
   - Changes: Extend existing correlation with calibration data from EvalResultsView, derive signal confidence

3. [REFACTOR] Consider whether to merge with or wrap existing `quality-correlation.ts`

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T05
**Parallelizable:** Yes (after T05)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 15: Regression eval generator — core logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `GenerateRegressionEval_WithTraces_ReturnsEvalCase`
   - File: `servers/exarchos-mcp/src/quality/regression-eval-generator.test.ts`
   - Additional tests:
     - `GenerateRegressionEval_NoTraces_ReturnsNull`
     - `GenerateRegressionEval_LowConfidence_ReturnsNull`
     - `GenerateRegressionEval_ValidRegression_IncludesFailurePattern`
     - `GenerateRegressionEval_GeneratedCase_HasAutoGeneratedTag`
     - `GenerateRegressionEval_GeneratedCase_HasCapabilityLayer`
   - Expected failure: Module `regression-eval-generator` does not exist

2. [GREEN] Implement `generateRegressionEval()`
   - File: `servers/exarchos-mcp/src/quality/regression-eval-generator.ts`
   - Changes: Core generation logic — pair recent traces with regression failure patterns, create EvalCase with `auto-generated` tag and `capability` layer (advisory for first 2 runs)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T07 (triage), T11 (selfCorrectionRate for quality signal)
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 16: Regression eval generator — file writer and auto-regression dataset

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `WriteAutoRegression_NewCase_AppendsToDataset`
   - File: `servers/exarchos-mcp/src/quality/regression-eval-generator.test.ts` (extend)
   - Additional tests:
     - `WriteAutoRegression_DatasetDoesNotExist_CreatesFile`
     - `WriteAutoRegression_DuplicateCase_SkipsWrite`
     - `WriteAutoRegression_ValidCase_ValidJSONLFormat`
   - Expected failure: `writeAutoRegressionCase()` does not exist

2. [GREEN] Implement `writeAutoRegressionCase()`
   - File: `servers/exarchos-mcp/src/quality/regression-eval-generator.ts` (extend: file write to `evals/{skill}/datasets/auto-regression.jsonl`)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T15
**Parallelizable:** No (sequential with T15)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 17: Attribution analysis — computation logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ComputeAttribution_BySkill_ReturnsPerSkillMetrics`
   - File: `servers/exarchos-mcp/src/quality/attribution.test.ts`
   - Additional tests:
     - `ComputeAttribution_ByModel_ReturnsPerModelMetrics`
     - `ComputeAttribution_ByGate_ReturnsPerGateMetrics`
     - `ComputeAttribution_ByPromptVersion_ReturnsPerVersionMetrics`
     - `ComputeAttribution_WithTimeRange_FiltersEvents`
     - `ComputeAttribution_EmptyData_ReturnsEmptyEntries`
     - `ComputeAttribution_IncludesSampleSize`
     - `ComputeCorrelations_TwoFactors_ReturnsStrength`
   - Expected failure: Module `attribution` does not exist

2. [GREEN] Implement `computeAttribution()`
   - File: `servers/exarchos-mcp/src/quality/attribution.ts`
   - Changes: Multi-dimensional slicing across CodeQualityView and EvalResultsView state, correlation computation

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T12 (topFailureCategories), T13 (promptVersion)
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["range: 0 <= correlation.strength <= 1.0", "sampleSize: entry.sampleSize >= 1 for all non-empty entries"] }`

---

### Task 18: quality_attribution view action — MCP wiring

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `HandleViewAttribution_ValidQuery_ReturnsAttributionResult`
   - File: `servers/exarchos-mcp/src/quality/attribution.test.ts` (extend)
   - Additional tests:
     - `HandleViewAttribution_InvalidDimension_ReturnsError`
     - `HandleViewAttribution_WithSkillFilter_FiltersResults`
   - Expected failure: `quality_attribution` action not registered in view composite

2. [GREEN] Wire `quality_attribution` action into `exarchos_view` composite tool
   - File: `servers/exarchos-mcp/src/tools/tools.ts` (add `quality_attribution` case to view handler)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T17
**Parallelizable:** No (sequential with T17)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 19: quality.refinement.suggested event schema

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RefinementSuggestedSchema_ValidData_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/__tests__/refinement-schema.test.ts`
   - Additional tests:
     - `RefinementSuggestedSchema_MissingSkill_ThrowsValidationError`
     - `RefinementSuggestedSchema_InvalidTrigger_ThrowsValidationError`
     - `RefinementSuggestedSchema_LowConfidence_ThrowsValidationError`
   - Expected failure: `RefinementSuggestedData` not in `EventDataMap`

2. [GREEN] Add schema to `schemas.ts`
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts` (add `RefinementSuggestedData` schema, add `quality.refinement.suggested` to `EventType` union and `EventDataMap`)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ exampleTests: true, propertyTests: true, benchmarks: false, properties: ["schema compliance: valid RefinementSuggestedData parses", "signal confidence only allows high or medium (not low)"] }`

---

### Task 20: Prompt refinement signal emission logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `EmitRefinementSignal_RegressionWithHighConfidence_EmitsEvent`
   - File: `servers/exarchos-mcp/src/quality/refinement-signal.test.ts`
   - Additional tests:
     - `EmitRefinementSignal_RegressionWithLowConfidence_DoesNotEmit`
     - `EmitRefinementSignal_TrendDegradation_EmitsEvent`
     - `EmitRefinementSignal_AttributionOutlier_EmitsEvent`
     - `EmitRefinementSignal_IncludesAffectedPromptPaths`
     - `EmitRefinementSignal_IncludesEvidence`
     - `BuildSuggestedAction_Regression_DescribesGateCategory`
     - `BuildSuggestedAction_TrendDegradation_SuggestsGitLog`
   - Expected failure: Module `refinement-signal` does not exist

2. [GREEN] Implement `evaluateAndEmitRefinementSignals()`
   - File: `servers/exarchos-mcp/src/quality/refinement-signal.ts`
   - Changes: Three trigger checks (regression, trend degradation, attribution outlier), signal confidence guard, event emission, human-readable `suggestedAction` builder

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T14 (calibrated correlation), T15 (regression eval generator), T17 (attribution), T19 (event schema)
**Parallelizable:** No (integration point)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 21: Enrich quality hints with calibration confidence and refinement data

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `GenerateQualityHints_WithCalibration_IncludesConfidenceLevel`
   - File: `servers/exarchos-mcp/src/quality/hints.test.ts` (extend existing)
   - Additional tests:
     - `GenerateQualityHints_LowConfidence_MarksAsAdvisory`
     - `GenerateQualityHints_HighConfidence_MarksAsActionable`
     - `GenerateQualityHints_WithRefinementSuggestion_IncludesPromptPaths`
     - `GenerateQualityHints_NoCalibrationData_DefaultsToLowConfidence`
   - Expected failure: `hints.ts` does not accept calibration data parameter

2. [GREEN] Extend `generateQualityHints()` to accept calibration and refinement context
   - File: `servers/exarchos-mcp/src/quality/hints.ts` (modify: add optional `calibrationContext` parameter, enrich hints with confidence level and refinement suggestions)

3. [REFACTOR] None expected

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T14 (calibrated correlation), T20 (refinement signal)
**Parallelizable:** No (sequential)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 22: Integration tests — full flywheel loop end-to-end

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `FlywheelLoop_GateFailures_ProducesRefinementSignal`
   - File: `servers/exarchos-mcp/src/quality/__tests__/flywheel-integration.test.ts`
   - Additional tests:
     - `FlywheelLoop_CalibratedJudge_HighConfidenceSignal`
     - `FlywheelLoop_UncalibratedJudge_NoSignalEmitted`
     - `FlywheelLoop_CapturedTrace_GeneratesRegressionEval`
     - `FlywheelLoop_AttributionOutlier_SuggestsModelChange`
     - `FlywheelLoop_EndToEnd_EventsFlowThroughAllComponents`
   - Expected failure: Integration wiring incomplete (signals don't flow end-to-end yet if tasks not integrated)

2. [GREEN] Wire all components together
   - File: `servers/exarchos-mcp/src/quality/__tests__/flywheel-integration.test.ts` (test-level wiring: emit events → materialize views → correlate → generate regression eval → check refinement signal)
   - File: `servers/exarchos-mcp/src/tools/tools.ts` (wire refinement signal check into `quality_correlation` and `quality_hints` view actions)

3. [REFACTOR] Extract shared test setup into fixtures if tests become verbose

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** T20, T21 (all tracks complete)
**Parallelizable:** No (final integration)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

## Parallelization Strategy

```
Track 1 (Judge Calibration)         Track 2 (Capture Pipeline)        Track 3 (Signal Wiring)
────────────────────────────        ──────────────────────────        ─────────────────────────
┌─T01─┐ ┌─T05─┐                    ┌─T06─┐ ┌─T07─┐ ┌─T08─┐         ┌─T10─┐ ┌─T12─┐ ┌─T13─┐
│     │ │     │                    │     │ │     │ │     │         │     │ │     │ │     │
└─┬───┘ └─┬───┘                    └─┬───┘ └─┬───┘ └─┬───┘         └─┬───┘ └──┬──┘ └─┬───┘
  │       │                          │       │       │               │        │       │
┌─T02─┐   │                          │     ┌─T09─┐  │             ┌─T11─┐    │     ┌─T13─┐
└─┬───┘   │                          │     └─────┘  │             └─────┘    │     └─┬───┘
  │       │                          │               │                        │       │
┌─T03─┐   │                          └───────────────┘                        │       │
└─┬───┘   │                                                                   │       │
  │       │                                                                   │       │
┌─T04─┐   │                                                                   │       │
└─────┘   │                                                                   │       │
          │                                                                   │       │
          │              Integration Track                                    │       │
          │  ┌─T14─┐ ┌─T15─┐ ┌─T17─┐ ┌─T19─┐                               │       │
          └──│     │ │     │ │     │ │     │                                 │       │
             └─┬───┘ └─┬───┘ └─┬───┘ └─────┘                                 │       │
               │     ┌─T16─┐ ┌─T18─┐                                         │       │
               │     └─────┘ └─────┘                                          │       │
               │                                                              │       │
             ┌─T20─┐←────────────────────────────────────────────────────────┘       │
             └─┬───┘←────────────────────────────────────────────────────────────────┘
               │
             ┌─T21─┐
             └─┬───┘
               │
             ┌─T22─┐
             └─────┘
```

**Parallel Group A (all tracks, no dependencies):** T01, T05, T06, T07, T08, T10, T12, T13, T19
**Parallel Group B (after Group A):** T02, T03, T09, T11, T14, T15, T17
**Parallel Group C (after Group B):** T04, T16, T18
**Sequential tail:** T20 → T21 → T22

**Maximum theoretical parallelism: 9 tasks** (Group A)
**Recommended delegation: 3 worktrees** (one per track), integration track runs sequentially after all three converge.

## Deferred Items

| Item | Design Section | Rationale |
|------|---------------|-----------|
| Curate 100 gold standard cases | 1.1 Gold Standard Dataset | Human grading effort. Cannot be automated. Developer performs after calibration infrastructure (T01-T04) is built. |
| Rubric refinement protocol | 1.4 Rubric Refinement Protocol | Operational process using the calibration CLI (T04), not a code task. The protocol is documented in the design; execution is iterative human judgment. |
| Run calibration on validation/test splits | 1.3/1.5 | Requires real API calls + iterative human judgment. Operational work using the `eval-calibrate` CLI (T04). |
| Dataset growth targets tracking | 2.4 Dataset Growth Targets | Metric targets, not implementation tasks. Growth is organic via capture pipeline (T06-T09). Targets can be added to EvalResultsView as a follow-up if explicit tracking is needed. |
| Auto-triage wiring to workflow.cleanup event | 2.2 Auto-Triage | Depends on deciding the hook mechanism (PostToolUse vs event store subscription). Deferred to post-implementation spike. |
| CI workflow for weekly calibration | — | Operational configuration after calibration infrastructure is validated. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
