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
  run_in_background: true,
  description: "Implement task 001",
  prompt: "[Full implementer prompt]"
})

Task({
  subagent_type: "general-purpose",
  run_in_background: true,
  description: "Implement task 002",
  prompt: "[Full implementer prompt]"
})
```

<!-- requires:team:agent-teams -->
### Agent Teams Dispatch (enhanced)

When using `--mode agent-team`:
1. **Pre-delegation intelligence:** Query `exarchos_view team_performance` for historical metrics
2. **Team creation:** Create team with named teammates, each assigned to a worktree
3. **Task list setup:** Create native Claude Code tasks with dependency annotations
4. **Natural language delegation:** Describe tasks to teammates with full implementer prompt content (MUST include Commit Strategy section with `git commit`/`git push` instructions)
5. **Event emission:** Append `team.spawned` event with `event.data`: teamSize, teammateNames, taskCount, dispatchMode

Teammates self-coordinate via shared task list. No `Task()` calls needed.
<!-- /requires -->

## Step 5: Monitor Progress

For background tasks, poll/await using the runtime's result-collection primitive:
```text
{{SUBAGENT_RESULT_API}}
// task_id: task-001-id
```

<!-- requires:team:agent-teams -->
### Agent Teams Monitoring (enhanced)

When using `--mode agent-team`:
- Teammates visible in tmux split panes
- `{{SUBAGENT_COMPLETION_HOOK}}` auto-runs quality gates (typecheck, tests, clean worktree)
- On quality pass: emits `team.task.completed` event with performance data
- On quality fail: exit code 2 sends feedback, emits `team.task.failed` event
- Hook scans task graph for newly unblocked tasks for teammates to claim
- Orchestrator monitors via `exarchos_view delegation_timeline` for bottleneck detection
<!-- /requires -->

## Step 6: Collect Results

When tasks complete, run the post-delegation check:

```typescript
exarchos_orchestrate({
  action: "post_delegation_check",
  stateFile: "<path-to-state.json>",
  repoRoot: "<project-root>"
})
```

**Validates:**
- State file exists and is valid JSON
- Tasks array has entries
- All tasks report "complete" status
- Per-worktree test runs pass (unless `--skip-tests`)
- State file consistency (all tasks have id and status fields)

**On `passed: true`:** All delegation results collected and verified. Update TodoWrite status, then check if schema sync is needed (Step 7) and proceed to review phase.

**On `passed: false`:** Failures detected. Review the per-task status report. Address incomplete tasks or failing tests before proceeding.

<!-- requires:team:agent-teams -->
### Agent Teams Collection (enhanced)

When using `--mode agent-team`:
- `{{SUBAGENT_COMPLETION_HOOK}}` bridges real-time Agent Teams with persistent Exarchos state
- On quality gate pass: task marked "complete" + `team.task.completed` event emitted
- On quality gate fail: exit code 2 sends feedback + `team.task.failed` event emitted
- Rich event data: taskId, teammateName, durationMs, filesChanged, testsPassed
- After all teammates finish: append `team.disbanded` event with summary metrics
- Run `exarchos_orchestrate({ action: "post_delegation_check" })` as usual for final validation
<!-- /requires -->

## Step 7: Schema Sync (Auto-Detection)

After all tasks complete, check if API files were modified:

```typescript
exarchos_orchestrate({
  action: "needs_schema_sync",
  repoRoot: "<path>"
})
```

**On `passed: true`:** No sync needed — proceed to review.
**On `passed: false`:** Sync needed — API files modified (`*Endpoints.cs`, `Models/*.cs`, `Requests/*.cs`, `Responses/*.cs`, `Dtos/*.cs`). Run `npm run sync:schemas` and commit before proceeding.
