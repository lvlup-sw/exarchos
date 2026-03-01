# Implementation Plan: Standardize Adversarial Gate Integration

## Source Design
Link: `docs/designs/2026-02-28-adversarial-convergence-gates.md`

## Scope
**Target:** Full design — all gate handlers, projections, schema extensions, skill migrations, and eval coverage
**Excluded:** None

## Summary
- Total tasks: 14
- Parallel groups: 4
- Estimated test count: ~45
- Design coverage: 8 of 8 design sections covered

## Spec Traceability

| Design Section | Requirement | Tasks |
|---|---|---|
| §1 Gate: ideate → plan | DR-1: design-completeness orchestrate handler | T-01, T-02 |
| §1 Gate: plan → plan-review | DR-2: plan-coverage orchestrate handler | T-03 |
| §1 Gate: per-task completion | DR-3: tdd-compliance orchestrate handler | T-04 |
| §1 Gate: synthesize → cleanup | DR-4: post-merge gate script + handler | T-05, T-06 |
| §2 Provenance Chain | DR-5: TaskCompletedData provenance fields | T-07 |
| §2.4 Provenance View | DR-6: ProvenanceView CQRS projection | T-08 |
| §4 Event Schema | DR-7: Event schema additions (covered by T-07) | T-07 |
| §5 Skill Changes | DR-8: Skill migration to orchestrate pattern | T-09, T-10, T-11 |
| §1 Gate: ideate → plan (view) | DR-9: IdeateReadinessView projection | T-12 |
| §2.5 Deterministic traceability | DR-10: View handler + composite routing | T-13 |
| Eval coverage | DR-11: Eval dataset expansion | T-14 |

## Task Breakdown

### Task T-01: Extract emitGateEvent to shared utility
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1, DR-2, DR-3, DR-4 (foundation for all gate handlers)

1. [RED] Write test: `emitGateEvent_ValidInput_AppendsGateExecutedEvent`
   - File: `servers/exarchos-mcp/src/orchestrate/gate-utils.test.ts`
   - Test: Create in-memory event store, call emitGateEvent, verify event shape
   - Expected failure: module `gate-utils.ts` does not exist

2. [RED] Write test: `emitGateEvent_WithDetails_IncludesDetailsInPayload`
   - File: `servers/exarchos-mcp/src/orchestrate/gate-utils.test.ts`
   - Expected failure: same module missing

3. [GREEN] Extract `emitGateEvent` from `prepare-synthesis.ts` into `gate-utils.ts`
   - File: `servers/exarchos-mcp/src/orchestrate/gate-utils.ts`
   - Reexport from prepare-synthesis.ts to avoid breaking existing imports

4. [REFACTOR] Update prepare-synthesis.ts to import from gate-utils.ts

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-02: Create design-completeness orchestrate action handler
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-1

1. [RED] Write test: `handleDesignCompleteness_ValidDesign_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/design-completeness.test.ts`
   - Mock: execSync to simulate script exit 0
   - Expected failure: module does not exist

2. [RED] Write test: `handleDesignCompleteness_FindingsDetected_ReturnsAdvisoryFindings`
   - Mock: execSync to simulate script exit 1 with stderr findings
   - Expected failure: same

3. [RED] Write test: `handleDesignCompleteness_EmitsGateExecutedEvent`
   - Verify gate.executed event appended with gateName='design-completeness', layer='design'
   - Expected failure: same

4. [RED] Write test: `handleDesignCompleteness_MissingDesignPath_ReturnsError`
   - Expected failure: same

5. [GREEN] Implement `handleDesignCompleteness` handler
   - File: `servers/exarchos-mcp/src/orchestrate/design-completeness.ts`
   - Pattern: wrap `scripts/check-design-completeness.sh`, parse stderr for findings, emit gate.executed event via shared emitGateEvent
   - Return: `{ passed, advisory, findings[] }`

6. [GREEN] Register `check_design_completeness` action in composite.ts
   - File: `servers/exarchos-mcp/src/orchestrate/composite.ts`

7. [REFACTOR] Clean up error handling patterns

**Dependencies:** T-01
**Parallelizable:** Yes (after T-01)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-03: Create plan-coverage orchestrate action handler
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-2

1. [RED] Write test: `handlePlanCoverage_AllRequirementsCovered_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.test.ts`
   - Mock: execSync for verify-plan-coverage.sh exit 0
   - Expected failure: module does not exist

2. [RED] Write test: `handlePlanCoverage_GapsFound_ReturnsFailWithFindings`
   - Mock: exit 1 with gap report
   - Expected failure: same

3. [RED] Write test: `handlePlanCoverage_BlockedThreshold_ReturnsBlocked`
   - Mock: exit 2 (>30% uncovered)
   - Expected failure: same

