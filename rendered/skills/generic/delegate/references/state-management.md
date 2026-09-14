# Delegation State Management

State update patterns for workflow state during delegation. Use `mcp__plugin_exarchos_exarchos__exarchos_workflow` for all mutations.

## Read Tasks from State

Instead of re-parsing plan, read task list with `action: "get"`, `query: "tasks"`. For status checks during monitoring, use `fields: ["tasks"]` to reduce response size.

## Subagent Mode

**On Task Dispatch:**
```text
action: "update", featureId: "<id>", updates: {
  "tasks[id=<taskId>]": { "status": "in_progress", "startedAt": "<ISO timestamp>" },
  "worktrees.<wt-id>": { "branch": "<branch>", "taskId": "<taskId>", "status": "active" }
}
```

**On Task Complete:** nothing to patch. A settled batch marks each accepted task complete on the stream and on the state document — `settle` is the writer of `tasks[].status: "complete"`. Patching it by hand ahead of settlement lets an unverified task through the transition guard.

**On All Tasks Complete:**
```text
action: "transition", featureId: "<id>", target: "review"
```


## Benchmark Label

After extracting tasks from the plan, check if ANY task has `testingStrategy.benchmarks: true`. If so, record in state:

```text
action: "update", featureId: "<id>", updates: {
  "verification.hasBenchmarks": true
}
```

The `/exarchos:synthesize` skill reads `verification.hasBenchmarks` and applies the `has-benchmarks` label via `gh pr edit <number> --add-label has-benchmarks`.
