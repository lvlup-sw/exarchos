# Delegation State Management

State update patterns for workflow state during delegation. Use `mcp__plugin_exarchos_exarchos__exarchos_workflow` for all mutations.

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

The `/exarchos:synthesize` skill reads `verification.hasBenchmarks` and applies the `has-benchmarks` label via `gh pr edit <number> --add-label has-benchmarks`.


## Agent ID Tracking

Workflow task state includes additional fields for resume-aware fixer flow on runtimes with native session resume:

| Field | Type | Description |
|-------|------|-------------|
| `agentId` | string | Runtime agent ID for resume. Canonical source: the runtime's stop-event hook payload. |
| `agentResumed` | boolean | Whether this agent was resumed (vs. fresh dispatch). |
| `lastExitReason` | string | Completion status (e.g., `"success"`, `"failure"`, `"timeout"`). Canonical source: the runtime's stop-event hook payload. |

The runtime's stop-event hook (registered via the runtime's hook configuration) is the **canonical source** for `agentId` and `lastExitReason`. When the hook fires for `exarchos-implementer` or `exarchos-fixer` agents, the orchestrator persists the hook payload fields into `tasks[id=taskId]`. This enables the resume-first strategy in the fixer flow: when a task fails, the orchestrator can resume the original agent with failure context rather than dispatching a fresh fixer.

**State update on agent stop-event hook:**
```text
action: "set", featureId: "<id>", updates: {
  "tasks[id=<taskId>]": {
    "agentId": "<from stop-event hook payload: agent_id>",
    "agentResumed": false,
    "lastExitReason": "<from stop-event hook payload: exit_reason>"
  }
}
```

**State update on resume:**
```text
action: "set", featureId: "<id>", updates: {
  "tasks[id=<taskId>]": {
    "agentResumed": true,
    "status": "in_progress"
  }
}
```