# Implementation Plan: Workflow Phase Restructuring

## Source Design
Link: `docs/designs/2026-01-06-workflow-phase-restructuring.md`

## Summary
- Total tasks: 14
- Parallel groups: 3
- Estimated test count: ~20 (shell script tests + state validation)

This plan implements explicit phase restructuring to solve context consumption issues:
1. Add orchestrator constraints rule (no inline coding)
2. Add worktree enforcement (validation + prompt updates)
3. Add integration skill (new phase between delegate and review)
4. Update review skills (review integrated diff instead of fragments)
5. Simplify synthesis (remove merge/test logic)
6. Add fix delegation flow (all fixes via subagents)

## Task Breakdown

### Phase 1: Orchestrator Constraints

#### Task 001: Create orchestrator constraints rule file
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test script to validate rule file exists and contains required sections
   - File: `rules/orchestrator-constraints.md.test.sh`
   - Test: Verify file exists, contains "MUST NOT" section, contains "SHOULD" section
   - Run: `bash rules/orchestrator-constraints.md.test.sh`
   - Expected failure: File does not exist

2. [GREEN] Create the rule file
   - File: `rules/orchestrator-constraints.md`
   - Content: Define what orchestrator MUST NOT do (write code, fix inline) and SHOULD do (dispatch, track)
   - Run: `bash rules/orchestrator-constraints.md.test.sh`
   - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

### Phase 2: Worktree Enforcement

#### Task 002: Add worktree validation to git-worktrees skill
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Create test for worktree validation section
   - File: `skills/git-worktrees/SKILL.md.test.sh`
   - Test: Verify SKILL.md contains "Validation" section, contains verification commands
   - Run: `bash skills/git-worktrees/SKILL.md.test.sh`
   - Expected failure: Validation section missing or incomplete

2. [GREEN] Update skill with validation requirements
   - File: `skills/git-worktrees/SKILL.md`
   - Add: Worktree validation helpers section with pwd check, verification commands
   - Run: `bash skills/git-worktrees/SKILL.md.test.sh`
   - MUST PASS

3. [REFACTOR] Ensure consistent formatting with other skills

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

#### Task 003: Update implementer prompt with worktree verification
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for implementer prompt updates
   - File: `skills/delegation/references/implementer-prompt.md.test.sh`
   - Test: Verify prompt contains "CRITICAL: Worktree Verification", contains pwd check, contains abort instructions
   - Run: `bash skills/delegation/references/implementer-prompt.md.test.sh`
   - Expected failure: Worktree verification section missing

2. [GREEN] Update implementer prompt template
   - File: `skills/delegation/references/implementer-prompt.md`
   - Add: Worktree verification block with pwd check and abort on failure
   - Run: `bash skills/delegation/references/implementer-prompt.md.test.sh`
   - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group A)

---

#### Task 004: Update delegation skill with worktree enforcement
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for delegation skill worktree section
   - File: `skills/delegation/SKILL.md.test.sh`
   - Test: Verify skill contains worktree creation steps, gitignore check, state tracking for worktrees
   - Run: `bash skills/delegation/SKILL.md.test.sh`
   - Expected failure: Enforcement section incomplete

2. [GREEN] Update delegation skill
   - File: `skills/delegation/SKILL.md`
   - Add: Worktree enforcement section with creation, gitignore check, state tracking
   - Run: `bash skills/delegation/SKILL.md.test.sh`
   - MUST PASS

**Dependencies:** Task 002, Task 003
**Parallelizable:** No (depends on Group A)

---

### Phase 3: Integration Skill

#### Task 005: Create integration skill directory structure
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for integration skill structure
   - File: `skills/integration/structure.test.sh`
   - Test: Verify skills/integration/ directory exists, SKILL.md exists, references/ directory exists
   - Run: `bash skills/integration/structure.test.sh`
   - Expected failure: Directory does not exist

2. [GREEN] Create directory structure
   - Create: `skills/integration/SKILL.md` (placeholder)
   - Create: `skills/integration/references/` directory
   - Run: `bash skills/integration/structure.test.sh`
   - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

#### Task 006: Create integration skill SKILL.md
**Phase:** RED → GREEN → REFACTOR

