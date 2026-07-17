# Implementation Plan: Outside-In TDD Refinement

## Source Design
Link: `docs/designs/2026-03-10-outside-in-tdd-refinement.md`

## Scope
**Target:** Full design
**Excluded:** None

## Summary
- Total tasks: 10
- Parallel groups: 3
- Estimated test count: 14
- Design coverage: 9 of 9 requirements covered

## Spec Traceability

### Scope Declaration

**Target:** Full design — all 9 design requirements
**Excluded:** None

### Traceability Matrix

| Design Requirement | Key Requirements | Task ID(s) | Status |
|---|---|---|---|
| DR-1: Structured acceptance criteria | Given/When/Then format in designs, check_design_completeness validation | T-002, T-006 | Covered |
| DR-2: Acceptance test as first task | testLayer field, acceptanceTestRef field, planner emits acceptance test tasks, check_plan_coverage validation | T-004, T-006 | Covered |
| DR-3: Test layer selection as planning decision | testLayer required field, layer selection decision tree, classifyTask integration | T-003, T-006, T-007 | Covered |
| DR-4: Provenance chain extension | acceptanceTestRef in TaskCompletedData, ProvenanceView extension | T-001, T-005 | Covered |
| DR-5: Neuroanatomy-aligned effort for test tasks | classifyTask effort mapping by testLayer | T-003 | Covered |
| DR-6: Testing Trophy distribution guidance | Testing strategy guide update, implementer prompt update, TDD rules update | T-007, T-008, T-009 | Covered |
| DR-7: Characterization testing | Refactor/debug skill updates, implementer prompt section, characterizationRequired field | T-006, T-008, T-010 | Covered |
| DR-8: Test Desiderata quality criteria | Quality review checklist (behavioral, structure-insensitive, deterministic, specific) | T-009 | Covered |
| DR-9: Error handling and edge cases | Delegation skill acceptance test completion handling, quality review layer mismatch detection | T-008, T-009 | Covered |
| Integration Points table | classifyTask, check_design_completeness, check_plan_coverage, event schema, ProvenanceView | T-001–T-005 | Covered |
| Testing Strategy section | Test approach for code and content changes | All tasks | Covered |
| Open Questions | Deferred to implementation | — | Deferred: implementation-time decisions |

## Task Breakdown

### Task T-001: Add acceptanceTestRef to TaskCompletedData schema (provenance chain extension, provenance extension)

**Implements:** DR-4
**Phase:** RED → GREEN → REFACTOR

**Covers design sections:** DR-4: Provenance chain extension with specification nodes, Technical Design > Provenance Extension

**TDD Steps:**
1. [RED] Write test: `TaskCompletedData_WithAcceptanceTestRef_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: `acceptanceTestRef` field not recognized by schema
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [RED] Write test: `TaskCompletedData_WithoutAcceptanceTestRef_StillParses`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: Same — field definition missing
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

3. [GREEN] Add `acceptanceTestRef: z.string().optional()` to `TaskCompletedData` in `schemas.ts`
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Changes: Add optional string field to the existing Zod schema
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

4. [REFACTOR] None expected — minimal change

**Verification:**
- [ ] Schema accepts `{ taskId: "T-001", acceptanceTestRef: "T-000" }` with valid parse
- [ ] Schema accepts `{ taskId: "T-001" }` without acceptanceTestRef (backward compatible)
- [ ] Existing tests still pass

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-002: Extend design-completeness with Given/When/Then detection

**Implements:** DR-1
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `checkDesignCompleteness_GivenWhenThenPresent_PassesValidation`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.test.ts`
   - Expected failure: Given/When/Then format not checked by current logic
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [RED] Write test: `checkDesignCompleteness_BulletPointFallback_StillPasses`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.test.ts`
   - Expected failure: New validation may break existing bullet-point format
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

3. [RED] Write test: `checkDesignCompleteness_NoAcceptanceCriteria_ReportsAdvisoryFinding`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.test.ts`
   - Expected failure: Advisory finding for missing Given/When/Then not generated
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

4. [GREEN] Extend `checkDesignDocument` in `pure/design-completeness.ts`
   - File: `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.ts`
   - Changes: Add regex-based detection of `Given`/`When`/`Then` patterns within acceptance criteria blocks. Report advisory finding when DR-N lacks structured criteria. Accept both bullet-point and Given/When/Then formats.
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

5. [REFACTOR] Extract Given/When/Then regex into named constant

