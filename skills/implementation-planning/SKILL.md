# Implementation Planning Skill

## Overview

Transform design documents into TDD-based implementation plans with granular, parallelizable tasks.

## Triggers

Activate this skill when:
- User runs `/plan` command
- User wants to break down a design into tasks
- A design document exists and needs implementation steps
- User says "plan the implementation" or similar

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

Read the design and identify:
- Core behaviors to implement
- Data structures needed
- API endpoints or interfaces
- Integration points
- Edge cases and error handling

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

## Summary
- Total tasks: [N]
- Parallel groups: [N]
- Estimated test count: [N]

## Task Breakdown

[Tasks in execution order]

## Parallelization Strategy

[Which tasks can run in parallel worktrees]

## Completion Checklist
- [ ] All tests written before implementation
- [ ] All tests pass
- [ ] Code coverage meets standards
- [ ] Ready for review
```

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
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.plan = "docs/plans/YYYY-MM-DD-<feature>.md"'

# Add tasks (repeat for each task)
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.tasks += [{"id": "001", "title": "Task description", "status": "pending", "branch": "feature/001-name"}]'

# Update phase
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "delegate"'
```

### Task State Structure

Each task in state should include:
- `id`: Task identifier matching plan (e.g., "001", "A1")
- `title`: Brief description
- `status`: "pending" (initially)
- `branch`: Git branch name for this task

## Completion Criteria

- [ ] Design document read and understood
- [ ] Tasks decomposed to 2-5 min granularity
- [ ] Each task starts with failing test
- [ ] Dependencies mapped
- [ ] Parallel groups identified
- [ ] Plan saved to `docs/plans/`
- [ ] State file updated with plan path and tasks

## Transition

After planning completes, follow the Auto-Chain section in `commands/plan.md`:

1. Summarize the saved plan document path and task count
2. Invoke immediately:
   ```typescript
   Skill({ skill: "delegate", args: "<plan-path>" })
   ```

This leads to the **delegation** skill for Jules/subagent dispatch.