**TDD Steps:**
1. [RED] Create test for integration skill content
   - File: `skills/integration/SKILL.md.test.sh`
   - Test: Verify contains Overview, Triggers, Integration Process, State Management, Transition sections
   - Run: `bash skills/integration/SKILL.md.test.sh`
   - Expected failure: Sections missing or empty

2. [GREEN] Write full integration skill
   - File: `skills/integration/SKILL.md`
   - Content: Define integration phase responsibilities, merge order, test verification, failure handling
   - Run: `bash skills/integration/SKILL.md.test.sh`
   - MUST PASS

3. [REFACTOR] Ensure consistent structure with other skills

**Dependencies:** Task 005
**Parallelizable:** No (depends on Task 005)

---

#### Task 007: Create integrator prompt template
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for integrator prompt
   - File: `skills/integration/references/integrator-prompt.md.test.sh`
   - Test: Verify contains Working Directory, Branches to Merge, Commands, Success Criteria sections
   - Run: `bash skills/integration/references/integrator-prompt.md.test.sh`
   - Expected failure: File does not exist

2. [GREEN] Create integrator prompt template
   - File: `skills/integration/references/integrator-prompt.md`
   - Content: Template for dispatching integration subagent
   - Run: `bash skills/integration/references/integrator-prompt.md.test.sh`
   - MUST PASS

**Dependencies:** Task 006
**Parallelizable:** No (depends on Task 006)

---

#### Task 008: Update workflow state schema for integration
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for schema integration section
   - File: `docs/schemas/workflow-state.schema.json.test.sh`
   - Test: Verify schema contains integration object with branch, status, mergedBranches, testResults properties
   - Run: `bash docs/schemas/workflow-state.schema.json.test.sh`
   - Expected failure: integration section missing or incomplete

2. [GREEN] Update schema
   - File: `docs/schemas/workflow-state.schema.json`
   - Add: integration object with required properties, add "integrate" to phase enum
   - Run: `bash docs/schemas/workflow-state.schema.json.test.sh`
   - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group B)

---

### Phase 4: Review Updates

#### Task 009: Update spec review for integrated diff
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for spec review integrated diff
   - File: `skills/spec-review/SKILL.md.test.sh`
   - Test: Verify skill references integrated diff, mentions integration branch, has updated review scope
   - Run: `bash skills/spec-review/SKILL.md.test.sh`
   - Expected failure: Still references per-worktree review

2. [GREEN] Update spec review skill
   - File: `skills/spec-review/SKILL.md`
   - Change: Review integrated diff (main...integration-branch), not per-worktree fragments
   - Run: `bash skills/spec-review/SKILL.md.test.sh`
   - MUST PASS

**Dependencies:** Task 006 (integration skill must exist)
**Parallelizable:** No

---

#### Task 010: Update quality review for integrated diff
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for quality review integrated diff
   - File: `skills/quality-review/SKILL.md.test.sh`
   - Test: Verify skill references integrated diff, mentions integration branch
   - Run: `bash skills/quality-review/SKILL.md.test.sh`
   - Expected failure: Still references per-worktree review

2. [GREEN] Update quality review skill
   - File: `skills/quality-review/SKILL.md`
   - Change: Review integrated diff (same as spec review change)
   - Run: `bash skills/quality-review/SKILL.md.test.sh`
   - MUST PASS

**Dependencies:** Task 009
**Parallelizable:** No

---

### Phase 5: Synthesis Simplification

#### Task 011: Simplify synthesis skill
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for simplified synthesis
   - File: `skills/synthesis/SKILL.md.test.sh`
   - Test: Verify synthesis expects integration branch already exists, does NOT contain merge logic, only creates PR
   - Run: `bash skills/synthesis/SKILL.md.test.sh`
   - Expected failure: Still contains inline merge/test logic

2. [GREEN] Update synthesis skill
   - File: `skills/synthesis/SKILL.md`
   - Change: Remove merge logic (handled by integrate phase), just create PR from integration branch
   - Run: `bash skills/synthesis/SKILL.md.test.sh`
   - MUST PASS

