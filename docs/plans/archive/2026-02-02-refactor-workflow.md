# Implementation Plan: Refactor Workflow

## Source Design

Link: `docs/designs/2026-02-02-refactor-workflow.md`

## Scope

**Target:** Full design implementation
**Excluded:** None

## Summary

- Total tasks: 16
- Parallel groups: 3
- Estimated test count: 12
- Design coverage: 8/8 sections covered

## Spec Traceability

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|------------------|------------|--------|
| Technical Design > Workflow Overview | Two-track model diagram | — | Documentation only |
| Technical Design > Polish Track | Fast path phases, no worktree, orchestrator exception | 005, 006, 007 | Covered |
| Technical Design > Overhaul Track | Full delegation phases, worktree isolation | 008, 009, 010 | Covered |
| Technical Design > Explore Phase | Scope assessment, track recommendation | 003 | Covered |
| Technical Design > Brief Phase | Goal capture in state | 004 | Covered |
| Technical Design > Update Docs Phase | Documentation update enforcement | 011 | Covered |
| Technical Design > State Schema | Refactor-specific fields | 001 | Covered |
| Technical Design > Command Interface | Entry points, flags | 002 | Covered |
| Technical Design > Auto-Chain Behavior | Single human checkpoint | 012 | Covered |
| Technical Design > Polish Orchestrator Exception | Direct implementation allowed | 006 | Covered |
| Integration Points > New Skills | SKILL.md and reference files | 013, 014 | Covered |
| Integration Points > Modified Components | workflow-state.sh, auto-resume, orchestrator constraints | 001, 015, 016 | Covered |
| Integration Points > Reused Components | /plan, /delegate, /integrate, /review, /synthesize | 008, 009 | Covered (via overhaul integration) |
| Testing Strategy | State transitions, track selection, brief validation | All tasks include tests | Covered |

## Task Breakdown

### Task 001: Add refactor workflow type to workflow-state.sh

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `cmd_init_RefactorType_CreatesCorrectSchema`
   - File: `tests/workflow-state.test.sh`
   - Expected failure: No --refactor flag support
   - Run: `bash tests/workflow-state.test.sh` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/scripts/workflow-state.sh`
   - Changes: Add `--refactor` flag to init command, create refactor state template with track, brief, explore, and validation fields
   - Run: `bash tests/workflow-state.test.sh` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: DRY - extract common state template parts
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 002: Add refactor command definition

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RefactorCommand_ParsesFlags_ReturnsCorrectTrack`
   - File: `tests/skills/refactor/command.test.ts`
   - Expected failure: No refactor command defined
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/command.ts` (or equivalent command registration)
   - Changes: Define /refactor command with --polish, --explore flags
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Consistent with /debug command pattern
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Task 003: Implement explore phase logic

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `ExplorePhase_SmallScope_RecommendsPolish`
   - File: `tests/skills/refactor/explore.test.ts`
   - Expected failure: No explore phase implementation
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `ExplorePhase_LargeScope_RecommendsOverhaul`
   - File: `tests/skills/refactor/explore.test.ts`
   - Expected failure: No explore phase implementation
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/references/explore-checklist.md`
   - Changes: Define scope assessment criteria (files, concerns, cross-module, test gaps, doc updates)
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Clear decision table format
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001
**Parallelizable:** No (depends on 001)

---

