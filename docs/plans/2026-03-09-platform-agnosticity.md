# Implementation Plan: Platform Agnosticity Gap

## Source Design
Link: `docs/designs/2026-03-09-platform-agnosticity.md`

## Scope
**Target:** Full design — all 3 levers (11 DRs)
**Excluded:** None

## Summary
- Total tasks: 10
- Parallel groups: 3 (one per lever, all run simultaneously)
- Estimated test count: ~25
- Design coverage: 11/11 DRs covered

## Spec Traceability

| Design Section | DR | Task(s) | Key Requirements |
|---|---|---|---|
| Lever 1: Enriched compactGuidance | DR-1 | 002 | Feature workflow 9 phases, 4-section format, <=750 chars |
| Lever 1: Enriched compactGuidance | DR-2 | 003 | Debug workflow 10 phases, track-selection criteria |
| Lever 1: Enriched compactGuidance | DR-3 | 004 | Refactor workflow 11 phases, polish vs overhaul criteria |
| Lever 1: Enriched compactGuidance | DR-4 | 001 | Drift test validates all playbooks, iterates registry |
| Lever 2: Decision Runbooks | DR-5 | 007 | Extend RunbookStep + ResolvedRunbookStep types |
| Lever 2: Decision Runbooks | DR-6 | 008 | 6 decision runbooks, >=2 decide steps, >=1 escalate |
| Lever 2: Decision Runbooks | DR-7 | 009 | Serve via existing runbook action, backward-compatible |
| Lever 2: Decision Runbooks | DR-8 | 010 | 4+ skills updated with decision runbook references |
| Lever 2: Decision Runbooks | DR-11 | 009 | Graceful degradation, full tree regardless of state |
| Lever 3: Schema Field Descriptions | DR-9 | 006 | .describe() on all model-emitted event fields |
| Lever 3: Schema Field Descriptions | DR-10 | 005 | Drift test iterates model-emitted schemas |

## Task Breakdown

### Task 001: compactGuidance drift test (DR-4)
**Implements:** DR-4
**Phase:** RED → GREEN (test written first, passes after Tasks 002-004)

1. [RED] Write drift tests in `playbooks.test.ts`:
   - `compactGuidance_AllNonTerminalPhases_Under750Chars` — iterate all registered playbooks, verify `compactGuidance.length <= 750` for non-terminal phases
   - `compactGuidance_AllNonTerminalNonBlockedPhases_MentionsToolOrAction` — verify each guidance mentions at least one tool name or action
   - `compactGuidance_AllRegisteredPlaybooks_HaveGuidance` — verify `compactGuidance.length > 0`
   - `compactGuidance_NonTerminalNonBlockedPhases_ExceedsMinLength` — verify `compactGuidance.length >= 200` for non-terminal, non-blocked phases (FAILS on current ~150 char averages)
   - File: `servers/exarchos-mcp/src/workflow/playbooks.test.ts`
   - Expected failure: min-length test fails because current guidance averages ~150 chars

2. [GREEN] Tests pass once Tasks 002-004 complete

**Dependencies:** None
**Parallelizable:** Yes (Group A lead, parallel with Groups B/C)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 002: Enrich feature workflow compactGuidance (DR-1)
**Implements:** DR-1
**Phase:** GREEN → REFACTOR

1. [GREEN] Update 6 non-terminal, non-blocked feature playbook `compactGuidance` strings in `playbooks.ts`:
   - `ideate` — add decision criteria (problem-first vs solution-first), anti-pattern (jumping to implementation), escalation (design scope unclear after 2 iterations)
   - `plan` — add decision criteria (task granularity, parallel vs sequential), anti-pattern (monolith tasks), escalation (design has ambiguous requirements)
   - `plan-review` — add decision criteria (approve vs revise), anti-pattern (rubber-stamping plans without checking coverage), escalation (3+ revision cycles)
   - `delegate` — use enriched guidance from spike example (subagent prompts self-contained, independent tasks parallel, verify test output independently, escalate on 3 failures)
   - `review` — add decision criteria (fix vs block vs pass), anti-pattern (trusting passing tests as completeness proof), escalation (same finding appears in 2+ cycles)
   - `synthesize` — add decision criteria (single PR vs stacked), anti-pattern (merging without CI green), escalation (CI fails 3+ times on same issue)
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Preserve existing content that tests assert on (e.g., "GitHub CLI" in synthesize)
   - Each string: 4 sections (what/decisions/anti-pattern/escalation), <=750 chars

2. [REFACTOR] Verify existing playbook tests still pass (especially `ReferencesGhCli` assertions)

