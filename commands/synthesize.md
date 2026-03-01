---
description: Create pull request from feature branch
---

# Synthesize

Create final PR for: "$ARGUMENTS"

## Workflow Position

```
/exarchos:ideate → [CONFIRM] → /exarchos:plan → /exarchos:delegate → /exarchos:review → /exarchos:synthesize → [CONFIRM] → merge
                                                                                          ▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲
```

This command is the **exit point** of the development workflow. After creating the PR, asks for confirmation before merging.

## Skill Reference

Follow the synthesis skill: `@skills/synthesis/SKILL.md`

## Prerequisites

- [ ] Review phase complete (all checks passed)
- [ ] Spec review: PASS
- [ ] Quality review: APPROVED

## Process

### Step 1: Verify Branch State
```bash
git log --oneline -5  # Confirm all task commits present
```

### Step 2: Submit Stacked PRs

Follow `@rules/pr-descriptions.md` for concise format.

Create PRs for each branch in the stack (bottom-up) and enable auto-merge:
```bash
# For each branch in the stack (bottom-up):
gh pr create --base <parent-branch> --head <branch> --title "<type>: <what>" --body "<pr-body>"
gh pr merge <number> --auto --squash
```

### Step 3: Cleanup (After Merge)
```bash
git worktree remove .worktrees/task-name
git branch -d feature/task-branch
git worktree prune
```

## Handling Failures

- **PR checks fail:** Push fixes to feature branch
- **Review feedback:** Use `/exarchos:delegate --pr-fixes` to address comments

## Output

When complete:
```markdown
## Synthesis Complete

PR: [URL]
Tests: X pass | Build: 0 errors
```

## Direct Edits

You can make direct edits to stack branches at any time:
- Edit files in your IDE
- Stage and amend: `git add <files> && git commit --amend -m "fix: <description>"`
- Push the changes: `git push --force-with-lease`

## Idempotency

Before synthesizing, check synthesis status:
1. Check if `synthesis.prUrl` exists in state
2. If PR exists and is open, skip to merge confirmation
3. If PR merged, update phase to "completed"

## Human Checkpoint

After PR is created, this is a **human checkpoint** - user confirmation required.

### Save State

Update state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "set"` and the `featureId`:
- Set `artifacts.pr` to the PR URL
- Set `synthesis.prUrl` to the PR URL

## Auto-Chain

After PR created:

1. Update state with PR URL
2. Output: "PR created: [URL]. All checks passing."
3. **PAUSE for user input**: "Merge PR? (yes/no/feedback)"

This is one of only TWO human checkpoints in the workflow.

4. **On 'yes'** (yes, y, merge):
   ```bash
   gh pr merge <PR_NUMBER> --squash --auto
   ```
   > Or use GitHub MCP `merge_pull_request` if available.

   Update state: `.phase = "completed"`

5. **On 'feedback'** (feedback, comments, fixes, changes, address):
   Auto-continue to fixes:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "--pr-fixes [PR_URL]" })
   ```
   After fixes complete, workflow returns here automatically.

6. **On 'no'**: "Workflow paused. Run `/exarchos:resume` to continue later."
