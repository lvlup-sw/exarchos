---
name: workflow-steps
---

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

### Agent Teams Dispatch (alternative)

When using `--mode agent-team`:
1. Orchestrator activates delegate mode (Shift+Tab in Claude Code terminal)
2. Describes each task to teammates via natural language (see parallel-strategy.md for example)
3. Each teammate receives worktree path + implementer prompt content
4. Teammates self-coordinate via shared task list

**No `Task()` calls needed** — delegation happens through natural language.

### Agent Teams Dispatch (enhanced)

When using `--mode agent-team`:
1. **Pre-delegation intelligence:** Query `exarchos_view team_performance` for historical metrics
2. **Team creation:** Create team with named teammates, each assigned to a worktree
3. **Task list setup:** Create native Claude Code tasks with dependency annotations
4. **Natural language delegation:** Describe tasks to teammates with full implementer prompt content
5. **Event emission:** Append `team.spawned` event with teamSize, teammateNames, taskCount

Teammates self-coordinate via shared task list. No `Task()` calls needed.

## Step 5: Monitor Progress

For background tasks:
```typescript
TaskOutput({ task_id: "task-001-id", block: true })
```

### Agent Teams Monitoring (alternative)

When using `--mode agent-team`:
- Teammates visible in tmux split panes
- `TeammateIdle` hook auto-runs quality gates
- Orchestrator observes progress via pane output
- No `TaskOutput` polling needed

### Agent Teams Monitoring (enhanced)

When using `--mode agent-team`:
- Teammates visible in tmux split panes
- `TeammateIdle` hook auto-runs quality gates (typecheck, tests, clean worktree)
- On quality pass: emits `team.task.completed` event with performance data
- On quality fail: exit code 2 sends feedback, emits `team.task.failed` event
- `findUnblockedTasks()` auto-detects follow-up work for the teammate
- Orchestrator monitors via `exarchos_view delegation_timeline` for bottleneck detection

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

### Agent Teams Collection (alternative)

When using `--mode agent-team`:
- `TeammateIdle` hook updates Exarchos workflow state automatically
- On quality gate pass: task marked "complete" in state
- On quality gate fail: exit code 2 sends feedback, teammate continues
- Run `post-delegation-check.sh` as usual after all teammates finish

### Agent Teams Collection (enhanced)

When using `--mode agent-team`:
- `TeammateIdle` hook bridges real-time Agent Teams with persistent Exarchos state
- On quality gate pass: task marked "complete" + `team.task.completed` event emitted
- On quality gate fail: exit code 2 sends feedback + `team.task.failed` event emitted
- Rich event data: taskId, teammateName, durationMs, filesChanged, testsPassed
- After all teammates finish: append `team.disbanded` event with summary metrics
- Run `post-delegation-check.sh` as usual for final validation

## Step 7: Schema Sync (Auto-Detection)

After all tasks complete, check if API files were modified:

```bash
bash scripts/needs-schema-sync.sh --repo-root <path> [--base-branch main]
```

**On exit 0:** No sync needed — proceed to review.
**On exit 1:** Sync needed — API files modified (`*Endpoints.cs`, `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs`). Run `npm run sync:schemas` and commit via Graphite before proceeding. See `@skills/sync-schemas/SKILL.md`.
