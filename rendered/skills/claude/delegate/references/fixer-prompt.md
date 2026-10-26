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

## The Fix Continues the Earlier Branch

A fix continues the branch of the earlier attempt of the task. It does not start a new branch. The static-analysis evidence of a task keys on its branch, and settlement passes the claimed branch to that gate. A failing record on another branch stays active, so `task_complete` refuses a fix on a new branch.

Before the dispatch, the orchestrator puts the fixer on the earlier branch. The recipe depends on the runtime:

- **Without native isolation**, dispatch the fixer to the earlier worktree of the task. The fixer works there, on the earlier branch.
- **With native isolation**, the fixer gets a new worktree of its own, and git refuses to switch it to a branch that the earlier worktree holds. So first commit the listed files of the task in the earlier worktree, and remove each file that a gate run left there. Git refuses to remove a worktree with changes. Then run `git worktree remove <earlier path>`. The fixer then runs `git switch <earlier branch>` in its own worktree.

In both cases the fixer rebases the branch onto `<baseCommit>` when HEAD does not hold it, and it keeps the branch name. Its claim names the worktree of the fixer and the same `branch` as the earlier claim, or no branch when the earlier claim named none.

**A fix on a new branch halts.** After a static-analysis failure, a fix on a new branch halts at the completion leaf, because the failing record of the earlier branch stays active. The recovery: run `check_static_analysis` with `taskId`, the earlier branch as `branch`, `repoRoot: 'auto'` and the `worktreePath` of the new tree. Then settle the claim under a new batch id.

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

## Base Step (MANDATORY)

Continue the earlier branch of the task: `[earlier-branch]`. Do not start a new branch. Before making ANY changes:

1. Without native isolation, this worktree already holds `[earlier-branch]`. With native isolation, run `git switch "[earlier-branch]"` in this worktree.
2. When HEAD does not hold `[baseCommit]`, rebase the branch onto it and keep its name: `git rebase "[baseCommit]"`.
3. Check the base: `git merge-base --is-ancestor "[baseCommit]" HEAD`. If git refuses the switch, or the check fails, STOP and report it.

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

1. **Run the project test command** (resolved from `.exarchos.yml`, or the
   project default). Use whatever your toolchain provides — for example
   `cargo test`, `pytest`, `dotnet test`, or `npm run test:run`. Ensure all
   tests pass.

2. **If this fix requires a new test:**
   - Add a focused test covering the fix (test-after is fine)
   - Verify it can fail for the expected reason
   - Implement fix
   - Verify test passes

3. **Run the project quality checks** (typecheck/lint) using your toolchain's
   commands — e.g. `cargo clippy` / `mypy` / `dotnet build` /
   `npm run typecheck && npm run lint`.

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
- [ ] The earlier branch continued, and HEAD holds the base commit
- [ ] Issue addressed per review feedback
- [ ] New test written if applicable
- [ ] All existing tests pass
- [ ] Type check passes
- [ ] Lint passes
- [ ] No regressions introduced
- [ ] Each untracked file that a gate run left is removed, and none is committed

## Completion

Before you report, remove each untracked file that a gate run of the earlier attempt or of this fix left, and commit none of them. Settlement refuses a worktree whose `git status --porcelain` is not empty (`uncommitted-changes`).

When done, report:
1. Files modified
2. Test results
3. Summary of fix applied
4. The result fields of the task, as one JSON object: `worktreePath` (this worktree), `branch` (`[earlier-branch]`, or no branch when the earlier claim named none), `files`, `implements` and `tests`. The orchestrator builds the settlement claim of the fixed task from them. Do not send a `status` for a fixed task.

If you could not fix the task, report a `status` and a `reason` in place of item 4, and no result field. The status is `failed` (you attempted the fix, and you have no result that settlement can verify) or `blocked` (the fix cannot proceed until something outside the task changes). Write the reason in at most 280 characters.
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

1. Run the project test command (from `.exarchos.yml`, e.g. `cargo test` / `pytest` / `npm run test:run`)
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
6. **The earlier branch** - Continue the branch of the earlier attempt, and leave no untracked file of a gate run