4. [RED] Write test: `handlePlanCoverage_EmitsGateExecutedEvent`
   - Verify gate.executed with gateName='plan-coverage', layer='planning'
   - Expected failure: same

5. [GREEN] Implement `handlePlanCoverage` handler
   - File: `servers/exarchos-mcp/src/orchestrate/plan-coverage.ts`
   - Wraps `scripts/verify-plan-coverage.sh`, emits gate.executed

6. [GREEN] Register `check_plan_coverage` action in composite.ts

7. [REFACTOR] Extract common script-wrapping pattern if shared with T-02

**Dependencies:** T-01
**Parallelizable:** Yes (after T-01)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-04: Create tdd-compliance orchestrate action handler
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-3

1. [RED] Write test: `handleTddCompliance_CompliantBranch_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/tdd-compliance.test.ts`
   - Mock: execSync for check-tdd-compliance.sh exit 0
   - Expected failure: module does not exist

2. [RED] Write test: `handleTddCompliance_Violations_ReturnsFailWithFindings`
   - Mock: exit 1 with violations
   - Expected failure: same

3. [RED] Write test: `handleTddCompliance_EmitsGateExecutedEvent_WithTaskId`
   - Verify gate.executed with gateName='tdd-compliance', layer='testing', details.taskId set
   - Expected failure: same

4. [GREEN] Implement `handleTddCompliance` handler
   - File: `servers/exarchos-mcp/src/orchestrate/tdd-compliance.ts`
   - Wraps `scripts/check-tdd-compliance.sh` scoped to task branch
   - Also runs `npm run test:run` and `npm run typecheck`
   - Emits gate.executed for each sub-check

5. [GREEN] Register `check_tdd_compliance` action in composite.ts

**Dependencies:** T-01
**Parallelizable:** Yes (after T-01)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-05: Create check-post-merge.sh gate script
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4

1. [RED] Write test: `PostMerge_CIPassing_ExitZero`
   - File: `scripts/check-post-merge.test.sh`
   - Expected failure: script does not exist

2. [RED] Write test: `PostMerge_CIFailing_ExitOne`
   - Expected failure: same

3. [RED] Write test: `PostMerge_MissingArgs_ExitTwo`
   - Expected failure: same

4. [RED] Write test: `PostMerge_StructuredFindings_OnStderr`
   - Expected failure: same

5. [GREEN] Implement `scripts/check-post-merge.sh`
   - Input: PR URL, merge commit SHA
   - Checks: `gh pr checks` for CI status, `npm run test:run` for regressions
   - Output: exit 0 (pass) or exit 1 (regression), exit 2 (usage)
   - Pattern: `set -euo pipefail`, structured findings to stderr

6. [REFACTOR] Consistent with check-design-completeness.sh findings format

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-06: Create post-merge orchestrate action handler
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-4

1. [RED] Write test: `handlePostMerge_CIPassing_ReturnsPassed`
   - File: `servers/exarchos-mcp/src/orchestrate/post-merge.test.ts`
   - Mock: execSync for check-post-merge.sh exit 0
   - Expected failure: module does not exist

2. [RED] Write test: `handlePostMerge_Regression_ReturnsFailWithFindings`
   - Mock: exit 1
   - Expected failure: same

3. [RED] Write test: `handlePostMerge_EmitsGateExecutedEvent`
   - Verify gate.executed with gateName='post-merge', layer='post-merge'
   - Expected failure: same

4. [GREEN] Implement `handlePostMerge` handler
   - File: `servers/exarchos-mcp/src/orchestrate/post-merge.ts`
   - Wraps check-post-merge.sh, emits gate.executed

5. [GREEN] Register `check_post_merge` action in composite.ts

**Dependencies:** T-01, T-05
**Parallelizable:** Yes (after T-01 and T-05)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-07: Extend TaskCompletedData with provenance fields
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-5, DR-7

