# Implementation Planning Skill

## Overview

Transform design documents into TDD-based implementation plans with granular, parallelizable tasks. Ensures complete spec coverage through explicit traceability.

## Triggers

Activate this skill when:
- User runs `/plan` command
- User wants to break down a design into tasks
- A design document exists and needs implementation steps
- User says "plan the implementation" or similar
- Auto-chained from `/ideate` after design completion

## The Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

Every implementation task MUST:
1. Start with writing a failing test
2. Specify the expected failure reason
3. Only then implement minimum code to pass

## Task Format

Each task follows this structure:

```markdown
### Task [N]: [Brief Description]

**Phase:** [RED | GREEN | REFACTOR]

**TDD Steps:**
1. [RED] Write test: `TestName_Scenario_ExpectedOutcome`
   - File: `path/to/test.ts`
   - Expected failure: [Specific failure reason]
   - Run: `npm run test:run` - MUST FAIL

2. [GREEN] Implement minimum code
   - File: `path/to/implementation.ts`
   - Changes: [Brief description]
   - Run: `npm run test:run` - MUST PASS

3. [REFACTOR] Clean up (optional)
   - Apply: [SOLID principle or improvement]
   - Run: `npm run test:run` - MUST STAY GREEN

**Verification:**
- [ ] Witnessed test fail for the right reason
- [ ] Test passes after implementation
- [ ] No extra code beyond test requirements

**Dependencies:** [Task IDs this depends on, or "None"]
**Parallelizable:** [Yes/No]
```

## Planning Process

### Step 1: Analyze Design Document

Read the design document thoroughly. For each major section, extract:
- **Problem Statement** → Context (no tasks, but informs scope)
- **Chosen Approach** → Architectural decisions to implement
- **Technical Design** → Core implementation requirements
- **Integration Points** → Integration and glue code tasks
- **Testing Strategy** → Test coverage requirements
- **Open Questions** → Decisions to resolve or explicitly defer

### Step 1.5: Spec Tracing (Required)

Create a traceability table mapping design sections to planned tasks. This ensures complete coverage.

```markdown
## Spec Traceability

### Scope Declaration

**Target:** [Full design | Partial: <specific components>]
**Excluded:** [List any intentionally excluded sections with rationale]

### Traceability Matrix

| Design Section | Key Requirements | Task ID(s) | Status |
|----------------|-----------------|------------|--------|
| Technical Design > Component A | - Requirement 1<br>- Requirement 2 | 001, 002 | Covered |
| Technical Design > Component B | - Requirement 3 | 003 | Covered |
| Integration Points > X | - Connection to Y | 004 | Covered |
| Testing Strategy | - Unit tests<br>- Integration tests | 005, 006 | Covered |
| Open Questions > Q1 | Decision needed | — | Deferred: [reason] |
```

**Rules:**
- Every sub-section of Technical Design MUST map to ≥1 task
- Every file in "Files Changed" table MUST be touched by ≥1 task
- Open Questions MUST be resolved OR explicitly deferred with rationale
- For partial plans, declare scope upfront and only trace in-scope sections

### Step 2: Decompose into Tasks

**Granularity Guidelines:**
- Each task: 2-5 minutes of focused work
- One test = one behavior
- Prefer many small tasks over few large ones

**Task Ordering:**
1. Foundation first (types, interfaces, data structures)
2. Core behaviors second
3. Edge cases and error handling third
4. Integration and glue code last

### Step 3: Identify Parallelization

Analyze dependencies to find:
- **Sequential tasks:** Must be done in order
- **Parallel-safe tasks:** Can be done simultaneously in worktrees

```markdown
## Parallelization Analysis

### Sequential Chain A
Task 1 → Task 2 → Task 5

### Sequential Chain B
Task 3 → Task 4 → Task 6

### Parallel Groups
- Group 1: [Chain A tasks]
- Group 2: [Chain B tasks]
- Can run simultaneously in separate worktrees
```

### Step 4: Generate Plan Document

Save to: `docs/plans/YYYY-MM-DD-<feature>.md`

```markdown
# Implementation Plan: [Feature Name]

## Source Design
Link: `docs/designs/YYYY-MM-DD-<feature>.md`

## Scope
**Target:** [Full design | Partial: <specific components>]
**Excluded:** [None | List excluded sections with rationale]

## Summary
- Total tasks: [N]
- Parallel groups: [N]
- Estimated test count: [N]
- Design coverage: [X of Y sections covered]

## Spec Traceability

[Traceability matrix from Step 1.5]

## Task Breakdown

[Tasks in execution order]

## Parallelization Strategy

[Which tasks can run in parallel worktrees]

## Deferred Items

[Open questions or design sections not addressed, with rationale]

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
```

