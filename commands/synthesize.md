---
description: Merge branches and create pull request
---

# Synthesize

Create final PR for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                                                       ▲▲▲▲▲▲▲▲▲▲
```

This command is the **exit point** of the development workflow. After creating the PR, asks for confirmation before merging.

## Skill Reference

Follow the synthesis skill: `@skills/synthesis/SKILL.md`

## Prerequisites

- [ ] All tasks complete
- [ ] Spec review: PASS for all tasks
- [ ] Quality review: APPROVED for all tasks

## Process

### Step 1: List Worktrees
```bash
git worktree list
```

### Step 2: Create Integration Branch
```bash
git checkout main
git pull origin main
git checkout -b feature/integration-<feature-name>
```

### Step 3: Merge in Dependency Order
For each branch:
```bash
git merge --no-ff feature/task-branch
npm run test:run  # Verify after each merge
```

### Step 4: Run Full Verification
```bash
npm run test:run
npm run typecheck
npm run lint
npm run build
```

### Step 5: Create PR
```bash
git push -u origin feature/integration-<feature-name>

gh pr create \
  --title "Feature: <name>" \
  --body "[Summary, changes, test plan]"
```

### Step 6: Cleanup (After Merge)
```bash
git worktree remove .worktrees/task-name
git branch -d feature/task-branch
git worktree prune
```

## Handling Failures

- **Test failure after merge:** Create fix task, re-synthesize
- **Merge conflict:** Resolve carefully, test after resolution
- **PR checks fail:** Push fixes to integration branch

## Output

When complete:
```markdown
## Synthesis Complete

PR: [URL]

Merged: [list of branches]

Tests: PASS
Build: PASS
```

## Direct Commits

You can make direct edits to the integration branch at any time:
- Edit files in your IDE
- Commit directly to `feature/integration-<feature-name>`
- Push to remote

The workflow will sync before merge confirmation.

## Auto-Chain

After PR created:

1. Summarize: "PR created: [URL]. All checks passing."
2. Ask: "Merge PR? (yes/no/feedback)"
3. **On 'yes'** (yes, y, merge):
   ```bash
   # Sync any direct commits first
   git pull origin feature/integration-<feature-name>
   gh pr merge [PR_NUMBER] --merge
   ```
4. **On 'feedback'** (feedback, comments, fixes, changes, address):
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```
5. **On 'no'**: "No problem. Run `gh pr merge [PR_NUMBER] --merge` when ready, or `/delegate --pr-fixes [PR_URL]` to address feedback."
