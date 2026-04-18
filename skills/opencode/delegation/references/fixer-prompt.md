# Fixer Prompt Template

Use this template when dispatching fix tasks via the Task tool after review failures.

## Adversarial Verification Posture

You are a FIX agent. Do NOT trust the implementer's self-assessment of what went wrong.

- **Independently verify the failure** before applying corrections — re-read the failing test output yourself, do not rely on error summaries provided by the original implementer
- **Re-read the failing test output yourself** — compare the actual vs expected values; the implementer may have misdiagnosed the root cause
- **Verify the fix actually resolves the root cause,** not just the symptom — a test that passes for the wrong reason is worse than a failing test
- **Run ALL tests after fixing,** not just the failing one — regressions from targeted fixes are common and must be caught immediately
- **Check for silent failures** — verify that error paths are tested, not just happy paths; the original failure may mask additional issues

This posture exists because subagent self-assessment is an unreliable signal. Implementers are biased toward reporting success and may rationalize partial fixes as complete. Your job is to verify independently.

## Template

```markdown
# Fix Task: [Issue Summary]

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY changes:
1. Run: `pwd`
2. Verify path contains `.worktrees/`
3. If NOT in worktree: STOP and report error

## Working Directory
[Absolute path to worktree]

## Issue to Fix

**Source:** [Spec Review | Quality Review | PR Feedback]
**File:** `[path/to/file.ts]`
**Line:** [line number if applicable]
**Priority:** [HIGH | MEDIUM | LOW]

### Problem
[Clear description of the issue from review]

### Expected Behavior
[What the code should do instead]

### Suggested Fix
[Specific guidance on how to fix, from review report]

## Verification

After implementing the fix:

1. **Run tests:**
   ```bash
   npm run test:run
   ```
   Ensure all tests pass.

2. **If this fix requires a new test:**
   - Write test FIRST (TDD)
   - Verify it fails for the expected reason
   - Implement fix
   - Verify test passes

3. **Run quality checks:**
   ```bash
   npm run typecheck
   npm run lint
   ```

## TDD for New Tests

If adding a test to prevent regression:

```typescript
describe('[ComponentName]', () => {
  it('should [expected behavior] when [condition]', () => {
    // Arrange
    [Setup that reproduces the bug]

    // Act
    [Execute the code path]

    // Assert
    expect(result).[matcher](expected);
  });
});
```

## Success Criteria

- [ ] Worktree verified before changes
- [ ] Issue addressed per review feedback
- [ ] New test written if applicable
- [ ] All existing tests pass
- [ ] Type check passes
- [ ] Lint passes
- [ ] No regressions introduced

## Completion

When done, report:
1. Files modified
2. Test results
3. Summary of fix applied
```

## Usage Example

```typescript
Task({
  subagent_type: "general-purpose",
  description: "Fix: SQL injection vulnerability",
  prompt: `
# Fix Task: SQL Injection in User Query

## CRITICAL: Worktree Verification (MANDATORY)

Before making ANY changes:
1. Run: \`pwd\`
2. Verify path contains \`.worktrees/\`
3. If NOT in worktree: STOP and report error

## Working Directory
/home/user/project/.worktrees/task-003

## Issue to Fix

**Source:** Quality Review
**File:** \`src/api/users.ts\`
**Line:** 42
**Priority:** HIGH

### Problem
Raw string interpolation in SQL query allows injection attacks.

### Expected Behavior
Use parameterized queries to prevent SQL injection.

### Suggested Fix
Replace:
\`\`\`typescript
db.query(\`SELECT * FROM users WHERE id = \${userId}\`)
\`\`\`
With:
\`\`\`typescript
db.query('SELECT * FROM users WHERE id = $1', [userId])
\`\`\`

## Verification

After implementing the fix:

1. Run tests: \`npm run test:run\`
2. Add test for SQL injection prevention
3. Run quality checks

## Success Criteria

- [ ] Worktree verified
- [ ] Parameterized query implemented
- [ ] Injection test added
- [ ] All tests pass
`
})
```

## Key Principles

1. **Always verify worktree** - First action is pwd check
2. **Clear issue description** - Include file, line, problem
3. **Specific fix guidance** - Show before/after when possible
4. **Verification steps** - Always run tests after fix
5. **TDD for regressions** - Add test to prevent recurrence