**Dependencies:** Task 001
**Parallelizable:** No (sequential within Group A, modifies playbooks.ts)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 003: Enrich debug workflow compactGuidance (DR-2)
**Implements:** DR-2
**Phase:** GREEN → REFACTOR

1. [GREEN] Update 10 non-terminal, non-blocked debug playbook `compactGuidance` strings in `playbooks.ts`:
   - `triage` — add decision criteria (severity assessment: P0 vs P1), anti-pattern (skipping reproduction), escalation (not reproducible after 15 min)
   - `investigate` — add track-selection criteria (reproducible + <=3 files → hotfix; intermittent or cross-module → thorough), anti-pattern (premature hotfix on complex bugs), escalation (15 min without root cause)
   - `rca` — add decision criteria (depth: immediate cause vs systemic), anti-pattern (stopping at symptoms), escalation (root cause spans multiple subsystems)
   - `design` — add decision criteria (minimal fix vs defensive fix), anti-pattern (scope creep beyond bug fix), escalation (fix requires architectural change)
   - `debug-implement` — add decision criteria (test-first verification), anti-pattern (fixing without failing test), escalation (implementation touches >5 files)
   - `debug-validate` — add decision criteria (regression scope), anti-pattern (only testing the fix, not adjacent behavior), escalation (new test failures appear)
   - `debug-review` — add decision criteria (review depth), anti-pattern (skipping review for "simple" fixes), escalation (fix changes public API)
   - `hotfix-implement` — add 15-min time limit, anti-pattern (hotfix growing into full fix), escalation (time limit exceeded)
   - `hotfix-validate` — add decision criteria (PR vs direct commit), anti-pattern (merging without validation)
   - `synthesize` — include "GitHub CLI" reference, add anti-pattern and escalation
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Each string: 4 sections, <=750 chars

2. [REFACTOR] Verify existing debug playbook tests still pass

**Dependencies:** Task 002 (sequential file access)
**Parallelizable:** No (sequential within Group A)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 004: Enrich refactor workflow compactGuidance (DR-3)
**Implements:** DR-3
**Phase:** GREEN → REFACTOR

1. [GREEN] Update 11 non-terminal, non-blocked refactor playbook `compactGuidance` strings in `playbooks.ts`:
   - `explore` — add decision criteria (scope assessment: files, complexity, risk), anti-pattern (exploring without boundary), escalation (scope exceeds single PR)
   - `brief` — add track-selection criteria (polish: <=5 files, cosmetic/DRY; overhaul: >5 files, structural), anti-pattern (choosing polish for structural changes), escalation (scope unclear after exploration)
   - `polish-implement` — add decision criteria (stay within brief scope), anti-pattern (scope creep), escalation (changes cascade beyond brief)
   - `polish-validate` — add decision criteria (verify goals met), anti-pattern (accepting partial completion), escalation (goals not achievable without overhaul)
   - `polish-update-docs` — add decision criteria (what docs need update), anti-pattern (skipping docs for "obvious" changes)
   - `overhaul-plan` — add decision criteria (task granularity for large refactor), anti-pattern (monolith tasks), escalation (plan exceeds 20 tasks)
   - `overhaul-plan-review` — add decision criteria (approve vs revise), anti-pattern (rubber-stamping), escalation (3+ revisions)
   - `overhaul-delegate` — add delegation strategy, anti-pattern (shared worktrees), escalation (3 task failures)
   - `overhaul-review` — add review criteria, anti-pattern (trusting self-assessment), escalation (regression findings)
   - `overhaul-update-docs` — add doc update criteria
   - `synthesize` — include "GitHub CLI" reference, add anti-pattern and escalation
   - File: `servers/exarchos-mcp/src/workflow/playbooks.ts`
   - Each string: 4 sections, <=750 chars

2. [REFACTOR] Verify all playbook tests pass. All drift tests from Task 001 should now be GREEN.

**Dependencies:** Task 003 (sequential file access)
**Parallelizable:** No (sequential within Group A)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 005: Schema description drift test (DR-10)
**Implements:** DR-10
**Phase:** RED

1. [RED] Write drift test in `schemas.test.ts`:
   - `modelEmittedEventSchemas_AllFields_HaveDescriptions` — for each model-emitted event type in `EVENT_EMISSION_REGISTRY`, get its schema from `EVENT_DATA_SCHEMAS`, convert via `zodToJsonSchema`, and verify every field in `properties` has a `description` property
   - `modelEmittedEventSchemas_Descriptions_AreReasonableLength` — verify each description is 5-80 chars (not empty, not verbose)
   - File: `servers/exarchos-mcp/src/event-store/schemas.test.ts`
   - Expected failure: no model-emitted event fields have `.describe()` annotations (0/~100 fields)

2. [GREEN] Tests pass once Task 006 completes

