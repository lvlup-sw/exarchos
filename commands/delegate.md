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

Auto-invokes `/review` after tasks complete (or `/synthesize` for `--pr-fixes` mode).

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
# Extract owner, repo, PR number from URL
gh pr view [PR_NUMBER] --repo [OWNER/REPO] --comments --json comments,reviews,body
gh api repos/{owner}/{repo}/pulls/{number}/comments
```

### Step 2: Parse Feedback into Fix Tasks

For each actionable comment, create a structured fix task:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (e.g., `fix-001`) |
| `source` | Comment ID or review ID |
| `file` | File path mentioned (if any) |
| `line` | Line number mentioned (if any) |
| `issue` | What's wrong (from reviewer) |
| `action` | What needs to change |

Skip comments that are:
- Purely praise/acknowledgment
- Questions without action items
- Already resolved

### Step 3: Track Fix Tasks

```typescript
TodoWrite({
  todos: [
    { content: "Fix 001: [issue summary]", status: "pending", activeForm: "Fixing [issue]" },
    // ... one entry per fix task
  ]
})
```

### Step 4: Dispatch Fixes (MANDATORY)

**You MUST spawn subagents for each fix task.** This step is not optional.

**Option A: Task Tool (for local repo access)**
```typescript
Task({
  subagent_type: "general-purpose",
  model: "opus",  // REQUIRED for code changes
  description: "Fix: [issue summary]",
  prompt: `
# Task: Fix PR Feedback - [issue summary]

## Context
PR: [PR_URL]
Reviewer comment: "[original comment text]"

## Working Directory
[absolute path to repo]

## Fix Required
File: [file path]
Line: [line number if applicable]
Issue: [what's wrong]
Action: [what to change]

## TDD Requirements
1. Write a test that would catch this issue (if applicable)
2. Verify test fails
3. Implement the fix
4. Verify test passes

## Success Criteria
- [ ] Issue addressed per reviewer feedback
- [ ] Tests pass
- [ ] No regressions introduced
`
})
```

**Option B: Jules (for async execution)**
```typescript
jules_create_task({
  repo: "[owner/repo]",
  branch: "[PR branch name]",
  prompt: "[Same structured prompt as above]"
})
```

**For parallel fixes:** Launch multiple Task tools in a single message:
```typescript
// CORRECT: Single message with multiple tasks
Task({ model: "opus", description: "Fix 001: ...", prompt: "..." })
Task({ model: "opus", description: "Fix 002: ...", prompt: "..." })
```

**CHECKPOINT:** Do NOT proceed to Step 5 until you have confirmed that Task or jules_create_task tools have been invoked for EVERY fix task identified in Step 2.

### Step 5: Monitor Completion

For Task tool:
```typescript
TaskOutput({ task_id: "[task-id]", block: true })
```

For Jules:
```typescript
jules_check_status({ sessionId: "[session-id]" })
```

Update TodoWrite as each fix completes.

### Step 6: Push and Report

After all fixes complete:
```bash
git add -A && git commit -m "fix: address PR review feedback"
git push origin [branch]
```

Report to user:
- Number of fixes applied
- Files modified
- Suggestion to request re-review

Then auto-chain back to `/synthesize` for merge confirmation.

## Output

Track the plan path used for delegation as `$PLAN_PATH`.

## Idempotency

Before delegating, check task status:
1. Read tasks from state file
2. Skip tasks where `status == "complete"`
3. Only dispatch pending/failed tasks
4. If all tasks already complete, skip to auto-chain

## Auto-Chain

After all delegated tasks complete, **auto-continue immediately** (no user confirmation needed).

### For normal delegation and --fixes mode:

1. Update state: `.phase = "review"` and mark all tasks complete
2. Output: "All [N] tasks complete. Auto-continuing to review..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "$PLAN_PATH" })
   ```

### For --pr-fixes mode:

Human review already happened - skip automated review and return to merge confirmation.

1. Update state: `.phase = "synthesize"` and mark all fixes complete
2. Output: "All [N] fixes applied and pushed. Returning to merge confirmation..."
3. Invoke immediately:
   ```typescript
   Skill({ skill: "synthesize", args: "$PR_URL" })
   ```

**No pause for user input** - this is not a human checkpoint.

State is saved automatically, enabling recovery after context compaction.
