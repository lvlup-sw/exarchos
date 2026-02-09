# Polish Track Validate Phase

## Purpose

Verify the refactor succeeded without regressions. This phase confirms all goals from the brief are achieved, tests pass, and no unintended changes were introduced.

## Entry Conditions

- Polish implement phase complete
- Phase is `validate`
- Implementation commits are ready

## Validation Checklist

### 1. Test Suite Verification

Run the full test suite to ensure no regressions:

```bash
npm run test:run
```

**Requirements:**
- [ ] All existing tests pass
- [ ] No new test failures introduced
- [ ] Test count has not decreased (no deleted tests)

If tests fail:
1. Identify which tests fail
2. Determine if failure is due to refactor or pre-existing issue
3. Fix refactor-related failures before proceeding
4. Return to implement phase if significant fixes needed

### 2. Goal Achievement

Review each goal from the brief and verify completion:

```text
# Read goals from state using mcp__exarchos__exarchos_workflow_get
Use mcp__exarchos__exarchos_workflow_get with featureId and query: ".brief.goals"
```

**For each goal:**
- [ ] Goal is fully addressed
- [ ] Evidence of completion is clear (code change, metric improvement, etc.)
- [ ] Goal was not partially implemented

Document verified goals in state using `mcp__exarchos__exarchos_workflow_set`:

```text
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: { "validation.goalsVerified": ["<goal text>"] }
```

Note: For array values, subsequent calls can append additional goals.

### 3. Regression Check

Verify no unintended changes outside refactor scope:

**Review affected areas:**
- [ ] Changes are limited to `affectedAreas` from brief
- [ ] No unexpected files modified
- [ ] No unrelated behavior changes

**Check git diff:**
```bash
git diff --stat HEAD~<n>  # Review files changed
git diff HEAD~<n> -- <unexpected-file>  # Investigate unexpected changes
```

If unintended changes found:
1. Determine if they should be reverted
2. If intentional, update brief's `affectedAreas`
3. If accidental, revert and re-run validation

### 4. Lint and Type Check

Run linting and type checking to ensure code quality:

```bash
npm run lint
npm run typecheck  # For TypeScript projects
```

**Requirements:**
- [ ] No new lint errors introduced
- [ ] No new type errors introduced
- [ ] Any disabled rules are justified

If errors found:
1. Fix lint/type errors
2. Commit fixes separately
3. Re-run validation

### 5. Code Quality Spot Check

Manual review of key changes:

**Structure verification:**
- [ ] New code follows project conventions
- [ ] Naming is consistent and clear
- [ ] No obvious code smells introduced

**Brief alignment:**
- [ ] Implementation matches stated approach
- [ ] Out-of-scope items were not touched
- [ ] Success criteria are met

## State Updates

### Record Validation Start

Use `mcp__exarchos__exarchos_workflow_set` with the featureId:

```text
updates: {
  "validation": {
    "startedAt": "<ISO8601>",
    "testsPass": null,
    "goalsVerified": [],
    "docsUpdated": false
  }
}
```

### Record Validation Results

On successful validation:

```text
# First call: Record results
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "validation.testsPass": true,
    "validation.completedAt": "<ISO8601>"
  }

# Second call: Transition phase
Use mcp__exarchos__exarchos_workflow_set with featureId:
  phase: "update-docs"
```

On failed validation:

```text
Use mcp__exarchos__exarchos_workflow_set with featureId:
  updates: {
    "validation.testsPass": false,
    "validation.failureReason": "<reason>"
  }
  phase: "implement"
```

## Pass/Fail Handling

### Validation Passed

All criteria met:
1. Update state with successful validation results
2. Transition to `update-docs` phase
3. Auto-chain continues workflow

### Validation Failed

If any criteria not met:

| Failure Type | Action |
|--------------|--------|
| Tests fail | Return to implement phase, fix issues |
| Goals not achieved | Return to implement phase, complete goals |
| Unintended changes | Revert changes, return to implement |
| Lint/type errors | Fix errors, re-run validation |
| Quality issues | Return to implement phase, address issues |

**Important:** Do not skip to update-docs with validation failures. All issues must be resolved first.

## Exit Conditions

Transition to `update-docs` phase when ALL conditions are met:

- [ ] All tests pass
- [ ] Each goal from brief is verified as complete
- [ ] No unintended changes outside scope
- [ ] No new lint or type errors
- [ ] Code quality spot check passed
- [ ] State updated with validation results

## Auto-Chain Behavior

On successful validation:
- Next action: `AUTO:refactor-update-docs`
- Automatically proceeds to update documentation

On failed validation:
- Next action: `AUTO:refactor-implement` (return to fix issues)
- Does not proceed until validation passes

## Common Issues

| Issue | Resolution |
|-------|------------|
| Flaky tests | Run tests multiple times, investigate intermittent failures |
| Pre-existing failures | Document in state, don't block on unrelated issues |
| Scope creep discovered | Either revert extra changes or update brief (prefer revert) |
| Missing test coverage | Add tests for changed behavior before proceeding |

## Validation Output

Summarize validation results for the user:

```text
Validation Results:
- Tests: All 47 tests pass
- Goals: 3/3 verified
  - Extract validation logic into separate UserValidator class
  - Reduce UserService to <200 lines
  - Improve test isolation for validation tests
- Regressions: None detected
- Lint/Type: No new errors
- Quality: Spot check passed

Proceeding to update-docs phase...
```