**Dependencies:** None
**Parallelizable:** Yes (Group B lead, parallel with Groups A/C)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 006: Annotate model-emitted event schemas (DR-9)
**Implements:** DR-9
**Phase:** GREEN → REFACTOR

1. [GREEN] Add `.describe()` to every field in the 25 model-emitted event Zod schemas in `schemas.ts`:
   - **Task events** (2 schemas): `TaskAssignedData`, `TaskProgressedData`
   - **Team events** (7 schemas): `TeamSpawnedData`, `TeamTaskAssignedData`, `TeamTaskCompletedData`, `TeamTaskFailedData`, `TeamDisbandedData`, `TeamTaskPlannedData`, `TeamTeammateDispatchedData`
   - **Review events** (3 schemas): `ReviewRoutedData`, `ReviewFindingData`, `ReviewEscalatedData`
   - **Remediation events** (2 schemas): `RemediationAttemptedDataSchema`, `RemediationSucceededDataSchema`
   - **Session events** (1 schema): `SessionTaggedData`
   - **Readiness events** (6 schemas): `WorktreeCreatedData`, `WorktreeBaselineData`, `TestResultData`, `TypecheckResultData`, `StackSubmittedData`, `CiStatusData`
   - **Comment events** (2 schemas): `CommentPostedData`, `CommentResolvedData`
   - **Shepherd events** (1 schema): `ShepherdIterationData`
   - **Quality events** (1 schema): `QualityRegressionData`
   - File: `servers/exarchos-mcp/src/event-store/schemas.ts`
   - Each description: 5-20 words, concise and actionable
   - ~100 fields total across 25 schemas

2. [REFACTOR] Verify drift test from Task 005 now passes. Verify existing schema tests unchanged.

**Dependencies:** Task 005
**Parallelizable:** No (sequential within Group B)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 007: Extend RunbookStep types for decision fields (DR-5)
**Implements:** DR-5
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write type-level tests in a new test section in `runbooks/handler.test.ts` (or `runbooks/types.test.ts`):
   - `DecisionField_ValidBranches_TypeChecks` — create a decision step object that compiles
   - `RunbookStep_WithoutDecide_StillValid` — verify existing steps compile without `decide`
   - `ResolvedRunbookStep_WithDecide_IncludesDecisionFields` — verify resolved step includes `decide`
   - File: `servers/exarchos-mcp/src/runbooks/types.test.ts` (new)
   - Expected failure: `decide` property doesn't exist on `RunbookStep`

2. [GREEN] Add types to `types.ts`:
   - `DecisionBranch` interface: `{ label, guidance, nextStep?, escalate? }`
   - `DecisionField` interface: `{ question, source, field?, branches }`
   - Add optional `decide?: DecisionField` to `RunbookStep`
   - Add optional `decide?: DecisionField` to `ResolvedRunbookStep`
   - File: `servers/exarchos-mcp/src/runbooks/types.ts`

3. [REFACTOR] Verify existing runbook tests still pass (backward-compatible)

**Dependencies:** None
**Parallelizable:** Yes (Group C lead, parallel with Groups A/B)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 008: Implement 6 decision runbook definitions (DR-6)
**Implements:** DR-6
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `runbooks/definitions.test.ts` (new or extend existing drift test):
   - `decisionRunbooks_EachHasAtLeast2DecideSteps` — iterate decision runbooks, verify `steps.filter(s => s.decide).length >= 2`
   - `decisionRunbooks_EachHasAtLeast1EscalateBranch` — verify at least one branch has `escalate: true`
   - `decisionRunbooks_BranchGuidance_IsActionable` — verify branch guidance strings are >= 20 chars (not empty stubs)
   - `decisionRunbooks_AllRegisteredInAllRunbooks` — verify all 6 are in `ALL_RUNBOOKS`
   - File: `servers/exarchos-mcp/src/runbooks/definitions.test.ts` (new)
   - Expected failure: no decision runbooks exist yet

2. [GREEN] Add 6 decision runbooks to `definitions.ts`:
   - `triage-decision` (debug/triage): Hotfix vs thorough track. Steps: check-reproducibility, check-scope, check-urgency
   - `investigation-decision` (debug/investigate): When to escalate to RCA. Steps: check-time-spent, check-hypothesis-count, check-cross-module
   - `scope-decision` (refactor/explore): Polish vs overhaul track. Steps: check-file-count, check-structural-change, check-risk
   - `dispatch-decision` (feature+refactor/delegate): Parallel vs sequential, team sizing. Steps: check-task-independence, check-file-overlap, check-team-size
   - `review-escalation` (all/review): Fix cycle vs block vs pass. Steps: check-finding-severity, check-fix-cycle-count, check-design-alignment
   - `shepherd-escalation` (all/synthesize): Keep iterating vs escalate. Steps: check-iteration-count, check-ci-stability, check-review-status
   - Add all 6 to `ALL_RUNBOOKS` array
   - File: `servers/exarchos-mcp/src/runbooks/definitions.ts`
   - Each uses `tool: 'none', action: 'decide'` for decision steps

