# Delegation Workflow Steps

## Step 1: Prepare Environment

Compile the batch first — `exarchos_orchestrate({ action: "prepare", featureId: "<featureId>" })` — and keep the `capsuleVersion`; the capsule's task graph is the wave. Then, for parallel tasks, create worktrees:
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
`dispatch` field alongside `posture` — `prepare_delegation` for a mutating wave on the
primitive path, `prepare_review` for a reviewer or plan-review panel. On the capsule path
the launch is the runtime's own spawn primitive with the packet the skill's Step 2 builds. That field carries the mechanical
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

When the workers report, build one claim per report and settle the batch:

```typescript
exarchos_orchestrate({
  action: "settle",
  featureId: "<feature-id>",
  capsuleVersion: <capsuleVersion>,
  batchId: "<feature-id>:wave-1",
  claims: [{ taskId: "task-001", fields: { worktreePath: "<worktree>", branch: "<branch>", files: [...], implements: [...], tests: [...] }, evidence: [] }, ...]
})
```

**Settlement decides:**
- Every claim is read against the task's declared result shape
- Each accepted task's verification runs — the ladder gates under the tier the capsule froze, then the completion — against the worktree the claim names
- A settled batch leaves every required task complete. Each other outcome names every finding at once

**On `settled`:** All delegation results verified. Update TodoWrite status, land the worktrees, run the wave backstop, then check if schema sync is needed (Step 7) and proceed to review phase.

**On `corrective-capsule`:** The tasks that passed are complete. Read `unresolved`, and dispatch a fixer to the worktree of each task in it. Then settle a new batch id on the same capsule, and claim only the unresolved tasks.

**On `rejected`:** The request or a deviation is in error, and settlement verified nothing. Read the findings, and correct the claim or the deviation. Then settle the corrected request under a new batch id on the same capsule.

**On `deviation-pending`:** Settlement verified nothing. Get a decision for each pending deviation. Then settle the same batch id with `decisions` and no claims.

**On `recompile-required`:** The capsule was stale, and settlement verified nothing. Call `prepare` again, and settle under the capsule that it returns.

Step 3 of the skill gives each outcome in full.


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
