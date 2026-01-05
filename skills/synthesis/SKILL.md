# Synthesis Skill

## Overview

Final integration phase: Merge worktree branches, verify combined tests, and create pull request.

**Prerequisites:**
- All tasks complete
- Spec review passed for all tasks
- Quality review approved for all tasks

## Triggers

Activate this skill when:
- User runs `/synthesize` command
- All reviews are approved
- Ready to create final PR
- Worktrees need consolidation

## Synthesis Process

### Step 1: Verify Readiness

**Pre-flight checklist:**
```markdown
## Synthesis Readiness

- [ ] All tasks marked complete in TodoWrite
- [ ] Spec review: PASS for all tasks
- [ ] Quality review: APPROVED for all tasks
- [ ] No outstanding fix requests
```

If any check fails, return to appropriate phase.

### Step 2: List Active Worktrees

```bash
git worktree list
```

Identify branches to merge:
```markdown
## Branches to Merge

| Worktree | Branch | Status |
|----------|--------|--------|
| .worktrees/001-types | feature/001-types | Ready |
| .worktrees/002-api | feature/002-api | Ready |
| .worktrees/003-tests | feature/003-tests | Ready |
```

### Step 3: Determine Merge Order

Merge in dependency order (from implementation plan):

```markdown
## Merge Order

1. feature/001-types (no dependencies)
2. feature/002-api (depends on 001)
3. feature/003-tests (depends on 001, 002)
```

### Step 4: Create Integration Branch

```bash
# Ensure main is up to date
git checkout main
git pull origin main

# Create integration branch
git checkout -b feature/integration-<feature-name>
```

### Step 5: Merge Branches

For each branch in dependency order:

```bash
# Merge branch
git merge --no-ff feature/001-types -m "Merge feature/001-types: Add type definitions"

# Verify tests pass after each merge
npm run test:run

# If tests fail, resolve conflicts before continuing
```

**Conflict Resolution:**
1. Identify conflicting files
2. Resolve conflicts preserving both changes where possible
3. Run tests after resolution
4. Commit resolution

### Step 6: Run Full Test Suite

```bash
# Run all tests
npm run test:run

# Run type checking
npm run typecheck

# Run linting
npm run lint

# Run build
npm run build
```

All must pass before creating PR.

### Step 7: Create Pull Request

```bash
# Push integration branch
git push -u origin feature/integration-<feature-name>

# Create PR using gh CLI
gh pr create \
  --title "Feature: <Feature Name>" \
  --body "$(cat <<'EOF'
## Summary
[1-3 bullet points describing the feature]

## Changes
- Task 001: [Description]
- Task 002: [Description]
- Task 003: [Description]

## Test Plan
- [ ] All unit tests pass
- [ ] Integration tests pass
- [ ] Manual verification of [specific behaviors]

## Design Reference
- Design: `docs/designs/YYYY-MM-DD-<feature>.md`
- Plan: `docs/plans/YYYY-MM-DD-<feature>.md`

---
Generated with Claude Code Orchestration Workflow
EOF
)"
```

### Step 8: Cleanup Worktrees

After PR is created (or after merge):

```bash
# Remove each worktree
git worktree remove .worktrees/001-types
git worktree remove .worktrees/002-api
git worktree remove .worktrees/003-tests

# Delete feature branches (after PR merge)
git branch -d feature/001-types
git branch -d feature/002-api
git branch -d feature/003-tests

# Prune stale refs
git worktree prune
```

## Merge Strategies

### Simple Merge (Recommended)

For most cases:
```bash
git merge --no-ff feature/branch-name
```

### Rebase for Linear History

If project prefers linear history:
```bash
git rebase main feature/branch-name
git checkout main
git merge --ff-only feature/branch-name
```

### Squash for Clean History

If many small commits:
```bash
git merge --squash feature/branch-name
git commit -m "Feature: Description"
```

## Handling Failures

### Test Failure After Merge

1. Identify which merge introduced failure
2. Create fix task
3. Dispatch to implementer
4. Re-run synthesis after fix

### Merge Conflict

1. Identify conflicting changes
2. Resolve preserving both intents
3. Run tests after resolution
4. Continue merge sequence

### PR Checks Fail

1. Wait for CI feedback
2. Create fix task for failures
3. Push fixes to integration branch
4. Re-run synthesis verification

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Merge without test verification | Run tests after each merge |
| Force push integration branch | Use normal push |
| Delete worktrees before PR approval | Wait for merge confirmation |
| Skip conflict resolution | Carefully resolve each conflict |
| Create PR with failing tests | Ensure all tests pass first |

## Completion Criteria

- [ ] All branches merged to integration branch
- [ ] All tests pass on integration branch
- [ ] Build succeeds
- [ ] PR created with proper description
- [ ] PR link provided to user

## Final Report

```markdown
## Synthesis Complete

### Pull Request
[PR URL]

### Merged Branches
- feature/001-types
- feature/002-api
- feature/003-tests

### Test Results
- Unit tests: PASS
- Type check: PASS
- Lint: PASS
- Build: PASS

### Next Steps
1. Wait for CI/CD checks
2. Request code review (if required)
3. Merge when approved
4. Worktrees will be cleaned up after merge

### Documentation
- Design: docs/designs/YYYY-MM-DD-feature.md
- Plan: docs/plans/YYYY-MM-DD-feature.md
```

## Direct Commits

Users can make direct edits to the integration branch:
- Edit files in their IDE
- Commit directly to `feature/integration-<feature-name>`
- Push to remote

**Before merge confirmation**, always sync:
```bash
git pull origin feature/integration-<feature-name>
```

## Handling PR Feedback

If the user receives PR review comments:

1. Offer to address feedback:
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```

2. Delegate reads PR comments via:
   ```bash
   gh pr view [PR_NUMBER] --comments
   gh api repos/{owner}/{repo}/pulls/{number}/comments
   ```

3. Creates fix tasks from review comments
4. After fixes, push to integration branch
5. Return to merge confirmation

## Transition

After PR created:
> "PR created: [URL]. Waiting for review/CI."

Options:
- **Merge**: Sync and merge PR
- **Feedback**: Loop to `/delegate --pr-fixes` to address comments
- **Decline**: Manual handling

This completes the orchestration workflow cycle (or loops back for fixes).
