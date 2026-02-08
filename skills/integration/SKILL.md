# Integration Skill

## Overview

Integration phase: Merge worktree branches in dependency order, run combined tests, and verify before review.

**Position in workflow:**
```
/delegate → /integrate → /review → /synthesize
```

**Prerequisites:**
- All delegate tasks complete
- Each task branch has passing tests in its worktree

## Triggers

Activate this skill when:
- All `/delegate` tasks complete
- Ready to merge and verify combined code
- User runs `/integrate` command

## Execution Context

This skill runs via a SUBAGENT dispatched by the orchestrator.

The orchestrator provides:
- State file path
- List of branches to merge (in dependency order)
- Integration branch name

The integrator subagent:
- Creates integration branch from main
- Merges branches in order
- Runs full verification suite
- Reports pass/fail with details

## Integration Process

### Step 1: Prepare Integration Branch

```bash
# Ensure main is current
git checkout main
git pull origin main

# Create integration branch
git checkout -b feature/integration-<feature-name>
```

### Step 2: Merge Branches (Dependency Order)

For each branch from state file `.synthesis.mergeOrder`:

```bash
# Merge with no fast-forward to preserve history
git merge --no-ff feature/<task-id>-<name> -m "Merge feature/<task-id>-<name>"

# Run tests after each merge to catch issues early
npm run test:run

# If tests fail, stop and report which merge broke
```

### Step 3: Full Verification

After all branches merged:

```bash
# Run complete test suite
npm run test:run

# Type checking
npm run typecheck

# Linting
npm run lint

# Build verification
npm run build
```

### Step 4: Report Results

Generate integration report:

```markdown
## Integration Report

### Status: [PASS | FAIL]

### Integration Branch
feature/integration-<feature-name>

### Merged Branches (in order)
- [x] feature/001-types
- [x] feature/002-api
- [ ] feature/003-tests (FAILED)

### Verification Results
- Tests: [PASS | FAIL]
- Typecheck: [PASS | FAIL]
- Lint: [PASS | FAIL]
- Build: [PASS | FAIL]

### Failure Details (if any)
[Which merge caused failure]
[Which tests failed with error output]
[Files involved]

### Suggested Fix (if failed)
[Specific guidance for fixing the issue]
```

## Failure Handling

### Merge Conflict

1. Report conflicting files
2. Suggest which task needs to resolve
3. Return to delegate phase with fix task

### Test Failure After Merge

1. Identify which merge introduced failure
2. Report failing tests with error output
3. Create fix task for responsible branch
4. Return to delegate phase

### Typecheck/Lint/Build Failure

1. Report specific errors
2. Create fix task
3. Return to delegate phase

## State Management

Use `mcp__exarchos__exarchos_workflow_set` for all state updates.

### On Integration Start

Set `integration.status` to "in_progress" and `integration.branch` to the integration branch name.

### On Branch Merged

Append the merged branch to `integration.mergedBranches` array.

### On Integration Pass

Set `integration.status` to "passed", `integration.passed` to true, and `integration.testResults` with pass/fail for each verification step.

### On Integration Fail

Set `integration.status` to "failed", `integration.passed` to false, and `integration.failureDetails` with error details.

## Completion Criteria

- [ ] Integration branch created from main
- [ ] All branches merged in dependency order
- [ ] Tests pass after each merge
- [ ] Full verification suite passes
- [ ] State file updated with results
- [ ] Integration report generated

## Transition

### If PASS:
1. Update state: `.phase = "review"`, `.integration.status = "passed"`
2. Output: "Integration passed. Auto-continuing to review..."
3. Auto-invoke review:
   ```typescript
   Skill({ skill: "review", args: "<plan-path>" })
   ```

### If FAIL:
1. Update state with failure details
2. Output: "Integration failed: [reason]. Auto-continuing to fix delegation..."
3. Create fix task from failure details
4. Auto-invoke delegation with fixes:
   ```typescript
   Skill({ skill: "delegate", args: "--fixes <plan-path>" })
   ```

This is NOT a human checkpoint - workflow continues autonomously.
