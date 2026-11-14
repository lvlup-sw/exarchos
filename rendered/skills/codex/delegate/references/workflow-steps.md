# Delegation Workflow Steps

## Step 1: Prepare Environment

Use the approved record to bootstrap a new feature. Pass the absolute integration checkout, the checkout-relative design reference and the selected depth. Set `approvedFileSha256` to the bare lowercase SHA-256 hex of the entire approved file in raw bytes. For refactor bootstrap, use the `refactor` workflow type and supply its `overhaul` track and scope assessment. Replace the example values with the approved handoff values.

```typescript
exarchos_orchestrate({
  action: "prepare", featureId: "add-email-validation", repoRoot: "/project",
  intent: {
    mode: "bootstrap", workflowType: "feature", baseRef: "feat/add-email-validation",
    designDepth: "standard", designRef: "docs/specs/2026-02-28-add-email-validation.md",
    approval: { decision: "approved", designDigest: approvedFileSha256 }
  }
})
```

Resend the identical saved bootstrap request to recover its receipt. Preserve the original approval and depth even if the checkout has changed. Use compile intent for a design revision or approved plan edit. Compiler 7 also needs it for each later frontier; compiler 8 keeps the complete pinned graph across waves. If the file changed, obtain approval for the new raw bytes and set `approvedCurrentFileSha256` to their digest. If the file is unchanged, use its existing approval.

```typescript
exarchos_orchestrate({
  action: "prepare", featureId: "add-email-validation", repoRoot: "/project",
  intent: {
    mode: "compile", designDepth: "standard", designRef: "docs/specs/2026-02-28-add-email-validation.md",
    approval: { decision: "approved", designDigest: approvedCurrentFileSha256 }
  }
})
```

For a refactor continuation, also carry `refactor: { track: "overhaul", scopeAssessment: "<assessment>" }` in the compile intent.

Keep the `capsuleVersion`. The capsule's task graph is the wave. For parallel tasks, create one linked worktree for each task from its `baseCommit`:

```bash
git worktree add --detach .worktrees/task-001 <baseCommit>
cd .worktrees/task-001 && npm install
```

The worktree is detached, so the base step of the worker makes the branch of the task: `git switch -c <own branch> <baseCommit>`. Give each worker an `<own branch>` that no branch holds yet, such as `task/task-001`. It is not the branch of a worktree that `setup_worktree` or `git worktree add -b` made, because git refuses `git switch -c` for a branch that exists.

A task never runs in the checkout that `prepare` read or in the primary worktree of the repository: `settle` and `task_complete` refuse both. A linked `node_modules` needs the ignore rule `node_modules`, without a trailing slash, or the worktree is not clean.

For compiler-8 dependents, replace the root base step with `git switch -c <own branch> <forkCommit>` at the supplied clean commit containing all direct blocker heads and the pinned base. Record the full fork before edits and return `fields.forkCommit` when the result contract requires it. Never reset a dependent to the root base.

## Step 2: Extract Task Details

For compiler 8, copy each pinned taskContext and its referenced result contract from the capsule or its exact read_prepared_capsule detail invocation. Follow continuations without changing stream/version. Do not rebuild context from current prose. For compiler 7, use each capsule task ID to select the object from the matching approved typed plan. Copy full title, instructions, acceptance criteria, and source and test paths into the worker prompt.

From that version-appropriate source, include for each task:
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



### Read-Only Dispatch (reviewers, plan-review panels, researchers)

Agents that read and report but mutate nothing are provisioned `posture: "read-only"`,
and the `dispatch` emitted for that posture is an **anonymous async subagent** —
`naming: "anonymous"`, `workspace: "inherited"`. No worktree is materialized, because a
read-only agent has nothing to isolate.

`naming: "anonymous"` is a **prohibition, not a default**: the `name` field must be
OMITTED.

```typescript
// CORRECT — read-only: anonymous, no name, no worktree
spawn_agent({
  agent_type: "default",
  message: "Plan review voter 1\n\n<provisioned review prompt>"
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
wait_agent({ task_id })
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

**Recovery is a fresh anonymous dispatch**, per the emitted `dispatch` (`name` omitted).
Do not try to repair or re-address the named spawn; it cannot be revived.

Confirm a read-only wave by its **verdicts**, never by its liveness. A panel that returns
no verdicts did not run, however healthy it looked. The live incident behind this rule
provisioned a plan-review panel `read-only`, dispatched it with a name and no isolation,
and produced three phantom agents and zero verdicts.


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

A task that is not completed gets a claim with a status and a reason, and no fields: `{ taskId: "task-002", status: "blocked", reason: "<why>" }`. The status is `failed`, `blocked` or `skipped`. A completed claim can record a delegated choice: `rationale: [{ delegatedDecision: "<id from the capsule>", statement: "<the choice>" }]`.

**Settlement decides:**
- Every claim is read against the task's declared result shape
- Each accepted task's verification runs — the ladder gates under the tier the capsule froze, then the completion — against the worktree the claim names
- A claim with a status gets no verification, and its task stays unresolved
- Compiler 7 settlement requires every required result. Compiler 8 can accept a partial batch while other graph nodes remain; accepted standing must come from actual claims and custody. Read the findings and phaseMove rather than treating an accepted subset as whole-graph completion.

**On `settled`:** Update TodoWrite for accepted results, land their worktrees and run the wave backstop. For compiler 8, continue any remaining eligible graph nodes under the same applicable capsule with a new batchId. Follow phaseMove; proceed to schema sync (Step 7) and review only when the whole task-batch obligations are satisfied.

**On `accepted-with-rationale`:** The batch is settled, and a claim records a delegated choice. The same gates ran. Continue as on `settled`.

**On `corrective-capsule`:** The tasks that passed are complete. Read `unresolved`. Its `cause` says why each task is unresolved: a gate halted (`verification-failed`), the claimed worktree is out of the scope of the capsule (`worktree-out-of-scope`, no gate ran), or the claim reported the task as `failed`, `blocked` or `skipped`. Fix the task, correct the worktree, remove the block, or dispatch the task. Then settle a new batch id on the same capsule, and claim only the unresolved tasks. If the receipt carries `designRevision`, compile a continuation first. Land each task of `acceptedTasks` before you create the worktree of a task that waits on it.

**On `rejected`:** The request or a deviation is in error, and in this build settlement verified nothing at its read. A task that settlement verified before a read changed stays complete. A replayed receipt of an earlier build can name verified tasks (Step 3 of the skill). Read the findings, and correct the claim or the deviation. Then settle the corrected request under a new batch id on the same capsule.

**On `deviation-pending`:** At its read, settlement verified nothing. Get a decision from a person for each pending deviation. In a run with no person, stop at the held batch and report it. When a person has decided, settle the same batch id with `decisions` and no claims.

**On `recompile-required`:** The capsule was stale, and at its read settlement verified nothing. A task that settlement verified before a read changed stays complete. Compile a continuation and settle under its capsule.

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
