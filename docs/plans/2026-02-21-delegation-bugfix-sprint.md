# Implementation Plan: Delegation Bug Fix Sprint

**Design:** `docs/designs/2026-02-21-delegation-bugfix-sprint.md`
**Issues:** #735, #738, #739, #740, #741, #713

## Spec Traceability

| Design Section | Tasks | Coverage |
|----------------|-------|----------|
| Work Package 1: Guard Error Improvement (#735) | 1, 2, 3, 4 | Full |
| Work Package 2: Event Emission Checklist in SKILL.md (#741, #740) | 5 | Full |
| Work Package 3: Workflow State Sync Instructions (#739) | 5 | Full |
| Work Package 4: Compaction Recovery Protocol (#738) | 5, 6 | Full |
| Work Package 5: Troubleshooting Section (#735 content) | 7 | Full |
| Work Package 6: Orphan Event Schema Wiring (#713) | 8, 9 | P1+P2 |

## Parallelization Map

```
Group A (Server - Guards)     Group B (Content - SKILL.md)     Group C (Content - References)
┌──────────────────────┐     ┌───────────────────────────┐    ┌───────────────────────────┐
│ Task 1: GuardFailure │     │ Task 5: SKILL.md sections │    │ Task 7: troubleshooting   │
│ Task 2: allTasksComp │     │  - Event contract table   │    │  - Cause/Solution pairs   │
│ Task 3: allReviewsPa │     │  - State sync section     │    └───────────────────────────┘
│ Task 4: artifact+    │     │  - Compaction recovery    │
│         phase guards │     └───────────────────────────┘
└──────────────────────┘
         │
         ▼
Group D (Server - Reconcile)  Group E (Server - Events)
┌──────────────────────┐     ┌───────────────────────────┐
│ Task 6: reconcile    │     │ Task 8: hints event       │
│         action       │     │ Task 9: review events     │
└──────────────────────┘     └───────────────────────────┘
```

**Wave 1 (parallel):** Groups A, B, C — no file overlap
**Wave 2 (parallel, after A):** Groups D, E — D depends on Group A's type changes; E independent

## Tasks

### Task 1: Extend GuardResult type with structured failure interface
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/guards.ts`, `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
**Issue:** #735

1. [RED] Write test: `GuardFailure_WithExpectedShape_IncludesFieldInResult`
   - File: `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
   - Add test that a guard failure object can include `expectedShape` and `suggestedFix` optional fields
   - Add test that `GuardFailure` type discriminates from `true` correctly
   - Expected failure: `GuardFailure` type doesn't exist yet

2. [GREEN] Extract `GuardFailure` interface from existing `GuardResult` union
   - File: `servers/exarchos-mcp/src/workflow/guards.ts`
   - Change `GuardResult` from `boolean | { passed: false; reason: string }` to `true | GuardFailure`
   - Define `GuardFailure`: `{ passed: false; reason: string; expectedShape?: Record<string, unknown>; suggestedFix?: { tool: string; params: Record<string, unknown> } }`
   - Backward compatible — all existing guards still compile

3. [REFACTOR] Export `GuardFailure` interface for use in tool handler serialization

**Dependencies:** None
**Parallelizable:** Start of Group A chain
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 2: Add expectedShape and suggestedFix to allTasksComplete guard
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/guards.ts`, `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
**Issue:** #735

1. [RED] Write test: `AllTasksComplete_WithIncompleteTasks_ReturnsSuggestedFix`
   - File: `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
   - State: `{ tasks: [{ id: "1", status: "complete" }, { id: "2", status: "pending" }, { id: "3", status: "in-progress" }] }`
   - Assert: result has `expectedShape` showing `{ tasks: [{ id, status: "complete" }] }`
   - Assert: result has `suggestedFix.tool === "exarchos_workflow"` and `suggestedFix.params.action === "set"`
   - Assert: `suggestedFix.params.updates.tasks` lists task IDs 2 and 3 with status "complete"
   - Expected failure: guard currently returns only `reason` string

2. [GREEN] Update `allTasksComplete.evaluate()` to include structured fields
   - File: `servers/exarchos-mcp/src/workflow/guards.ts`
   - On failure, build `suggestedFix` from incomplete task IDs extracted during evaluation
   - Return `GuardFailure` with `expectedShape` and `suggestedFix`

3. [REFACTOR] Extract task status checking into a named predicate if helpful

**Dependencies:** Task 1
**Parallelizable:** Sequential within Group A
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 3: Add expectedShape to allReviewsPassed and anyReviewFailed guards
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/guards.ts`, `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`
**Issue:** #735

1. [RED] Write tests:
   - `AllReviewsPassed_NoReviews_ReturnsExpectedShape`: state `{ reviews: null }` → result.expectedShape shows `{ reviews: { "<name>": { status: "pass" } } }`
   - `AllReviewsPassed_EmptyReviews_ReturnsExpectedShape`: state `{ reviews: {} }` → same
   - `AllReviewsPassed_FailedReviews_ListsFailedPaths`: state with mixed statuses → result lists failed review paths with their statuses
   - Expected failure: guards currently return only `reason` string

2. [GREEN] Update `allReviewsPassed.evaluate()` and `anyReviewFailed.evaluate()`
   - Add `expectedShape` with example review object structure
   - For `allReviewsPassed`, include `failedReviews` in the failure showing which paths failed and their current statuses

3. [REFACTOR] Consolidate shared review status logic if duplicated

**Dependencies:** Task 1
**Parallelizable:** Sequential within Group A (after Task 2)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 4: Add expectedShape to artifact and phase-specific guards
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/guards.ts`, `servers/exarchos-mcp/src/__tests__/workflow/guards.test.ts`, `servers/exarchos-mcp/src/workflow/tools.ts`
**Issue:** #735

1. [RED] Write tests:
   - `DesignArtifactExists_Missing_ReturnsSuggestedFix`: result has `suggestedFix` with `exarchos_workflow set` and `updates.artifacts.design` path pattern
   - `PlanArtifactExists_Missing_ReturnsSuggestedFix`: same for plan
   - `TriageComplete_MissingSymptom_ReturnsExpectedShape`: result has `expectedShape: { triage: { symptom: "<description>" } }`
   - `RootCauseFound_Missing_ReturnsExpectedShape`: result has `expectedShape: { investigation: { rootCause: "<description>" } }`
   - `PhaseTransitionError_IncludesPhaseGraph`: verify MCP error response includes the workflow type's full phase graph
   - Expected failure: guards return only `reason` string; phase transition doesn't include graph

2. [GREEN] Update each guard's `evaluate()`:
   - `designArtifactExists`, `planArtifactExists`, `rcaDocumentComplete`, `fixDesignComplete`: add `expectedShape` and `suggestedFix`
   - `triageComplete`, `rootCauseFound`, `scopeAssessmentComplete`, `briefComplete`: add `expectedShape`
   - `docsUpdated`, `goalsVerified`, `validationPassed`: add `expectedShape`
   - In `tools.ts` `handleSet()`: when phase transition fails, include `phaseGraph` from the HSM definition in the error response

3. [REFACTOR] Extract `makeArtifactGuard()` helper to DRY the artifact guards (design, plan, rca, fixDesign all follow the same pattern)

**Dependencies:** Task 1
**Parallelizable:** Sequential within Group A (after Task 3)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 5: Add event contract, state sync, and compaction recovery to delegation SKILL.md
**Phase:** Content edit (no TDD — Markdown)
**Files:** `skills/delegation/SKILL.md`
**Issues:** #741, #740, #739, #738

1. Add `## Event Emission Contract (Agent Teams)` section with table (from design WP2)
   - Place after "Delegation Workflow — Agent Team Mode (6-Step Saga)" section
   - Table with 6 rows: saga step, exarchos call, event type, required data
   - CRITICAL callout: steps 1-3 must emit events BEFORE Claude Code side effect
   - Link to `references/agent-teams-saga.md` for full payload shapes

2. Add `## State Synchronization` section (from design WP3)
   - Place immediately after event contract table
   - Explain Claude Code TaskList and exarchos workflow state are independent
   - Show the two-step completion protocol: TaskUpdate then exarchos_workflow set
   - Clarify: `all-tasks-complete` guard checks exarchos state, NOT Claude Code TaskList

3. Add `## Context Compaction Recovery` section (from design WP4)
   - Place after State Synchronization
   - 4-step recovery protocol: team config → workflow state → teammate inbox → reconcile
   - CRITICAL callout: do NOT re-create branches or re-dispatch until confirmed lost

4. Verify total word count stays under 1,300 words. Current is 827 — additions target ~310 words (total ~1,137).

**Dependencies:** None
**Parallelizable:** Yes (Group B — different files from Groups A, D, E)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 6: Expose reconcileFromEvents as `reconcile` action on exarchos_workflow
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/workflow/tools.ts`, `servers/exarchos-mcp/src/__tests__/workflow/tools.test.ts` (or co-located test)
**Issue:** #738

1. [RED] Write tests:
   - `Reconcile_WithStaleTaskState_PatchesFromEvents`: setup stale state (tasks pending) + event stream with `team.task.completed` events → verify tasks updated to complete
   - `Reconcile_WithEmptyEventStream_ReturnsNoChanges`: no events → `{ reconciled: false, eventsApplied: 0 }`
   - `Reconcile_Idempotent_SecondCallNoOp`: run reconcile twice → second returns no changes
   - `Reconcile_MissingFeatureId_ReturnsError`: no featureId → validation error
   - Expected failure: `reconcile` action doesn't exist on the tool

2. [GREEN] Add `reconcile` action to `exarchos_workflow` tool:
   - Add to input schema: `action: "reconcile"` with required `featureId`
   - Handler: call existing `reconcileFromEvents(stateDir, featureId, moduleEventStore)` from `state-store.ts`
   - Return `{ reconciled, eventsApplied }` from the existing function
   - Wire into the tool dispatcher alongside `init`, `get`, `set`, `cancel`, `cleanup`

3. [REFACTOR] Add `reconcile` to the action enum's Zod schema and tool description

**Dependencies:** Task 1 (for updated types), existing `reconcileFromEvents` function
**Parallelizable:** Wave 2 (after Group A completes)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 7: Update troubleshooting reference with Cause/Solution pairs
**Phase:** Content edit (no TDD — Markdown)
**Files:** `skills/delegation/references/troubleshooting.md`
**Issue:** #735 (content side)

1. Add new section `## Common Workflow Errors` with Cause/Solution pairs:
   - `all-tasks-complete not satisfied` → Cause: TaskList updated but exarchos state not synced → Solution: `exarchos_workflow set` with updated tasks
   - `Expected object, received array` on reviews → Cause: reviews must be keyed object → Solution: show correct shape
   - `No transition from 'explore' to 'plan'` → Cause: refactor workflows use different phase names → Solution: use `overhaul-plan` or `polish-implement`, check `validTargets`
   - `invalid_enum_value` on event type → Cause: invalid event type string → Solution: reference Event Emission Contract table
   - `Guard 'triage-complete' failed` → Cause: guard checks `triage.symptom` not `triage.complete` → Solution: set `triage.symptom` field

2. Verify each Cause/Solution matches actual error messages from guards.ts

**Dependencies:** None
**Parallelizable:** Yes (Group C — different file from Groups A, B)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 8: Wire quality hints generator to emit quality.hint.generated event
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/quality/hints.ts`, `servers/exarchos-mcp/src/__tests__/quality/hints.test.ts` (or co-located)
**Issue:** #713 P1

1. [RED] Write test: `GenerateQualityHints_WithHints_EmitsEvent`
   - Setup: state with conditions that trigger hints (e.g., high error rate)
   - Assert: after `generateQualityHints()` call, `quality.hint.generated` event emitted with `{ skill, hintCount, categories, generatedAt }`
   - Expected failure: no event emission code exists

2. [GREEN] Add event emission to `generateQualityHints()`:
   - After computing hints (line ~136), if hints.length > 0, emit `quality.hint.generated` event
   - Extract unique categories from hints
   - Use ISO timestamp for `generatedAt`
   - Need to inject event store dependency (or use module-level configured store)

3. [REFACTOR] Ensure event emission doesn't block hint return (fire-and-forget or awaited based on pattern)

**Dependencies:** None (independent of guard changes)
**Parallelizable:** Yes (Group E)
**testingStrategy:** { propertyTests: false, benchmarks: false }

---

### Task 9: Wire review triage to emit review.finding and review.escalated events
**Phase:** RED → GREEN → REFACTOR
**Files:** `servers/exarchos-mcp/src/` (review-related files — locate exact paths during implementation)
**Issue:** #713 P2

1. [RED] Write tests:
   - `ReviewTriage_WithFindings_EmitsReviewFindingPerComment`: mock CodeRabbit findings → verify one `review.finding` event per actionable comment with `{ pr, source, severity, filePath, message }`
   - `ReviewTriage_HighRiskRouting_EmitsReviewEscalated`: mock high-risk PR → verify `review.escalated` event with `{ pr, reason, originalScore, triggeringFinding }`
   - Expected failure: no event emission in review triage path

2. [GREEN] Add event emission:
   - In review triage handler, after parsing findings: emit `review.finding` per normalized finding
   - When routing to human review (high risk tier): emit `review.escalated` with score and trigger
   - Map CodeRabbit severity levels to schema enum: `critical | major | minor | suggestion`

3. [REFACTOR] Extract finding normalization into a pure function if complex

**Dependencies:** None (independent)
**Parallelizable:** Yes (Group E, after Task 8)
**testingStrategy:** { propertyTests: false, benchmarks: false }

## Delegation Structure

| Wave | Group | Tasks | Agent Worktree | Est. Complexity |
|------|-------|-------|---------------|----------------|
| 1 | A (Guards) | 1, 2, 3, 4 | `wt/guards-improvement` | Medium — 4 sequential TDD tasks |
| 1 | B (SKILL.md) | 5 | `wt/skill-content` | Low — Markdown editing |
| 1 | C (References) | 7 | `wt/troubleshooting` | Low — Markdown editing |
| 2 | D (Reconcile) | 6 | `wt/reconcile-action` | Medium — 1 TDD task, existing function |
| 2 | E (Events) | 8, 9 | `wt/event-wiring` | Medium — 2 TDD tasks, locate emission points |

**Total:** 9 tasks, 5 agents across 2 waves
**Wave 1:** 3 parallel agents (Groups A, B, C)
**Wave 2:** 2 parallel agents (Groups D, E) — start after Wave 1 Group A completes