### Task 004: Implement brief phase with state capture

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `BriefPhase_CapturesAllFields_UpdatesState`
   - File: `tests/skills/refactor/brief.test.ts`
   - Expected failure: No brief capture logic
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `BriefPhase_ValidatesRequiredFields_RejectsIncomplete`
   - File: `tests/skills/refactor/brief.test.ts`
   - Expected failure: No validation
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/references/brief-template.md`
   - Changes: Define brief structure with problem, goals, approach, affectedAreas, outOfScope, successCriteria, docsToUpdate
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Clear examples for polish vs overhaul brief depth
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001
**Parallelizable:** No (depends on 001)

---

### Task 005: Implement polish track implement phase

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `PolishImplement_DirectEdit_NoWorktree`
   - File: `tests/skills/refactor/polish-implement.test.ts`
   - Expected failure: No polish implement phase
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `PolishImplement_ScopeExpands_SwitchesToOverhaul`
   - File: `tests/skills/refactor/polish-implement.test.ts`
   - Expected failure: No scope expansion detection
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (polish implement section)
   - Changes: Define direct implementation flow with scope guardrails
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Clear when to switch to overhaul
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 003, 004
**Parallelizable:** No

---

### Task 006: Document orchestrator exception for polish track

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `OrchestratorConstraints_PolishTrack_AllowsDirectImplementation`
   - File: `tests/rules/orchestrator-constraints.test.ts`
   - Expected failure: No exception defined
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `rules/orchestrator-constraints.md`
   - Changes: Add explicit exception for polish track implement phase
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Clear guardrails for when exception applies
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 005
**Parallelizable:** No

---

### Task 007: Implement polish track validate phase

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `PolishValidate_TestsPass_GoalsVerified_Succeeds`
   - File: `tests/skills/refactor/polish-validate.test.ts`
   - Expected failure: No validate phase
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `PolishValidate_GoalNotMet_Fails`
   - File: `tests/skills/refactor/polish-validate.test.ts`
   - Expected failure: No goal verification
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (polish validate section)
   - Changes: Define validation checklist (tests pass, goals addressed, no new errors)
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent validation output format
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 005
**Parallelizable:** No

---

### Task 008: Implement overhaul track plan phase integration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `OverhaulPlan_InvokesPlanSkill_WithRefactorPrompt`
   - File: `tests/skills/refactor/overhaul-plan.test.ts`
   - Expected failure: No plan integration
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (overhaul plan section)
   - Changes: Define how to invoke /plan with refactor-specific context (incremental changes, working state guarantee)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Clear handoff to existing skill
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 003, 004
**Parallelizable:** Yes (Group B - parallel with polish track tasks)

---

### Task 009: Implement overhaul track delegation integration

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `OverhaulDelegate_UsesWorktrees_FollowsTDD`
   - File: `tests/skills/refactor/overhaul-delegate.test.ts`
   - Expected failure: No delegate integration
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (overhaul delegate section)
   - Changes: Define how to invoke /delegate, /integrate, /review chain
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Emphasize quality review for refactors
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 008
**Parallelizable:** No

---

### Task 010: Implement overhaul track review emphasis

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `OverhaulReview_QualityEmphasis_HigherStandard`
   - File: `tests/skills/refactor/overhaul-review.test.ts`
   - Expected failure: No refactor-specific review criteria
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (overhaul review section)
   - Changes: Define enhanced quality review focus for refactors (regression risk, behavior preservation)
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Clear review criteria specific to refactoring
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 009
**Parallelizable:** No

---

### Task 011: Implement update-docs phase

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `UpdateDocs_DocsListEmpty_VerifiesNoneNeeded`
   - File: `tests/skills/refactor/update-docs.test.ts`
   - Expected failure: No update-docs phase
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `UpdateDocs_DocsListed_VerifiesUpdated`
   - File: `tests/skills/refactor/update-docs.test.ts`
   - Expected failure: No update verification
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/references/doc-update-checklist.md`
   - Changes: Define documentation update requirements and verification process
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Clear checklist format
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 007, 010 (runs after both tracks' main phases)
**Parallelizable:** No

---

### Task 012: Implement auto-chain for both tracks

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `AutoChain_PolishTrack_ChainsToHumanCheckpoint`
   - File: `tests/skills/refactor/auto-chain.test.ts`
   - Expected failure: No auto-chain defined
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `AutoChain_OverhaulTrack_ChainsToHumanCheckpoint`
   - File: `tests/skills/refactor/auto-chain.test.ts`
   - Expected failure: No auto-chain defined
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md` (auto-chain section)
   - Changes: Define phase transitions with single human checkpoint at end
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent with feature/debug workflow patterns
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 011
**Parallelizable:** No

---

### Task 013: Create main refactor SKILL.md

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RefactorSkill_FileExists_HasRequiredSections`
   - File: `tests/skills/refactor/skill-structure.test.ts`
   - Expected failure: No SKILL.md file
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `~/.claude/skills/refactor/SKILL.md`
   - Changes: Create complete skill file with overview, triggers, workflow, phases, commands, state management
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Consistent structure with debug SKILL.md
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 012
**Parallelizable:** No

---

### Task 014: Create reference files for refactor skill

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `RefactorReferences_AllFilesExist_HaveContent`
   - File: `tests/skills/refactor/references.test.ts`
   - Expected failure: No reference files
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - Files:
     - `~/.claude/skills/refactor/references/explore-checklist.md`
     - `~/.claude/skills/refactor/references/brief-template.md`
     - `~/.claude/skills/refactor/references/doc-update-checklist.md`
   - Changes: Create all reference files with templates and checklists
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up
   - Apply: Consistent format with debug references
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 013
**Parallelizable:** No

---

### Task 015: Update workflow-auto-resume.md for refactor phases

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `AutoResume_RefactorPolishPhases_ReturnsCorrectAction`
   - File: `tests/rules/workflow-auto-resume.test.ts`
   - Expected failure: No refactor phase handling
   - Run: `npm run test:run` - MUST FAIL

2. [RED] Write test: `AutoResume_RefactorOverhaulPhases_ReturnsCorrectAction`
   - File: `tests/rules/workflow-auto-resume.test.ts`
   - Expected failure: No refactor phase handling
   - Run: `npm run test:run` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `rules/workflow-auto-resume.md`
   - Changes: Add refactor workflow actions table, update human checkpoints section
   - Run: `npm run test:run` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent table format with feature/debug sections
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001
**Parallelizable:** Yes (Group C)

---

### Task 016: Add refactor next-action handling to workflow-state.sh

**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Write test: `NextAction_RefactorPolish_ReturnsCorrectAutoAction`
   - File: `tests/workflow-state.test.sh`
   - Expected failure: No refactor handling in next-action
   - Run: `bash tests/workflow-state.test.sh` - MUST FAIL

2. [RED] Write test: `NextAction_RefactorOverhaul_ReturnsCorrectAutoAction`
   - File: `tests/workflow-state.test.sh`
   - Expected failure: No refactor handling in next-action
   - Run: `bash tests/workflow-state.test.sh` - MUST FAIL

3. [GREEN] Implement minimum code
   - File: `~/.claude/scripts/workflow-state.sh`
   - Changes: Add refactor workflow handling to cmd_next_action and cmd_summary functions
   - Run: `bash tests/workflow-state.test.sh` - MUST PASS

4. [REFACTOR] Clean up
   - Apply: Consistent case statement structure with debug handling
   - Run: Tests MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** 001, 015
**Parallelizable:** No

## Parallelization Strategy

### Sequential Chains

**Chain A: Foundation**
```
Task 001 (state schema) → Task 003 (explore) → Task 004 (brief)
```

**Chain B: Polish Track**
```
Task 004 → Task 005 (implement) → Task 006 (orchestrator exception) → Task 007 (validate)
```

**Chain C: Overhaul Track**
```
Task 004 → Task 008 (plan) → Task 009 (delegate) → Task 010 (review)
```

**Chain D: Finalization**
```
Task 007, Task 010 → Task 011 (update-docs) → Task 012 (auto-chain) → Task 013 (SKILL.md) → Task 014 (references)
```

**Chain E: Infrastructure**
```
Task 001 → Task 015 (auto-resume) → Task 016 (next-action)
```

### Parallel Groups

| Group | Tasks | Can Run With |
|-------|-------|--------------|
| A | 001, 002 | Each other |
| B | 005-007 (polish), 008-010 (overhaul) | Each other after 004 completes |
| C | 015 | After 001 completes |

### Worktree Assignments

```
.worktrees/001-state-schema     → Task 001
.worktrees/002-command          → Task 002
.worktrees/003-005-polish       → Tasks 003, 004, 005, 006, 007
.worktrees/008-010-overhaul     → Tasks 008, 009, 010
.worktrees/011-014-finalize     → Tasks 011, 012, 013, 014
.worktrees/015-016-infra        → Tasks 015, 016
```

## Deferred Items

None - all design sections are covered.

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Design coverage verified (8/8 sections)
- [ ] Ready for review
