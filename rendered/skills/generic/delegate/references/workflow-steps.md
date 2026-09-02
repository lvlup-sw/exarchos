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

**The launch shape is provisioned, not improvised.** Every provisioning verb emits a
`dispatch` field alongside `posture` — `prepare_delegation` for a mutating wave,
`prepare_review` for a reviewer or plan-review panel. That field carries the mechanical
launch parameters (`subagent`, `naming`, `workspace`), the harness capabilities it
`requires`, and the declared `fallback` to use when a runtime cannot honour them (DR-25).
**Read the shape off the emitted `dispatch`.** Where this reference and an emitted
`dispatch` disagree, the emitted field is the contract and wins.

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



On a runtime with no native subagent spawn, the emitted `dispatch` resolves to its
declared `fallback` instead of being improvised: the caller performs the read-only pass
inline, in its own context. That is a degradation the caller must surface — the pass is no
longer fresh-context — but a fallback always still runs the prompt.

## Step 5: Monitor Progress

For background tasks, collect results using the runtime's result-collection primitive:
```text
[task output is the assistant's next message]
```
If the runtime uses a poll/await API, pass the `task_id` returned at dispatch time. Inline-reply runtimes deliver results as the subagent's next message — no `task_id` is needed.



## Step 6: Collect Results

When tasks complete, run the post-delegation check:

```typescript
exarchos_orchestrate({
  action: "post_delegation_check",
  featureId: "<feature-id>",
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
