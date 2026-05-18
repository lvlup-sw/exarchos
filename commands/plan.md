---
description: Create TDD implementation plan from design document
---

# Plan

Create implementation plan for: "$ARGUMENTS"

## Workflow Position

```text
/exarchos:ideate → /exarchos:plan → [CONFIRM] → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
                       ▲▲▲▲▲▲▲▲▲▲▲▲▲▲       ↑
                  plan-review
```

After plan is saved, runs plan-review (delta analysis). User confirms at plan-review checkpoint before delegation.

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

After saving plan, persist the artifact + tasks and transition the phase via two separate calls — the runtime rejects `updates.phase` (`update` is non-phase mutation only; phase changes go through the HSM-guarded `transition` action):

1. Update artifacts + tasks using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `updates.artifacts.plan` to the plan path
   - Set `updates.tasks` to an array of task objects (id, title, status, branch)
2. Transition phase using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`:
   - Set `target: "plan-review"`

## Output

Save plan to `docs/plans/YYYY-MM-DD-<feature>.md` and capture the path as `$PLAN_PATH`.

## Idempotency

Before planning, check if plan already exists:
1. Read state file for `.artifacts.plan`
2. If plan file exists and is valid, skip planning
3. Auto-chain directly to plan-review

## Auto-Chain

After saving the implementation plan, **auto-continue to plan-review**:

1. Transition phase via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`, `target: "plan-review"`
2. Output: "Plan saved to `$PLAN_PATH` with [N] tasks. Running plan-design coverage analysis..."
3. Run plan-review (delta analysis):
   - Re-read design document
   - Compare each design section against planned tasks
   - Generate coverage report with any gaps identified
   - Present to user with recommendation

## Plan Review: Auto-Loop on Gaps

Plan-review performs delta analysis and **auto-loops** back to `/exarchos:plan` if gaps are found (similar to `/exarchos:review` → `/exarchos:delegate --fixes`):

```text
/exarchos:plan → plan-review → [gaps?] → /exarchos:plan --revise (auto-loop)
                      ↓
                 [no gaps]
                      ↓
            [HUMAN: approve?] ← checkpoint
                      ↓
                 /exarchos:delegate
```

### On Gaps Found (Auto-Loop)

If plan-review finds missing coverage:

1. Update state with gaps using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
   - Set `planReview.gapsFound` to true
   - Set `planReview.gaps` to an array of gap descriptions

2. Auto-invoke:
   ```typescript
   Skill({ skill: "exarchos:plan", args: "--revise $DESIGN_PATH" })
   ```

The `--revise` flag provides gap context for targeted plan updates.

### On No Gaps (Human Checkpoint)

If plan-review finds complete coverage:

1. Display coverage report showing:
   - Design sections covered by tasks
   - Confirmation that all requirements are planned

2. **PAUSE for user input**: "Plan covers all design requirements. Approve and continue to delegation? (yes/no)"

3. **On approval**, persist the approval flag and transition phase via two separate calls (the runtime rejects `updates.phase`):
   - First, `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"`:
     - Set `updates.planReview.approved` to true
   - Then, `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`:
     - Set `target: "delegate"`

   Then invoke:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "$PLAN_PATH" })
   ```

From here, workflow runs autonomously until PR merge confirmation.
