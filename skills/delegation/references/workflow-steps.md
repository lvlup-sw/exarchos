# Delegation Workflow Steps

## Step 1: Prepare Environment

For parallel tasks, create worktrees:
```bash
git worktree add .worktrees/task-001 feature/task-001
cd .worktrees/task-001 && npm install
```

## Step 2: Extract Task Details

From implementation plan, extract for each task:
- Full task description
- Files to create/modify
- Test file paths
- Expected test names
- Dependencies

## Step 3: Create TodoWrite Entries

Track all delegated tasks:
```typescript
TodoWrite({
  todos: [
    { content: "Task 001: User model", status: "in_progress", activeForm: "Implementing user model" },
    { content: "Task 002: Auth endpoints", status: "pending", activeForm: "Implementing auth endpoints" }
  ]
})
```

## Step 4: Dispatch Implementers

**Parallel dispatch:**
```typescript
// Launch multiple in single message for parallel execution
Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task 001",
  prompt: "[Full implementer prompt]"
})

Task({
  subagent_type: "general-purpose",
  model: "opus",
  run_in_background: true,
  description: "Implement task 002",
  prompt: "[Full implementer prompt]"
})
```

## Step 5: Monitor Progress

For background tasks:
```typescript
TaskOutput({ task_id: "task-001-id", block: true })
```

## Step 6: Collect Results

When tasks complete, run the post-delegation check:

```bash
bash scripts/post-delegation-check.sh \
  --state-file <path-to-state.json> \
  --repo-root <project-root> \
  [--skip-tests]
```

**Validates:**
- State file exists and is valid JSON
- Tasks array has entries
- All tasks report "complete" status
- Per-worktree test runs pass (unless `--skip-tests`)
- State file consistency (all tasks have id and status fields)

**On exit 0:** All delegation results collected and verified. Update TodoWrite status, then check if schema sync is needed (Step 7) and proceed to review phase.

**On exit 1:** Failures detected. Review the per-task status report. Address incomplete tasks or failing tests before proceeding.

## Step 7: Schema Sync (Auto-Detection)

After all tasks complete, check if API files were modified:

```bash
bash scripts/needs-schema-sync.sh --repo-root <path> [--base-branch main]
```

**On exit 0:** No sync needed — proceed to review.
**On exit 1:** Sync needed — API files modified (`*Endpoints.cs`, `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs`). Run `npm run sync:schemas` and commit via Graphite before proceeding. See `@skills/sync-schemas/SKILL.md`.
