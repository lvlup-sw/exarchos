---
description: Create pull request from integration branch
---

# Synthesize

Create final PR for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /integrate → /review → /synthesize → [CONFIRM] → merge
                                                                    ▲▲▲▲▲▲▲▲▲▲
```

This command is the **exit point** of the development workflow. After creating the PR, asks for confirmation before merging.

## Skill Reference

Follow the synthesis skill: `@skills/synthesis/SKILL.md`

## Prerequisites

- [ ] Integration phase complete (branches already merged and tested)
- [ ] Integration branch exists: `feature/integration-<feature-name>`
- [ ] Spec review: PASS
- [ ] Quality review: APPROVED

## Simplified Process

Since `/integrate` handles branch merging and test verification, synthesis focuses on PR creation.

### Step 1: Verify Integration Branch
```bash
git checkout feature/integration-<feature-name>
git log --oneline -5  # Confirm merged branches
```

### Step 2: Create PR

Follow `@rules/pr-descriptions.md` for concise format.

```bash
git push -u origin feature/integration-<feature-name>
```

```typescript
mcp__plugin_github_github__create_pull_request({
  owner: "<owner>",
  repo: "<repo>",
  title: "<type>: <what>",
  body: "## Summary\n<1-2 sentences: what changed and why>\n\nTests: X pass | Build: 0 errors\n\nDesign: docs/path.md",
  head: "feature/integration-<feature-name>",
  base: "main"
})
```

### Step 3: Cleanup (After Merge)
```bash
git worktree remove .worktrees/task-name
git branch -d feature/task-branch
git worktree prune
```

## Handling Failures

- **PR checks fail:** Push fixes to integration branch
- **Review feedback:** Use `/delegate --pr-fixes` to address comments

## Output

When complete:
```markdown
## Synthesis Complete

PR: [URL]
Tests: X pass | Build: 0 errors
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

Update state using `mcp__exarchos__exarchos_workflow_set` with the `featureId`:
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
   git pull origin feature/integration-<feature-name>
   ```
   ```typescript
   mcp__plugin_github_github__merge_pull_request({
     owner: "<owner>",
     repo: "<repo>",
     pullNumber: <PR_NUMBER>,
     merge_method: "merge"
   })
   ```
   Update state: `.phase = "completed"`

5. **On 'feedback'** (feedback, comments, fixes, changes, address):
   Auto-continue to fixes:
   ```typescript
   Skill({ skill: "delegate", args: "--pr-fixes [PR_URL]" })
   ```
   After fixes complete, workflow returns here automatically.

6. **On 'no'**: "Workflow paused. Run `/resume` to continue later."
