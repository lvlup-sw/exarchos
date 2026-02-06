---
description: Merge worktree branches and run combined tests
---

# Integrate

Merge and test branches for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
                                            ▲▲▲▲▲▲▲▲▲▲
                                               │
                         ON FAIL ──────────────┘
```

- **ON PASS**: Auto-invokes `/review`
- **ON FAIL**: Auto-invokes `/delegate --fixes`

## Skill Reference

Follow the integration skill: `@skills/integration/SKILL.md`

## Purpose

Integration phase ensures all worktree branches merge cleanly and pass combined tests before review.

**Benefits:**
- Catches integration issues early (interface mismatches, test conflicts)
- Reviews see complete picture (integrated diff, not fragments)
- Synthesis is simplified (just PR creation)

## Execution Mode

Integration MUST be dispatched to a subagent (not run inline by orchestrator).

### Dispatch Integration Subagent

```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",
  description: "Integrate branches for $FEATURE_NAME",
  prompt: `[Integration prompt with:
    - State file path
    - Branches to merge (in dependency order)
    - Integration branch name]`
})
```

## Process

### Step 1: Create Integration Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/integration-<feature-name>
```

### Step 2: Merge Branches (Dependency Order)

For each branch from state file:

```bash
git merge --no-ff feature/<task-id>-<name> -m "Merge feature/<task-id>-<name>"
npm run test:run  # Stop if tests fail
```

### Step 3: Full Verification

```bash
npm run test:run
npm run typecheck
npm run lint
npm run build
```

### Step 4: Report Results

Generate integration report with:
- Status: PASS or FAIL
- Merged branches list
- Verification results (tests, typecheck, lint, build)
- Failure details if applicable

## State Management

Use `mcp__workflow-state__workflow_set` with the `featureId` to update state.

### On Integration Start

Update state:
- Set `integration.status` to "in_progress"
- Set `integration.branch` to "feature/integration-<name>"

### On Branch Merged

Update state:
- Append to `integration.mergedBranches` array with "feature/<task-id>-<name>"

### On Integration Pass

Update state, then transition phase:
1. Set `integration.status` to "passed"
2. Set `phase` to "review"

### On Integration Fail

Update state:
- Set `integration.status` to "failed"
- Set `integration.failureDetails` to the failure details

## Idempotency

Before integrating, check status:
1. Read `.integration.status` from state
2. If "passed", skip to auto-chain to review
3. If "in_progress", continue from last merged branch
4. If "failed", create fix tasks and delegate

## Auto-Chain

### On PASS:

1. Update state: `.phase = "review"`, `.integration.status = "passed"`
2. Output: "Integration passed. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "$PLAN_PATH" })
   ```

### On FAIL:

1. Update state with failure details
2. Output: "Integration failed: [reason]. Auto-continuing to fix delegation..."
3. Create fix task from failure details
4. Invoke immediately:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes $PLAN_PATH" })
   ```

**No pause for user input** - this is not a human checkpoint.
