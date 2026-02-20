# Delegation State Management

State update patterns for workflow state during delegation. Use `mcp__exarchos__exarchos_workflow` for all mutations.

## Read Tasks from State

Instead of re-parsing plan, read task list with `action: "get"`, `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

## Subagent Mode

**On Task Dispatch:**
```
action: "set", featureId: "<id>", updates: {
  "tasks[id=<taskId>]": { "status": "in_progress", "startedAt": "<ISO timestamp>" },
  "worktrees.<wt-id>": { "branch": "<branch>", "taskId": "<taskId>", "status": "active" }
}
```

**On Task Complete:**
```
action: "set", featureId: "<id>", updates: {
  "tasks[id=<taskId>]": { "status": "complete", "completedAt": "<ISO timestamp>" }
}
```

**On All Tasks Complete:**
```
action: "set", featureId: "<id>", phase: "review"
```

## Agent Team Mode (Single-Writer)

Only the orchestrator mutates `workflow.tasks[]` via `exarchos_workflow set`. Hooks emit events but never mutate state directly.

- **Step 2:** Store `nativeTaskId` from each `TaskCreate` return value
- **Step 4:** Read `team.task.completed` events during monitoring, update task status
- **Staleness:** 30-60s projection lag is acceptable — native task dependency unblocking is automatic

For the three-layer consistency model, drift recovery, and eventual consistency details, see `agent-teams-saga.md`.

## Benchmark Label

After extracting tasks from the plan, check if ANY task has `testingStrategy.benchmarks: true`. If so, record in state:

```
action: "set", featureId: "<id>", updates: {
  "verification.hasBenchmarks": true
}
```

The `/synthesize` skill reads `verification.hasBenchmarks` and applies the `has-benchmarks` label via `gh pr edit <number> --add-label has-benchmarks`.