**Dependencies:** Task 006 (integration phase must handle merge)
**Parallelizable:** No

---

### Phase 6: Fix Delegation Flow

#### Task 012: Create fixer prompt template
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for fixer prompt
   - File: `skills/delegation/references/fixer-prompt.md.test.sh`
   - Test: Verify contains Issue to Fix, Worktree path, Verification sections
   - Run: `bash skills/delegation/references/fixer-prompt.md.test.sh`
   - Expected failure: File does not exist

2. [GREEN] Create fixer prompt template
   - File: `skills/delegation/references/fixer-prompt.md`
   - Content: Template for dispatching fix tasks to subagents
   - Run: `bash skills/delegation/references/fixer-prompt.md.test.sh`
   - MUST PASS

**Dependencies:** None
**Parallelizable:** Yes (Group C)

---

#### Task 013: Update delegation skill with fix mode
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for delegation fix mode
   - File: `skills/delegation/fix-mode.test.sh`
   - Test: Verify SKILL.md contains "--fixes" argument handling, fix task extraction, re-integrate flow
   - Run: `bash skills/delegation/fix-mode.test.sh`
   - Expected failure: Fix mode section missing

2. [GREEN] Update delegation skill
   - File: `skills/delegation/SKILL.md`
   - Add: Fix mode section with --fixes argument, extraction from review report, re-integrate after fix
   - Run: `bash skills/delegation/fix-mode.test.sh`
   - MUST PASS

**Dependencies:** Task 012, Task 006 (needs fixer template and integration phase)
**Parallelizable:** No

---

#### Task 014: Update review skills with fix delegation
**Phase:** RED → GREEN

**TDD Steps:**
1. [RED] Create test for review fix delegation
   - File: `skills/review-fix-delegation.test.sh`
   - Test: Verify spec-review and quality-review have transition to delegate --fixes
   - Run: `bash skills/review-fix-delegation.test.sh`
   - Expected failure: Transitions still do inline fixes

2. [GREEN] Update review skills
   - Files: `skills/spec-review/SKILL.md`, `skills/quality-review/SKILL.md`
   - Change: On FAIL, transition to `/delegate --fixes` instead of inline fix
   - Run: `bash skills/review-fix-delegation.test.sh`
   - MUST PASS

**Dependencies:** Task 013
**Parallelizable:** No

---

## Parallelization Strategy

### Group A (Foundation - can run in parallel)
- Task 001: Orchestrator constraints rule
- Task 002: Worktree validation in git-worktrees skill
- Task 003: Implementer prompt worktree verification

### Group B (Integration Phase - can run in parallel with Group A)
- Task 005: Integration skill directory structure
- Task 008: Workflow state schema updates

### Group C (Fix Flow - can run in parallel after dependencies)
- Task 012: Fixer prompt template

### Sequential Chains

**Chain 1 (Worktree Enforcement):**
```
Group A (001, 002, 003) → Task 004
```

**Chain 2 (Integration Phase):**
```
Task 005 → Task 006 → Task 007
Task 008 (parallel with 005-007)
```

**Chain 3 (Review Updates):**
```
Task 006 → Task 009 → Task 010 → Task 011
```

**Chain 4 (Fix Delegation):**
```
Task 012 → Task 013 → Task 014
```

### Execution Order

**Wave 1 (Parallel):**
- Group A: Tasks 001, 002, 003
- Group B: Tasks 005, 008
- Group C: Task 012

**Wave 2 (After Wave 1):**
- Task 004 (depends on 002, 003)
- Task 006 (depends on 005)

**Wave 3 (After Wave 2):**
- Task 007 (depends on 006)
- Task 009 (depends on 006)
- Task 013 (depends on 012, 006)

**Wave 4 (After Wave 3):**
- Task 010 (depends on 009)
- Task 014 (depends on 013)

**Wave 5 (After Wave 4):**
- Task 011 (depends on 006, can run after review updates understood)

## Completion Checklist

- [ ] All tests written before implementation
- [ ] All shell script tests pass
- [ ] Skills follow consistent structure
- [ ] State schema validates
- [ ] Workflow transitions are correct
- [ ] Ready for review