### Step 5: Plan Verification

Before saving, verify completeness against the design document:

**Coverage Checklist:**
- [ ] Every sub-section of "Technical Design" has ≥1 task
- [ ] All files in "Files Changed" table are touched by tasks
- [ ] Testing strategy items have corresponding test tasks
- [ ] Open questions are resolved OR explicitly deferred with rationale
- [ ] For partial plans: scope declaration is clear and justified

**Delta Analysis:**
Compare design sections against task list. For each gap:
1. Create a task to address it, OR
2. Add to "Deferred Items" with explicit rationale

If significant gaps remain that cannot be justified, **do not proceed** — return to design phase for clarification.

## Test Naming Convention

Follow: `MethodName_Scenario_ExpectedOutcome`

**Examples:**
- `CreateUser_ValidInput_ReturnsUserId`
- `CreateUser_EmptyEmail_ThrowsValidationError`
- `GetUser_NonExistentId_ReturnsNull`

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Write implementation first | Write failing test first |
| Create large tasks | Break into 2-5 min chunks |
| Skip dependency analysis | Identify parallel opportunities |
| Vague test descriptions | Specific: Method_Scenario_Outcome |
| Assume tests pass | Verify each test fails first |
| Add "nice to have" code | Only what the test requires |

## Rationalization Debunking

| Excuse | Reality |
|--------|---------|
| "This is too simple for tests" | Simple code breaks too. Test it. |
| "I'll add tests after" | You won't. Or they'll be weak. |
| "Tests slow me down" | Debugging without tests is slower. |
| "The design is obvious" | Obvious to you now. Not in 3 months. |

## State Management

This skill updates workflow state with plan details.

### On Plan Save

Update state with plan artifact and tasks:

```bash
# Set plan path
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.plan = "docs/plans/YYYY-MM-DD-<feature>.md"'

# Add tasks (repeat for each task)
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.tasks += [{"id": "001", "title": "Task description", "status": "pending", "branch": "feature/001-name"}]'

# Update phase to plan-review (NOT delegate)
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "plan-review"'
```

### Task State Structure

Each task in state should include:
- `id`: Task identifier matching plan (e.g., "001", "A1")
- `title`: Brief description
- `status`: "pending" (initially)
- `branch`: Git branch name for this task

## Completion Criteria

- [ ] Design document read and understood
- [ ] Spec traceability table created
- [ ] Scope declared (full or partial with rationale)
- [ ] Tasks decomposed to 2-5 min granularity
- [ ] Each task starts with failing test
- [ ] Dependencies mapped
- [ ] Parallel groups identified
- [ ] Plan verification passed (Step 5)
- [ ] Plan saved to `docs/plans/`
- [ ] State file updated with plan path and tasks

## Transition

After planning completes, **auto-continue to plan review** (no user confirmation yet):

1. Update state: `.phase = "plan-review"`, populate tasks
2. Output: "Plan saved with [N] tasks. Running plan-design delta review..."
3. Execute plan review inline (see Plan Review section below)

## Plan Review

After the plan is saved, perform a formal delta analysis before requesting user approval.

### Review Process

1. **Re-read the design document** — Fresh pass to catch missed items
2. **Compare against plan** — Section by section
3. **Generate delta report:**

```markdown
## Plan Review: [Feature Name]

### Coverage Summary
- Design sections: [N]
- Sections with tasks: [X]
- Sections deferred: [Y]
- Coverage: [X/N] ([percentage]%)

### Delta Analysis

| Design Section | Coverage | Notes |
|----------------|----------|-------|
| Technical Design > A | ✅ Full | Tasks 001-003 |
| Technical Design > B | ⚠️ Partial | Task 004 covers core, edge cases deferred |
| Integration Points | ✅ Full | Task 005 |
| Testing Strategy | ✅ Full | Tasks 006-008 |
| Open Questions > Q1 | ⏸️ Deferred | Awaiting API spec from team X |

### Gaps Identified
- [Gap 1]: [Description] — [Resolution: added task / deferred / out of scope]
- [Gap 2]: [Description] — [Resolution]

### Recommendation
[APPROVE | REVISE | RETURN TO DESIGN]
- [Rationale for recommendation]
```

4. **Present to user for approval** — This is the HUMAN CHECKPOINT

### After Review

**If approved:**
```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "delegate"'
```
Then invoke:
```typescript
Skill({ skill: "delegate", args: "<plan-path>" })
```

**If revisions needed:**
- Address user feedback
- Re-run plan review
- Present again for approval

**If return to design:**
```bash
~/.claude/scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "ideate"'
```
Notify user that design needs refinement before planning can continue.