**Verification:**
- [ ] Design with Given/When/Then acceptance criteria passes
- [ ] Design with bullet-point acceptance criteria still passes (backward compatible)
- [ ] Design with missing acceptance criteria on any DR-N produces advisory finding
- [ ] Existing tests still pass

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-003: Extend classifyTask with testLayer effort mapping

**Implements:** DR-3, DR-5
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `classifyTask_AcceptanceTestLayer_ReturnsHighEffort`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - Expected failure: `testLayer` not recognized as classification signal
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [RED] Write test: `classifyTask_IntegrationTestLayer_ReturnsAppropriateEffort`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - Expected failure: Same — `testLayer` not handled
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

3. [RED] Write test: `classifyTask_UnitTestLayer_ReturnsStandardEffort`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - Expected failure: Same
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

4. [RED] Write test: `classifyTask_NoTestLayer_FallsBackToExistingHeuristics`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts`
   - Expected failure: Type error — `testLayer` not on `TaskInput` interface
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

5. [GREEN] Extend `TaskInput` interface and `classifyTask` function
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`
   - Changes:
     - Add `testLayer?: 'acceptance' | 'integration' | 'unit' | 'property'` to `TaskInput`
     - Add testLayer check as first classification signal in `classifyTask` (before scaffolding keywords)
     - `acceptance` → `effort: 'high'`, `reason: 'Acceptance test task — requires understanding feature intent holistically'`
     - `integration` with ≥2 deps → `effort: 'high'`; otherwise → `effort: 'medium'`
     - `unit` / `property` → fall through to existing heuristics
     - No testLayer → existing behavior unchanged
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

6. [REFACTOR] Extract testLayer effort mapping into named constant map

**Verification:**
- [ ] `testLayer: "acceptance"` → `effort: "high"` regardless of other signals
- [ ] `testLayer: "integration"` with ≥2 deps → `effort: "high"`
- [ ] `testLayer: "integration"` with <2 deps → `effort: "medium"`
- [ ] `testLayer: "unit"` → falls through to existing heuristics
- [ ] No `testLayer` → existing behavior unchanged (backward compatible)
- [ ] Existing classifyTask tests still pass

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-004: Extend plan-coverage for acceptance test task validation

**Implements:** DR-2
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `checkPlanCoverage_DRWithGivenWhenThen_RequiresAcceptanceTestTask`
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
   - Expected failure: Plan coverage doesn't check for acceptance test tasks
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [RED] Write test: `checkPlanCoverage_AcceptanceTestTaskPresent_Passes`
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
   - Expected failure: Same
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

3. [RED] Write test: `checkPlanCoverage_DRWithBulletPoints_NoAcceptanceTestRequired`
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
   - Expected failure: Validation may over-apply acceptance test requirement
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

4. [GREEN] Extend plan-coverage handler
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.ts`
   - Changes:
     - Parse design to detect which DR-Ns have Given/When/Then acceptance criteria
     - Parse plan to detect tasks with `**Test Layer:** acceptance`
     - For each DR-N with Given/When/Then: verify at least one acceptance test task exists that implements it
     - Report advisory finding when acceptance test task is missing for a DR-N with structured criteria
     - DR-Ns with bullet-point-only criteria: no acceptance test requirement (backward compatible)
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

5. [REFACTOR] Extract acceptance test detection logic into pure helper function

**Verification:**
- [ ] DR-N with Given/When/Then criteria and matching acceptance test task → passes
- [ ] DR-N with Given/When/Then criteria but no acceptance test task → advisory finding
- [ ] DR-N with bullet-point criteria only → no acceptance test requirement
- [ ] Existing plan-coverage tests still pass

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-005: Extend ProvenanceView with acceptanceTestRef tracing

**Implements:** DR-4
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ProvenanceView_TaskWithAcceptanceTestRef_TracesLink`
   - File: `servers/exarchos-mcp/src/views/provenance-view.test.ts`
   - Expected failure: `acceptanceTestRef` not processed by projection
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

2. [RED] Write test: `ProvenanceView_AcceptanceTestCoverage_ReportsAcceptanceStatus`
   - File: `servers/exarchos-mcp/src/views/provenance-view.test.ts`
   - Expected failure: ProvenanceView doesn't track acceptance test status
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST FAIL

3. [GREEN] Extend ProvenanceView projection
   - File: `servers/exarchos-mcp/src/views/provenance-view.ts`
   - Changes:
     - Add `acceptanceTests` field to `RequirementStatus`: `readonly acceptanceTests: readonly string[]`
     - When processing `task.completed` events with `acceptanceTestRef`, record the link in the parent requirement's `acceptanceTests` array
     - Extend `ProvenanceViewState` with `acceptanceTestCoverage: number` (ratio of requirements with at least one acceptance test)
   - Run: `cd servers/exarchos-mcp && npm run test:run` — MUST PASS

