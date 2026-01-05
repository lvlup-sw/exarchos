---
description: Create TDD implementation plan from design document
---

# Plan

Create implementation plan for: "$ARGUMENTS"

## Skill Reference

Follow the implementation-planning skill: `@skills/implementation-planning/SKILL.md`

## Iron Law

> **NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST**

## Process

### Step 1: Analyze Design
Read the design document and identify:
- Core behaviors to implement
- Data structures needed
- API endpoints/interfaces
- Integration points
- Edge cases

### Step 2: Decompose into Tasks
Create tasks with:
- 2-5 minute granularity
- [RED], [GREEN], [REFACTOR] phases
- Test file paths
- Expected test names (Method_Scenario_Outcome)
- Dependencies

### Step 3: Identify Parallelization
Group tasks into:
- Sequential chains (dependencies)
- Parallel-safe groups (can run in worktrees)

### Step 4: Save Plan
Write to `docs/plans/YYYY-MM-DD-<feature>.md`

## Task Format

```markdown
### Task [N]: [Description]
**Phase:** RED → GREEN → REFACTOR

1. [RED] Write test: `TestName_Scenario_Outcome`
   - File: `path/to/test.ts`
   - Expected failure: [reason]

2. [GREEN] Implement minimum code
   - File: `path/to/impl.ts`

3. [REFACTOR] Clean up if needed

**Dependencies:** [Task IDs or None]
**Parallelizable:** [Yes/No]
```

## Output

Save plan to `docs/plans/YYYY-MM-DD-<feature>.md` and capture the path as `$PLAN_PATH`.

## Auto-Chain

After saving the implementation plan:

1. Summarize: "Plan saved to `$PLAN_PATH` with [N] tasks in [M] parallel groups."
2. Ask: "Continue to task delegation with `/delegate`? (yes/no)"
3. On user confirmation (yes, y, continue, proceed):
   ```typescript
   Skill({ skill: "delegate", args: "$PLAN_PATH" })
   ```
4. On decline: "No problem. Run `/delegate $PLAN_PATH` when ready."