1. [RED] Write test: `TaskCompletedData_WithProvenance_ParsesSuccessfully`
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts` (new test in existing file)
   - Parse a TaskCompletedData with implements[] and tests[] fields
   - Expected failure: fields not in schema

2. [RED] Write test: `TaskCompletedData_WithoutProvenance_StillParsesSuccessfully`
   - Verify backward compatibility: existing events without new fields still parse
   - Expected failure: same reason

3. [GREEN] Add optional provenance fields to TaskCompletedData schema
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Add: `implements: z.array(z.string()).optional()` (requirement IDs)
   - Add: `tests: z.array(z.object({ name: z.string(), file: z.string() })).optional()`
   - Add: `files: z.array(z.string()).optional()`

4. [REFACTOR] Update TaskCompleted type export

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** { exampleTests: true, propertyTests: true, benchmarks: false, properties: ["backward compatibility: existing events without provenance fields parse successfully", "schema compliance: provenance fields validate against zod schema for all valid inputs"] }

---

### Task T-08: Create ProvenanceView CQRS projection
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-6

1. [RED] Write test: `ProvenanceView_Init_ReturnsEmptyState`
   - File: `servers/exarchos-mcp/src/views/provenance-view.test.ts`
   - Expected failure: module does not exist

2. [RED] Write test: `ProvenanceView_TaskCompletedWithProvenance_TracksRequirementCoverage`
   - Feed task.completed event with implements=['DR-1'], tests=[...], files=[...]
   - Verify requirement status transitions to 'covered'
   - Expected failure: same

3. [RED] Write test: `ProvenanceView_MultipleTasksSameRequirement_AggregatesCorrectly`
   - Feed two task.completed events both implementing DR-1
   - Verify tasks[], tests[], files[] aggregated
   - Expected failure: same

4. [RED] Write test: `ProvenanceView_UncoveredRequirement_StatusUncovered`
   - Verify requirements mentioned in plan but no task.completed → 'uncovered'
   - Expected failure: same

5. [RED] Write test: `ProvenanceView_OrphanTask_DetectedInOrphanTasks`
   - Task.completed with implements=[] → orphanTasks includes taskId
   - Expected failure: same

6. [RED] Write test: `ProvenanceView_CoverageComputation_ReturnsCorrectFraction`
   - 2 of 3 requirements covered → coverage = 0.67
   - Expected failure: same

7. [GREEN] Implement ProvenanceView projection
   - File: `servers/exarchos-mcp/src/views/provenance-view.ts`
   - Interface: `ProvenanceViewState { featureId, requirements[], coverage, orphanTasks[] }`
   - Consumes: task.completed (with provenance), workflow.started (for featureId)
   - Follows ViewProjection<T> interface: init() + apply()

8. [GREEN] Register projection in tools.ts createMaterializer()

9. [REFACTOR] Extract common view registration boilerplate if shared

**Dependencies:** T-07
**Parallelizable:** No (requires T-07 schema changes)
**testingStrategy:** { exampleTests: true, propertyTests: true, benchmarks: false, properties: ["coverage monotonicity: adding a covered requirement never decreases coverage", "idempotence: replaying the same event twice produces identical state"] }

---

### Task T-09: Migrate brainstorming skill to orchestrate pattern
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8

1. [RED] Verify current brainstorming skill calls script directly (read SKILL.md)

2. [GREEN] Update `skills/brainstorming/SKILL.md`:
   - Replace direct `bash scripts/check-design-completeness.sh` invocation with:
     `exarchos_orchestrate({ action: "check_design_completeness", featureId: "<id>", designPath: "<path>" })`
   - Remove prose instructions for manual event emission
   - Add structured response handling: `if result.passed ... else if result.advisory ...`

3. [REFACTOR] Verify consistency with shepherd/synthesis skill patterns

**Dependencies:** T-02
**Parallelizable:** No (requires handler to exist)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-10: Update delegation skill for per-task gate checks
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8

1. [RED] Read current delegation skill and implementer prompt template

2. [GREEN] Update `skills/delegation/SKILL.md`:
   - After each task completion, invoke:
     `exarchos_orchestrate({ action: "check_tdd_compliance", featureId, taskId, branch })`
   - Gate on result: if failed, keep task in-progress and report findings
   - Update implementer prompt to include provenance reporting:
     "Report which requirements you implemented (Implements: DR-N) and which tests you wrote"

3. [GREEN] Update implementer prompt template in `skills/delegation/references/`:
   - Add provenance section to task completion report format
   - Agent must report: implements[], tests[], files[]

4. [REFACTOR] Ensure consistent gate check invocation pattern

**Dependencies:** T-04
**Parallelizable:** No (requires handler to exist)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-11: Update prepare_delegation to emit plan-coverage gate events
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-8

1. [RED] Write test: `handlePrepareDelegation_EmitsPlanCoverageGateEvent`
   - File: `servers/exarchos-mcp/src/orchestrate/prepare-delegation.test.ts` (or co-located)
   - Verify gate.executed event with gateName='plan-coverage' emitted
   - Expected failure: no gate event emission in current implementation

2. [GREEN] Update `prepare-delegation.ts`:
   - After computing quality hints, emit gate.executed for plan-coverage
   - Import emitGateEvent from gate-utils.ts

3. [REFACTOR] Remove any duplicated gate emission logic

**Dependencies:** T-01, T-03
**Parallelizable:** Yes (after T-01 and T-03)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-12: Create IdeateReadinessView CQRS projection
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-9

1. [RED] Write test: `IdeateReadinessView_Init_ReturnsNotReady`
   - File: `servers/exarchos-mcp/src/views/ideate-readiness-view.test.ts`
   - Expected failure: module does not exist

2. [RED] Write test: `IdeateReadinessView_DesignGatePassed_ReturnsReady`
   - Feed gate.executed with gateName='design-completeness', passed=true
   - Expected failure: same

3. [RED] Write test: `IdeateReadinessView_DesignGateAdvisory_ReturnsReadyWithFindings`
   - Advisory findings don't block, but are tracked
   - Expected failure: same

4. [GREEN] Implement IdeateReadinessView projection
   - File: `servers/exarchos-mcp/src/views/ideate-readiness-view.ts`
   - Interface: `IdeateReadinessState { ready, designArtifactExists, gateResult, advisoryFindings[] }`
   - Consumes: workflow.transition (to detect ideate phase), gate.executed (design-completeness)

5. [GREEN] Register projection in tools.ts createMaterializer()

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-13: Add provenance and ideate-readiness view handlers + composite routing
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-10

1. [RED] Write test: `handleViewProvenance_ReturnsProvenanceState`
   - File: `servers/exarchos-mcp/src/views/provenance-view.test.ts` (append to T-08 test file)
   - Test handler function directly
   - Expected failure: handler doesn't exist

2. [RED] Write test: `handleViewIdeateReadiness_ReturnsReadinessState`
   - File: `servers/exarchos-mcp/src/views/ideate-readiness-view.test.ts` (append to T-12 test file)
   - Expected failure: handler doesn't exist

3. [GREEN] Implement view handler functions in tools.ts:
   - `handleViewProvenance(args, stateDir)` — follows delegation-readiness pattern
   - `handleViewIdeateReadiness(args, stateDir)` — follows delegation-readiness pattern

4. [GREEN] Wire into composite view router (exarchos_view tool's action dispatch)

**Dependencies:** T-08, T-12
**Parallelizable:** No (requires projections to exist)
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

### Task T-14: Expand eval datasets for gate integration coverage
**Phase:** RED → GREEN → REFACTOR
**Implements:** DR-11

1. [RED] Identify eval gaps: provenance chain, per-task gates, post-merge gate, IdeateReadinessView

2. [GREEN] Add regression eval cases to `evals/feature-audit/datasets/regression.jsonl`:
   - fa-r017: Provenance chain complete (all DR-N covered) → APPROVED
   - fa-r018: Per-task TDD compliance gate passes → APPROVED
   - fa-r019: Post-merge gate passes → APPROVED
   - fa-r020: IdeateReadinessView used for gate result → APPROVED

3. [GREEN] Add defect-detection eval cases to `evals/feature-audit/datasets/defect-detection.jsonl`:
   - fa-d020: Orphan task detected (task without requirement mapping) → NEEDS_FIXES
   - fa-d021: Provenance gap (requirement with no implementing task) → NEEDS_FIXES
   - fa-d022: Per-task gate skipped (no tdd-compliance check) → NEEDS_FIXES
   - fa-d023: Post-merge regression undetected → NEEDS_FIXES

4. [REFACTOR] Verify all eval case IDs are unique and properly tagged

**Dependencies:** None
**Parallelizable:** Yes
**testingStrategy:** { exampleTests: true, propertyTests: false, benchmarks: false }

---

## Parallelization Strategy

```
Group 1 (Foundation — parallel):
  T-01: Extract emitGateEvent utility
  T-05: Create check-post-merge.sh script
  T-07: Extend TaskCompletedData schema
  T-12: Create IdeateReadinessView projection
  T-14: Expand eval datasets

Group 2 (Gate handlers — parallel, after T-01):
  T-02: design-completeness handler  [depends: T-01]
  T-03: plan-coverage handler        [depends: T-01]
  T-04: tdd-compliance handler       [depends: T-01]
  T-06: post-merge handler           [depends: T-01, T-05]
  T-11: prepare_delegation update    [depends: T-01, T-03]

Group 3 (Projections — after T-07):
  T-08: ProvenanceView projection    [depends: T-07]

Group 4 (Integration — after handlers + projections):
  T-09: Brainstorming skill migration [depends: T-02]
  T-10: Delegation skill update       [depends: T-04]
  T-13: View handlers + routing       [depends: T-08, T-12]
```

## Deferred Items

- **Cross-feature provenance:** Tracking dependencies between features is out of scope per design §7.
- **Graduated gate depth configuration:** Config-driven thresholds for severity at each gate deferred to future work.
- **Automated requirement extraction:** Requirement IDs assigned manually during /ideate per design §7.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] npm run typecheck passes
- [ ] All 14 tasks complete
- [ ] Ready for review
