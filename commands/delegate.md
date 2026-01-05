---
description: Dispatch tasks to Jules or Claude Code subagents
---

# Delegate

Delegate tasks for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                                 ▲▲▲▲▲▲▲▲                              │
                                    │                                  │
                      ON FAIL ──────┤                                  │
                      --pr-fixes ───┴──────────────────────────────────┘
```

Auto-invokes `/review` after all tasks complete.

## Invocation Modes

| Flag | Source | Use Case |
|------|--------|----------|
| (none) | Implementation plan | Initial task delegation |
| `--fixes` | Review issues | Address spec/quality failures |
| `--pr-fixes` | PR comments | Address human review feedback |

## Skill References

- Delegation skill: `@skills/delegation/SKILL.md`
- Git worktrees: `@skills/git-worktrees/SKILL.md`
- Implementer template: `@skills/delegation/references/implementer-prompt.md`

## Delegation Modes

### Mode 1: Jules (Async PRs)
```typescript
jules_create_task({
  repo: "owner/repo",
  prompt: "[Task + TDD auto-injected]",
  branch: "feature/task-name"
})
```

### Mode 2: Task Tool (Sync)
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for coding
  description: "Task description",
  prompt: "[Full implementer prompt]"
})
```

## Process

### Step 1: Set Up Worktrees
For parallel tasks:
```bash
git worktree add .worktrees/task-001 feature/task-001
cd .worktrees/task-001 && npm install
npm run test:run  # Baseline verification
```

### Step 2: Extract Task Details
From implementation plan, extract:
- Full task description
- Files to create/modify
- Test requirements
- Success criteria

### Step 3: Track Progress
Use TodoWrite to track all delegated tasks.

### Step 4: Dispatch
- Provide FULL task text (never file references)
- Include TDD requirements
- Specify working directory
- Use `model: "opus"` for coding

### Step 5: Monitor
- Jules: `jules_check_status`
- Task tool: `TaskOutput`

## Parallel Execution

Launch parallel tasks in SINGLE message:
```typescript
Task({ model: "opus", description: "Task 001", prompt: "..." })
Task({ model: "opus", description: "Task 002", prompt: "..." })
```

## PR Feedback Mode (--pr-fixes)

When invoked with `--pr-fixes [PR_URL]`:

### Step 1: Fetch PR Comments
```bash
gh pr view [PR_NUMBER] --comments
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

### Step 2: Parse Feedback
Extract actionable items from:
- Review comments on specific lines
- General PR comments
- Requested changes

### Step 3: Create Fix Tasks
For each feedback item:
- Identify file and line (if applicable)
- Create targeted fix task
- Include original comment context

### Step 4: Dispatch and Verify
- Dispatch fixes to subagents
- Push changes to integration branch
- Return to `/synthesize` for merge confirmation

## Output

Track the plan path used for delegation as `$PLAN_PATH`.

## Idempotency

Before delegating, check task status:
1. Read tasks from state file
2. Skip tasks where `status == "complete"`
3. Only dispatch pending/failed tasks
4. If all tasks already complete, skip to auto-chain

## Auto-Chain

After all delegated tasks complete, **auto-continue immediately** (no user confirmation needed):

1. Update state: `.phase = "review"` and mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "$PLAN_PATH" })
   ```

**No pause for user input** - this is not a human checkpoint.

State is saved automatically, enabling recovery after context compaction.
