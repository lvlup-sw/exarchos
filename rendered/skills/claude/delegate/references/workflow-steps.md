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


### Agent Teams Dispatch (enhanced)

When using `--mode agent-team`:
1. **Pre-delegation intelligence:** Query `exarchos_view team_performance` for historical metrics
2. **Team creation:** Create team with named teammates, each assigned to a worktree
3. **Task list setup:** Create native runtime task entries (e.g. via the runtime's TaskList primitive on Claude Code) with dependency annotations
4. **Natural language delegation:** Describe tasks to teammates with full implementer prompt content (MUST include Commit Strategy section with `git commit`/`git push` instructions)
5. **Event emission:** Append `team.spawned` event with `event.data`: teamSize, teammateNames, taskCount, dispatchMode

Teammates self-coordinate via shared task list. No `Task()` calls needed.


### Read-Only Dispatch (reviewers, plan-review panels, researchers)

Agents that read and report but mutate nothing are provisioned `posture: "read-only"`,
and the `dispatch` emitted for that posture is an **anonymous async subagent** —
`naming: "anonymous"`, `workspace: "inherited"`. No worktree is materialized, because a
read-only agent has nothing to isolate.

`naming: "anonymous"` is a **prohibition, not a default**: the `name` field must be
OMITTED.

```typescript
// CORRECT — read-only: anonymous, no name, no worktree
Task({
  subagent_type: "exarchos-reviewer",
  run_in_background: true,
  description: "Plan review voter 1",
  prompt: "<provisioned review prompt>"
})

```

Naming a spawn that carries no isolation does not give you a nameable subagent. It gives
you an agent the prompt is never delivered to, and the failure is silent — see Step 5 for
how it presents while it is happening. Dispatch a read-only panel that way and you get
phantom agents and zero verdicts.

The other two postures, for contrast:

- **`task-isolated`** — what `prepare_delegation` provisions for an implementer / fixer /
  scaffolder wave: **named AND worktree-isolated**, never one without the other. A name
  without a worktree is the failure above; a worktree without a name cannot be addressed
  for merge.
- **`shared-mutating`** — **main worktree, never a subagent.** Handing shared-state
  mutation to an isolated subagent silently splits the single-writer path.

On a runtime with no native subagent spawn, the emitted `dispatch` resolves to its
declared `fallback` instead of being improvised: the caller performs the read-only pass
inline, in its own context. That is a degradation the caller must surface — the pass is no
longer fresh-context — but a fallback always still runs the prompt.

## Step 5: Monitor Progress

For background tasks, collect results using the runtime's result-collection primitive:
```text
TaskOutput({ task_id, block: true })
```
If the runtime uses a poll/await API, pass the `task_id` returned at dispatch time. Inline-reply runtimes deliver results as the subagent's next message — no `task_id` is needed.


### Recognizing a Phantom Read-Only Dispatch

A read-only dispatch launched with a `name` but no isolation fails **silently**, and every
signal you have looks like progress. Do not read liveness as work:

- **The spawn returns success.** The acknowledgement says only that something was created;
  it says nothing about whether the prompt was delivered.
- **Liveness pings are not work.** The agent reports itself alive and idle — an empty
  mailbox pings exactly like an agent between turns.
- **The agent is missing from the runtime's own agent listing** while apparently still
  running. That absence is the tell.
- **Re-addressing it does not recover it.** The prompt was never delivered, so there is
  nothing to resume; a follow-up message only queues a second undelivered message.
- **The work never lands.** No verdict, no report, no output — only the spawn receipt.


Concretely, on a runtime with a named-teammate primitive: the spawn returns success, the
agent emits `idle_notification` pings that read like progress, `ListAgents` omits the
agent entirely, and `SendMessage` recovery also fails.

**Recovery is a fresh anonymous dispatch**, per the emitted `dispatch` (`name` omitted).
Do not try to repair or re-address the named spawn; it cannot be revived.

Confirm a read-only wave by its **verdicts**, never by its liveness. A panel that returns
no verdicts did not run, however healthy it looked. The live incident behind this rule
provisioned a plan-review panel `read-only`, dispatched it with a name and no isolation,
and produced three phantom agents and zero verdicts.


### Agent Teams Monitoring (enhanced)

When using `--mode agent-team`:
- Teammates visible in tmux split panes
- `TeammateIdle hook` auto-runs quality gates (typecheck, tests, clean worktree)
- On quality pass: emits `team.task.completed` event with performance data
- On quality fail: exit code 2 sends feedback, emits `team.task.failed` event
- Hook scans task graph for newly unblocked tasks for teammates to claim
- Orchestrator monitors via `exarchos_view delegation_timeline` for bottleneck detection

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


### Agent Teams Collection (enhanced)

When using `--mode agent-team`:
- `TeammateIdle hook` bridges real-time Agent Teams with persistent Exarchos state
- On quality gate pass: task marked "complete" + `team.task.completed` event emitted
- On quality gate fail: exit code 2 sends feedback + `team.task.failed` event emitted
- Rich event data: taskId, teammateName, durationMs, filesChanged, testsPassed
- After all teammates finish: append `team.disbanded` event with summary metrics
- Run `exarchos_orchestrate({ action: "post_delegation_check" })` as usual for final validation

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
