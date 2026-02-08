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
- Auto-chained from plan-review with `--revise` flag (gaps found)

## Revision Mode (--revise flag)

When invoked with `--revise`, plan-review found gaps in the previous plan. The state file contains `.planReview.gaps` with specific missing items.

**Revision workflow:**
1. Read gaps from state using `mcp__exarchos__exarchos_workflow_get` with query `planReview.gaps`
2. Re-read design document
3. Add tasks to address each gap
4. Update existing plan file (append new tasks)
5. Clear gaps using `mcp__exarchos__exarchos_workflow_set` (set `planReview.gaps` to empty array, `planReview.gapsFound` to false)

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

Update state with plan artifact and tasks using `mcp__exarchos__exarchos_workflow_set`:
- Set `artifacts.plan` to the plan path
- Set `tasks` to the array of task objects (id, title, status, branch)
- Set `phase` to "plan-review"

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

After planning completes, **auto-continue to plan-review** (delta analysis):

1. Update state: `.phase = "plan-review"`, populate tasks
2. Output: "Plan saved with [N] tasks. Running plan-design coverage analysis..."
3. Run plan-review delta analysis:
   - Re-read design document
   - Compare each section against planned tasks
   - If gaps found: set `.planReview.gaps`, auto-loop back to `/plan --revise`
   - If no gaps: present to user for approval (human checkpoint)
   - On approval: set `.planReview.approved = true`, invoke `/delegate`

```typescript
// After plan-review passes and user approves:
Skill({ skill: "delegate", args: "<plan-path>" })
```
