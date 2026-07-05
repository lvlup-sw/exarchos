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

Follow the synthesis skill: `@skills/synthesize/SKILL.md`

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

Follow `@skills/synthesize/references/pr-descriptions.md` for concise format.

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
- Push the changes: `git push --force-with-lease=<ref>:<expected-sha>` — always the **explicit-SHA** form, never a bare `--force-with-lease` (a bare lease anchors to the stale local remote-tracking ref and can clobber a concurrent push). `<expected-sha>` is the remote SHA last observed by the loop via `assess_stack`, or read fresh with `git ls-remote --heads origin <ref>`.

## Idempotency

`create_pr` is the **single authority** for "PR already exists" — do NOT pre-check `synthesis.prUrl`/`artifacts.pr` before deciding whether to create. Just call `create_pr`: it either returns the existing open PR for this (head, base) via its remote-recovery guard, or refuses with `PR_ALREADY_OWNED` when the workflow already owns a PR. Branch on that structured response instead of pre-checking.

The post-merge cleanup case is distinct from create-time idempotency and is NOT governed by `create_pr`:

- If the PR is already **merged**, transition phase to "completed" via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`, `target: "completed"` (the runtime rejects `updates.phase`; the canonical `transition` action runs the HSM guard and emits `workflow.transition`). Note: the post-merge `completed` transition is normally owned by `/exarchos:cleanup` via `action: "cleanup"`; this branch is a manual-cleanup escape hatch.

## Human Checkpoint

After PR is created, this is a **human checkpoint** - user confirmation required.

### Save State

Update state using `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "update"` and the `featureId`:
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

   Transition phase to "completed" via `mcp__plugin_exarchos_exarchos__exarchos_workflow` with `action: "transition"`, `target: "completed"`. (The runtime rejects `updates.phase`; the canonical `transition` action runs the HSM guard and emits `workflow.transition`. The post-merge `completed` transition is also owned by `/exarchos:cleanup` via `action: "cleanup"` — call `cleanup` if you also need worktree/branch pruning; this step is the bare phase-only transition for the explicit-merge path.)

5. **On 'feedback'** (feedback, comments, fixes, changes, address):
   Auto-continue to fixes:
   ```typescript
   Skill({ skill: "exarchos:delegate", args: "--pr-fixes [PR_URL]" })
   ```
   After fixes complete, workflow returns here automatically.

6. **On 'no'**: "Workflow paused. Run `/exarchos:rehydrate` to continue later."