3. [REFACTOR] Verify existing drift tests still pass (new runbooks shouldn't break `computeRunbookAutoEmits` since `tool: 'none'` steps are skipped like `native:` steps)

**Dependencies:** Task 007 (needs DecisionField type)
**Parallelizable:** No (sequential within Group C)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 009: Serve decision runbooks via handler (DR-7, DR-11)
**Implements:** DR-7, DR-11
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write tests in `runbooks/handler.test.ts`:
   - `handleRunbook_DecisionRunbook_ReturnsDecideFields` — request a decision runbook by id, verify response includes `steps[].decide.question` and `steps[].decide.branches`
   - `handleRunbook_DecisionRunbook_NoSchemaResolutionForNoneSteps` — verify `tool: 'none'` steps don't fail schema resolution
   - `handleRunbook_LinearRunbook_UnchangedResponse` — verify existing linear runbook response format is identical (backward-compatible)
   - `handleRunbook_ListMode_IncludesDecisionRunbooks` — verify list mode includes decision runbook entries
   - File: `servers/exarchos-mcp/src/runbooks/handler.test.ts`
   - Expected failure: handler returns error for `tool: 'none'` steps (not in registry, not `native:`)

2. [GREEN] Update handler to support decision steps:
   - In `handleRunbook`, add condition: if `step.tool === 'none'`, skip schema resolution (same pattern as `native:` check)
   - Pass through `decide` field in resolved step when present
   - File: `servers/exarchos-mcp/src/runbooks/handler.ts`

3. [REFACTOR] Verify all runbook handler tests pass, including new and existing

**Dependencies:** Task 008 (needs decision runbook definitions to test against)
**Parallelizable:** No (sequential within Group C)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

---

### Task 010: Skill refactoring — reference decision runbooks (DR-8)
**Implements:** DR-8
**Phase:** GREEN → REFACTOR

1. [GREEN] Update 4+ skill SKILL.md files to reference decision runbooks:
   - `skills/debug/SKILL.md` — replace inline hotfix-vs-thorough decision logic with reference to `triage-decision` and `investigation-decision` runbooks
   - `skills/refactor/SKILL.md` — replace inline polish-vs-overhaul decision logic with reference to `scope-decision` runbook
   - `skills/delegation/SKILL.md` — replace inline dispatch strategy with reference to `dispatch-decision` runbook
   - `skills/quality-review/SKILL.md` — replace inline verdict routing logic with reference to `review-escalation` runbook
   - Pattern: "For track-selection decision criteria, query: `exarchos_orchestrate({ action: 'runbook', id: '<id>' })`"
   - Same refactoring pattern as PR #986 (schemas → describe references)

2. [REFACTOR] Verify skill Markdown is well-formed and runbook references are correct IDs

**Dependencies:** Task 008 (needs runbook IDs to reference)
**Parallelizable:** No (sequential within Group C, but no file overlap with Groups A/B)
**testingStrategy:** `{ exampleTests: true, propertyTests: false, benchmarks: false }`

## Parallelization Strategy

Three independent tracks running in parallel worktrees:

```
Group A (Lever 1):  001 → 002 → 003 → 004     [playbooks.ts]
Group B (Lever 3):  005 → 006                   [schemas.ts]
Group C (Lever 2):  007 → 008 → 009 → 010      [types.ts, definitions.ts, handler.ts, skills/*.md]
```

**File ownership (no conflicts):**
- Group A owns: `playbooks.ts`, `playbooks.test.ts`
- Group B owns: `schemas.ts`, `schemas.test.ts`
- Group C owns: `runbooks/types.ts`, `runbooks/types.test.ts`, `runbooks/definitions.ts`, `runbooks/definitions.test.ts`, `runbooks/handler.ts`, `runbooks/handler.test.ts`, `skills/**/*.md`

**No cross-group file overlap** — all three groups can merge independently.

## Deferred Items

None. All 11 DRs are covered.

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Existing tests unbroken (especially playbook content assertions)
- [ ] Code coverage meets standards
- [ ] compactGuidance drift test validates all playbooks
- [ ] Schema description drift test validates all model-emitted events
- [ ] Decision runbooks serve correctly via existing runbook action
- [ ] Skills reference decision runbooks (not inline logic)
- [ ] Ready for review
