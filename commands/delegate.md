---
description: Dispatch tasks to Jules or Claude Code subagents
---

# Delegate

Delegate tasks for: "$ARGUMENTS"

## Workflow Position

```
/ideate → [CONFIRM] → /plan → /delegate → /review → /synthesize → [CONFIRM] → merge
                                 ▲▲▲▲▲▲▲▲
                                    │
                      ON FAIL ──────┘ (returns here with --fixes)
```

Auto-invokes `/review` after all tasks complete.

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

## Output

Track the plan path used for delegation as `$PLAN_PATH`.

## Auto-Chain

After all delegated tasks complete:

1. Summarize: "All [N] tasks complete and verified."
2. Invoke immediately:
   ```typescript
   Skill({ skill: "review", args: "$PLAN_PATH" })
   ```