4. [REFACTOR] None expected — extend existing projection logic

**Verification:**
- [ ] task.completed with `acceptanceTestRef: "T-000"` links to the requirement that T-000 implements
- [ ] ProvenanceView reports `acceptanceTestCoverage` ratio
- [ ] Tasks without `acceptanceTestRef` still work (backward compatible)
- [ ] Existing ProvenanceView tests still pass

**testingStrategy:**
```json
{
  "exampleTests": true,
  "propertyTests": false,
  "benchmarks": false,
  "testLayer": "unit"
}
```

**Dependencies:** T-001 (schema must have acceptanceTestRef field)
**Parallelizable:** No (depends on T-001)

---

### Task T-006: Update design template and task template

**Implements:** DR-1, DR-2, DR-3, DR-7
**Phase:** Content change (no TDD — Markdown only)

**Changes:**

1. **Design template** (`skills/brainstorming/references/design-template.md`)
   - Add Given/When/Then format guidance to the "Requirement Format Rules" section
   - Include example showing structured acceptance criteria
   - Note that Given/When/Then is preferred for behavioral requirements, bullet points for non-behavioral

2. **Task template** (`skills/implementation-planning/references/task-template.md`)
   - Add `**Test Layer:** [acceptance | integration | unit | property]` field to task format
   - Add `**Acceptance Test Ref:** [Task ID]` optional field for inner tasks
   - Add `characterizationRequired: boolean` to testingStrategy schema
   - Add brief description of each test layer with guidance on when to use

**Files to modify:**
- `skills/brainstorming/references/design-template.md`
- `skills/implementation-planning/references/task-template.md`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-007: Update testing strategy guide and TDD rules

**Implements:** DR-3, DR-6
**Phase:** Content change (no TDD — Markdown only)

**Changes:**

1. **Testing strategy guide** (`skills/implementation-planning/references/testing-strategy-guide.md`)
   - Add `testLayer` field to the testingStrategy schema
   - Add test layer selection decision tree:
     - Feature-level behavior → `acceptance`
     - Multiple components interacting → `integration` (default)
     - Isolated complex logic → `unit`
     - Invariants/transformations → `property`
   - Add Testing Trophy distribution guidance: integration-heavy, unit-light
   - Add auto-determination rules for `testLayer` (like existing `propertyTests` rules)

2. **TDD rules** (`skills/shared/references/tdd.md`)
   - Add "Sociable vs Solitary Tests" section:
     - Default: sociable tests (real collaborators)
     - Mock only at infrastructure boundaries (HTTP, database, filesystem)
     - Flag: tests requiring >3 mocked dependencies may indicate wrong test layer

**Files to modify:**
- `skills/implementation-planning/references/testing-strategy-guide.md`
- `skills/shared/references/tdd.md`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-008: Update implementer prompt

**Implements:** DR-6, DR-7, DR-9
**Phase:** Content change (no TDD — Markdown only)

**Changes:**

1. **Implementer prompt** (`skills/delegation/references/implementer-prompt.md`)
   - Add "Testing Trophy Guidance" subsection to TDD Requirements:
     - Prefer integration tests with real collaborators
     - Mock only at infrastructure boundaries
     - Reserve unit tests for isolated complex logic
   - Add "Characterization Testing" section (activated when `characterizationRequired: true`):
     - Before modifying existing code, capture current behavior
     - Write tests that assert on observed outputs, not expected outputs
     - Document which characterization test failures are intentional
   - Add "Acceptance Test Completion" subsection:
     - After completing an inner task, run the parent acceptance test
     - Report acceptance test status (still failing = expected, passing = feature may be complete)
   - Add `acceptanceTestRef` to Provenance Reporting section

**Files to modify:**
- `skills/delegation/references/implementer-prompt.md`

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-009: Update quality review with Test Desiderata and error handling

**Implements:** DR-8, DR-9
**Phase:** Content change (no TDD — Markdown only)

**Changes:**

1. **Quality review skill** (`skills/quality-review/SKILL.md` or its references)
   - Add "Test Desiderata" section to the review checklist with four critical properties:
     - **Behavioral:** Tests assert on observable behavior, not implementation details. Flag: mock call count assertions, internal state inspection
     - **Structure-insensitive:** Tests survive refactoring. Flag: tests coupled to internal helper method signatures
     - **Deterministic:** Tests produce same result every run. Flag: uncontrolled Date.now(), Math.random(), setTimeout race conditions
     - **Specific:** Test failures pinpoint the cause. Flag: `toBeTruthy()`, `toBeDefined()` without additional specific assertions
   - Add "Test Layer Mismatch Detection":
     - Flag unit tests with >3 mocked dependencies as potential layer mismatches
     - Advisory: suggest re-classifying as integration test

