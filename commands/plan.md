---
description: Create TDD implementation plan from design document
---

# Plan

Create implementation plan for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                        ▲▲▲
```

Auto-invokes `/delegate` after plan is saved.

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

## State Management

After saving plan, update state with tasks:

```bash
# Set plan path
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.plan = "<plan-path>"'

# Populate tasks from plan
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.tasks = [{"id": "001", "title": "...", "status": "pending", "branch": "feature/001-..."}]'

# Update phase
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.phase = "delegate"'
```

## Output

Save plan to `docs/plans/YYYY-MM-DD-<feature>.md` and capture the path as `$PLAN_PATH`.

## Idempotency

Before planning, check if plan already exists:
1. Read state file for `.artifacts.plan`
2. If plan file exists and is valid, skip planning
3. Auto-chain directly to delegate

## Auto-Chain

After saving the implementation plan, **auto-continue immediately** (no user confirmation needed):

1. Update state: `.phase = "delegate"`
2. Output: "Plan saved to `$PLAN_PATH` with [N] tasks. Auto-continuing to delegation..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "delegate", args: "$PLAN_PATH" })
   ```

**No pause for user input** - this is not a human checkpoint.
