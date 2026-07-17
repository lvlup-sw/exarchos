# Implementation Plan: Flywheel Activation

## Source Design
Link: `docs/designs/2026-02-27-flywheel-activation.md`

## Scope
**Target:** Full design (all 4 streams)
**Excluded:** None

## Summary
- Total tasks: 8
- Parallel groups: 3
- Estimated test count: 10
- Design coverage: 4 of 4 streams covered

## Spec Traceability

### Scope Declaration

**Target:** Full design
**Excluded:** None

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Stream 1: Gold Standard Seed Dataset | - 20 human-graded cases<br>- Balanced pass/fail<br>- HumanGradedCase schema<br>- delegation + brainstorming skills | 001 | Covered |
| Stream 2: Shepherd Remediation Events | - `remediation.attempted` emission<br>- `remediation.succeeded` emission<br>- Emission in fix-strategies.md<br>- Reference in SKILL.md | 002, 003 | Covered |
| Stream 3: Plan Coverage Bug Fix (#913) | - Parse traceability table for "Deferred"<br>- Treat deferred as covered<br>- Show "Deferred" status in matrix<br>- 4 new test cases | 004, 005 | Covered |
| Stream 4: Flywheel Verification Script | - Check gold standard exists<br>- Check remediation schemas<br>- Validate case count<br>- Exit code conventions | 006, 007 | Covered |
| Success Criteria | - End-to-end validation | 008 | Covered |

## Task Breakdown

### Task 001: Create gold standard JSONL with 20 human-graded cases

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Write test: `LoadGoldStandard_ValidFile_Returns20Cases`
   - File: `servers/exarchos-mcp/src/evals/__tests__/gold-standard-validation.test.ts`
   - Expected failure: gold-standard.jsonl does not exist
   - Additional tests:
     - `LoadGoldStandard_EachCase_HasRequiredFields` — validates HumanGradedCase schema
     - `LoadGoldStandard_BalancedVerdicts_HasPassAndFail` — at least 3 true + 3 false per skill
     - `LoadGoldStandard_DelegationCases_MatchRubricName` — rubricName matches suite.json
     - `LoadGoldStandard_BrainstormingCases_MatchRubricName` — rubricName matches suite.json
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Create `evals/calibration/gold-standard.jsonl` with 20 cases:
   - 10 delegation cases (`task-decomposition-quality` rubric): 5 pass, 5 fail
   - 10 brainstorming cases (`ideation-quality` rubric): 5 pass, 5 fail
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Review case quality, ensure edge cases are represented

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 002: Add remediation event emission instructions to fix-strategies.md

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Write test: `FixStrategies_ContainsRemediationAttempted_EventEmission`
   - File: `skills/shepherd/__tests__/fix-strategies-content.test.sh`
   - Expected failure: fix-strategies.md does not contain remediation event instructions
   - Additional tests:
     - `FixStrategies_ContainsRemediationSucceeded_EventEmission`
     - `FixStrategies_RemediationSection_HasCorrectEventSchema`
   - Run: `bash skills/shepherd/__tests__/fix-strategies-content.test.sh` - MUST FAIL

2. [GREEN] Add remediation event emission protocol to `skills/shepherd/references/fix-strategies.md`:
   - New section "## Remediation Event Protocol" after "## Commit Strategy for Fixes"
   - Include `remediation.attempted` event emission template with all required fields (taskId, skill, gateName, attemptNumber, strategy)
   - Include `remediation.succeeded` event emission template with all required fields (taskId, skill, gateName, totalAttempts, finalStrategy)
   - Include when-to-emit guidance (before fix attempt, after gate passes)
   - Run: `bash skills/shepherd/__tests__/fix-strategies-content.test.sh` - MUST PASS

3. [REFACTOR] Clean up if needed

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 003: Update shepherd SKILL.md to reference remediation event protocol

**Phase:** RED -> GREEN -> REFACTOR

**TDD Steps:**
1. [RED] Write test: `ShepherdSkill_Step3Fix_ReferencesRemediationEvents`
   - File: `skills/shepherd/__tests__/skill-content.test.sh`
   - Expected failure: SKILL.md Step 3 does not reference remediation events
   - Run: `bash skills/shepherd/__tests__/skill-content.test.sh` - MUST FAIL

2. [GREEN] Edit `skills/shepherd/SKILL.md`:
   - Add remediation event emission reference to Step 3 (Fix) instructions
   - Reference `references/fix-strategies.md#remediation-event-protocol` for the full protocol
   - Run: `bash skills/shepherd/__tests__/skill-content.test.sh` - MUST PASS

3. [REFACTOR] Clean up if needed

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** Task 002
**Parallelizable:** No (depends on T002)
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 004: Write tests for verify-plan-coverage.sh deferred section recognition

**Phase:** RED

**TDD Steps:**
1. [RED] Write 4 test cases in `scripts/verify-plan-coverage.test.sh`:
   - `DeferredSection_InTraceability_ExitsZero` — plan has traceability table with "Deferred" status for a design section, script exits 0
   - `DeferredSection_ShownAsDeferredInMatrix` — coverage matrix output shows "Deferred" status, not "Covered" or "GAP"
   - `MixedDeferredAndCovered_ExitsZero` — some sections deferred (traceability), some covered by tasks, exit 0
   - `DeferredAndGap_ExitsOne` — deferred sections are fine, but other sections still have gaps, exit 1
   - Run: `bash scripts/verify-plan-coverage.test.sh` - MUST FAIL (4 new tests fail)

**Verification:**
- [ ] 4 new tests fail for the right reason (script doesn't parse "Deferred" from traceability table)

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 005: Fix verify-plan-coverage.sh to recognize deferred sections

**Phase:** GREEN -> REFACTOR

**TDD Steps:**
1. [GREEN] Edit `scripts/verify-plan-coverage.sh`:
   - After extracting plan tasks, parse the plan file's traceability table for rows containing "Deferred" (case-insensitive)
   - Extract the design section name from the first column of deferred rows
   - In the cross-reference loop, check if a section matches a deferred entry before reporting it as a gap
   - Show "Deferred" status in the coverage matrix instead of "Covered" or "GAP"
   - Count deferred sections separately in the summary (not as gaps, not as covered)
   - Run: `bash scripts/verify-plan-coverage.test.sh` - ALL tests MUST PASS (including 4 new ones)

2. [REFACTOR] Clean up deferred parsing logic if needed

**Verification:**
- [ ] All 20 tests pass (16 existing + 4 new)
- [ ] No extra code beyond test requirements

**Dependencies:** Task 004
**Parallelizable:** No (depends on T004)
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 006: Write tests for verify-flywheel-activation.sh

**Phase:** RED

**TDD Steps:**
1. [RED] Write test file `scripts/verify-flywheel-activation.test.sh`:
   - `FlywheelActivation_GoldStandardExists_PassesCheck` — gold standard file with >= 20 cases passes
   - `FlywheelActivation_NoGoldStandard_FailsCheck` — missing gold standard file fails
   - `FlywheelActivation_InsufficientCases_FailsCheck` — gold standard with < 20 cases fails
   - `FlywheelActivation_MissingArgs_ExitsTwo` — missing required args exits 2
   - Run: `bash scripts/verify-flywheel-activation.test.sh` - MUST FAIL (script doesn't exist)

**Verification:**
- [ ] Tests fail because the script doesn't exist yet

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 007: Create verify-flywheel-activation.sh

**Phase:** GREEN -> REFACTOR

**TDD Steps:**
1. [GREEN] Create `scripts/verify-flywheel-activation.sh`:
   - Check gold standard file exists at provided path
   - Validate it has >= 20 JSONL lines
   - Validate each line parses as valid JSON with required fields (caseId, skill, rubricName, humanVerdict, humanScore, humanRationale)
   - Report results with check/fail for each condition
   - Exit codes: 0 = all pass, 1 = checks failed, 2 = usage error
   - Run: `bash scripts/verify-flywheel-activation.test.sh` - MUST PASS

2. [REFACTOR] Clean up output formatting

**Verification:**
- [ ] All tests pass
- [ ] No extra code beyond test requirements

**Dependencies:** Task 006
**Parallelizable:** No (depends on T006)
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

---

### Task 008: End-to-end validation

**Phase:** GREEN

**TDD Steps:**
1. [GREEN] Run full verification:
   - `bash scripts/verify-flywheel-activation.sh --gold-standard evals/calibration/gold-standard.jsonl` — exit 0
   - `bash scripts/verify-plan-coverage.test.sh` — all 20 tests pass
   - `npm run test:run` — gold standard validation tests pass
   - `npm run typecheck` — no type errors
   - Verify gold standard case count: `wc -l evals/calibration/gold-standard.jsonl` >= 20

**Verification:**
- [ ] All verification scripts pass
- [ ] All unit tests pass
- [ ] No type errors

**Dependencies:** Tasks 001, 003, 005, 007
**Parallelizable:** No (depends on all previous tasks)
**testingStrategy:** `{ "exampleTests": true, "propertyTests": false, "benchmarks": false }`

## Parallelization Strategy

```
Group A (no deps — can all start immediately):
  ├── T001: Gold standard JSONL (human grading — done by user)
  ├── T002: Remediation events in fix-strategies.md
  ├── T004: Tests for deferred section recognition
  └── T006: Tests for flywheel activation script

Group B (depends on Group A tasks):
  ├── T003: Update shepherd SKILL.md (depends on T002)
  ├── T005: Fix verify-plan-coverage.sh (depends on T004)
  └── T007: Create verify-flywheel-activation.sh (depends on T006)

Group C (integration — depends on all):
  └── T008: End-to-end validation (depends on T001, T003, T005, T007)
```

**Worktree assignment:**
- Worktree 1: T002 → T003 (shepherd remediation events)
- Worktree 2: T004 → T005 (plan coverage bug fix)
- Worktree 3: T006 → T007 (flywheel verification script)
- Main: T001 (gold standard — human grading, done by user)
- Main: T008 (end-to-end validation — after all worktrees merge)

## Deferred Items

| Item | Design Section | Rationale |
|------|---------------|-----------|
| Calibration run + rubric tuning | Stream 1 | Requires API calls + human judgment. Operational work using the `eval-calibrate` CLI after gold standard is created. |
| Trace capture enablement | Flywheel Guide Step 3 | One-line env var change — operational, not code. Document in flywheel guide. |
| Quality hints consumption in skills | Flywheel Guide Step 5 | Follow-up feature after calibration proves the pipeline works. |
| Gold standard for debug, impl-planning, refactor | Stream 1 growth plan | Follow-up PRs after seed dataset validates the pipeline. |

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