**Files to modify:**
- `skills/quality-review/SKILL.md` (or `skills/quality-review/references/` if checklist is in a reference file)

**Dependencies:** None
**Parallelizable:** Yes

---

### Task T-010: Update refactor and debug skills with characterization testing

**Implements:** DR-7
**Phase:** Content change (no TDD — Markdown only)

**Changes:**

1. **Refactor skill** (`skills/refactor/SKILL.md`)
   - Add characterization testing as mandatory pre-step in the "implement" phase (before making changes):
     - Before modifying any function, write characterization tests capturing current behavior
     - Use snapshot-style assertions: capture output, assert it matches
     - Document expected vs unexpected failures after refactoring
   - Position between "explore" and "implement" phases in the refactor workflow

2. **Debug skill** (`skills/debug/SKILL.md`)
   - Add characterization testing to the "thorough" track (not hotfix):
     - Before fixing, capture the buggy behavior as a characterization test
     - The characterization test documents the bug (it should fail after the fix)
     - After fix: characterization test failing = bug is fixed; still passing = fix didn't work

**Files to modify:**
- `skills/refactor/SKILL.md`
- `skills/debug/SKILL.md`

**Dependencies:** None
**Parallelizable:** Yes

---

## Parallelization Strategy

```
Group 1 (parallel):  T-001, T-002, T-003, T-004    ← Code tasks, no dependencies between them
Group 2 (sequential): T-005                          ← Depends on T-001 (schema)
Group 3 (parallel):  T-006, T-007, T-008, T-009, T-010  ← Content tasks, no file overlaps
```

**Groups 1 and 3 can start simultaneously.** Group 2 waits for T-001 from Group 1.

```
Time →

Group 1:  ┌─T-001─┐  ┌─T-002─┐  ┌─T-003─┐  ┌─T-004─┐
          └────────┘  └────────┘  └────────┘  └────────┘
                 │
Group 2:         └──→ ┌─T-005─┐
                      └────────┘

Group 3:  ┌─T-006─┐  ┌─T-007─┐  ┌─T-008─┐  ┌─T-009─┐  ┌─T-010─┐
          └────────┘  └────────┘  └────────┘  └────────┘  └────────┘
```

**File isolation (no conflicts):**

| Task | Files Modified |
|---|---|
| T-001 | `servers/exarchos-mcp/src/event-store/schemas.ts`, `schemas.test.ts` |
| T-002 | `servers/exarchos-mcp/src/orchestrate/pure/design-completeness.ts`, `.test.ts` |
| T-003 | `servers/exarchos-mcp/src/orchestrate/prepare-delegation.ts`, `.test.ts` |
| T-004 | `servers/exarchos-mcp/src/orchestrate/plan-coverage.ts`, `.test.ts` |
| T-005 | `servers/exarchos-mcp/src/views/provenance-view.ts`, `.test.ts` |
| T-006 | `skills/brainstorming/references/design-template.md`, `skills/implementation-planning/references/task-template.md` |
| T-007 | `skills/implementation-planning/references/testing-strategy-guide.md`, `skills/shared/references/tdd.md` |
| T-008 | `skills/delegation/references/implementer-prompt.md` |
| T-009 | `skills/quality-review/SKILL.md` (or references) |
| T-010 | `skills/refactor/SKILL.md`, `skills/debug/SKILL.md` |

## Deferred Items

| Item | Rationale |
|---|---|
| Open Q1: Acceptance test naming convention | Implementation-time decision — agents can use `*.acceptance.test.ts` or co-locate. Recommend `*.acceptance.test.ts` for filterability. |
| Open Q2: Multi-DR acceptance tests | Implementation-time decision — planner should prefer one acceptance test per DR-N for traceability. When DRs share a boundary, one test covering both is acceptable if both DR-Ns are listed in `implements`. |
| Open Q3: Characterization test retention | Recommend keeping as regression tests after refactoring. Can be pruned during a future cleanup pass. |
| Open Q4: Stack-specific patterns | Keep guidance generic in this iteration. Stack-specific templates can be added later as reference files per language. |

## Completion Checklist
- [ ] All tests written before implementation (T-001 through T-005)
- [ ] All tests pass
- [ ] Content changes reviewed for accuracy (T-006 through T-010)
- [ ] Code coverage meets standards
- [ ] Ready for review
