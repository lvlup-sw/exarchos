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

## Idempotency

Before synthesizing, check synthesis status:
1. Check if `synthesis.prUrl` exists in state
2. If PR exists and is open, skip to merge confirmation
3. If PR merged, update phase to "completed"

## Human Checkpoint

After PR is created, this is a **human checkpoint** - user confirmation required.

### Save State

```bash
scripts/workflow-state.sh set docs/workflow-state/<feature>.state.json \
  '.artifacts.pr = "[PR_URL]" | .synthesis.prUrl = "[PR_URL]"'
```

## Auto-Chain

After PR created:

1. Update state with PR URL
2. Output: "PR created: [URL]. All checks passing."
3. **PAUSE for user input**: "Merge PR? (yes/no/feedback)"

This is one of only TWO human checkpoints in the workflow.

4. **On 'yes'** (yes, y, merge):
   ```bash
   git pull origin feature/integration-<feature-name>
   gh pr merge [PR_NUMBER] --merge
   ```
   Update state: `.phase = "completed"`

5. **On 'feedback'** (feedback, comments, fixes, changes, address):
   Auto-continue to fixes:
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```
   After fixes complete, workflow returns here automatically.

6. **On 'no'**: "Workflow paused. Run `/resume` to continue later."
