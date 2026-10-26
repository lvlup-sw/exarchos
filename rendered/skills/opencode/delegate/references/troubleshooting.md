# Delegation Troubleshooting

## MCP Tool Call Failed
If an Exarchos MCP tool returns an error:
1. Check the error message — it usually contains specific guidance
2. Verify the workflow state exists: call `exarchos_workflow` with `action: "get"` and the featureId
3. If "version mismatch": another process updated state — retry the operation
4. If state is corrupted: call `exarchos_workflow` with `action: "cancel"` and `dryRun: true`

## State Desync
If workflow state doesn't match git reality:
1. Run `/rehydrate <featureId>` — the rehydration projection folds events newer than the last snapshot
2. If manual check still needed: compare the rehydration document's `workflowState` / `artifacts` with `git log` and branch state
3. Update state via `exarchos_workflow` with `action: "update"` to match git truth

## Worktree Creation Failed
If `git worktree add` fails:
1. Check if the branch already exists: `git branch --list <branch-name>`
2. Check if a worktree already exists at the path: `git worktree list`
3. If stale worktree: `git worktree prune` then retry
4. If branch conflict: use a unique branch name

## A Claimed Worktree Out of Scope (`worktree-out-of-scope`)

Before any gate runs, settlement observes with git the worktree that each completed claim names, when the capsule pins a scope (`settlementContract.scope`). A worktree that fails a rule gives the finding `worktree-out-of-scope` of the unresolved class. The task runs no gate, and its `unresolved` entry has the cause `worktree-out-of-scope`. The other tasks of the batch still verify. The finding message names the first rule that fails, what git observed, and the recovery:

| Rule | The worktree fails when | Recovery |
|------|-------------------------|----------|
| `unobservable` | A git call timed out or did not start | Make the worktree readable to git |
| `not-a-worktree-root` | The path is outside a git work tree, or it is not the root of its work tree | Fork a worktree of its own from `<baseRef>` at `<baseCommit>` |
| `other-repository` | Its git common dir is not the repository that the capsule pins | Fork the worktree in the pinned repository |
| `the-checkout` | It is the checkout that `prepare` read, or the primary worktree of the repository. The message says which | Fork a linked worktree of its own |
| `on-the-base-branch` | It is on the integration branch (`baseRef`) | Fork a worktree on a branch of its own |
| `other-branch` | The claim names a branch, and the worktree is on another branch or detached | Name the branch of the worktree in the claim, or fork a new worktree |
| `base-not-held` | HEAD does not hold `<baseCommit>` | Fork from `<baseRef>` at `<baseCommit>`, or rebase the branch onto `<baseCommit>` |
| `uncommitted-changes` | `git status --porcelain` is not empty. The message lists up to five paths | Commit the listed files of the task. Remove a listed file that a gate run left, and do not commit it |
| `shared-worktree` | Another claim of the batch, or the completion row of another task, names the same worktree | Fork a worktree of its own for the task |

After the recovery, claim the task in a new batch on the same capsule. A complete task whose worktree was removed gives no finding.

**A linked `node_modules` gives `uncommitted-changes`.** The ignore pattern `node_modules/` matches a directory, not a symbolic link, so git lists a linked `node_modules` as untracked. Add `node_modules`, without a trailing slash, to `.gitignore` or to the exclude file of the common dir.

## `task_complete` Refuses a Named Tree (`GATE_NOT_PASSED`)

`task_complete` accepts only a pass on the tree and the commit that `result.worktreePath` names. The refusal names its cause and its recovery:

| Cause | Meaning | Recovery |
|-------|---------|----------|
| `other-tree` | The latest passing static-analysis run scanned another tree or another commit, or a run of an earlier build names no tree | Run `check_static_analysis` with `taskId`, `repoRoot: 'auto'` and the `worktreePath` of the tree, then call `task_complete` again |
| `tree-unnamed` | The stream holds a prepared capsule, and the completion names no tree | Name the worktree of the task in `result.worktreePath`, and record a pass there |
| `tree-out-of-scope` | With a scoped capsule, the named tree fails a scope rule: `not-a-worktree-root`, `other-repository`, `the-checkout`, `on-the-base-branch`, `other-branch`, `base-not-held`, or `shared-worktree` for the tree of the completion row of another task | Fork a worktree of the pinned repository from `<baseRef>` at `<baseCommit>`, on a branch of its own, and record a pass there. With no `capsuleVersion` in the call, also pass the version of the batch of the task |
| `repo-root-missing` | The latest run named the task and no `repoRoot`, so it scanned nothing | Run `check_static_analysis` again with `repoRoot: 'auto'` and the `worktreePath` |
| `disabled-by-config` | The config disables `check_static_analysis`, so its provider did not run | Make the gate enabled and blocking in the `.exarchos.yml` of the checkout, then run it again |

Under `settle`, correct the cause and settle the claim under a new batch id.

## `prepare` Refuses `SCOPE_UNRESOLVED` or `BASE_UNRESOLVED`

`prepare` records nothing when it refuses. Its message names the cause and the recovery.

`SCOPE_UNRESOLVED` has five causes:

- `repoRoot` is not inside a git work tree. Pass as `repoRoot` the absolute path of the worktree where the integration branch is checked out.
- The latest capsule of the workflow pins another repository. Run `prepare` with a `repoRoot` in a checkout of the pinned repository. A repository that moved, or a new clone, cannot continue the workflow: put the clone back at the pinned path, or start a new workflow for the rest of the work.
- The `.exarchos.yml` of the checkout does not load or cannot be read. Repair or remove the file.
- A registered invariant catalog does not resolve against the checkout. Put a valid catalog at the path that the message names, or remove its registration.
- The config of the checkout makes `check_static_analysis` disabled or warning-only. Make it blocking, because a task completes only on a passing static-analysis record.

`BASE_UNRESOLVED` has three causes:

- The workflow records no integration branch. Set `synthesis.integrationBranch`.
- The repository of the checkout holds no commit of the integration branch. Create the branch, or pass as `repoRoot` a worktree of the repository that holds it.
- A completed blocker of a batch task has a landed commit that the base commit does not hold. Land the blocker on the integration branch, then `prepare` again. A blocker that landed by a squash or a rebase outside `serialize_merge` needs a `merge.executed` row: `taskId` of the blocker, `targetBranch` the integration branch, `mergeSha` the landed commit, with `sourceBranch` and `rollbackSha`. Append that row, then `prepare` again.

## `settle` Refuses `CAPSULE_UNRESOLVED`

When a batch needs a segment, settlement refuses two more kinds of capsule, and it records nothing:

- **A capsule that pins no scope**, from an earlier compiler, or a task with no `baseCommit`. On a submission, `prepare` again under a compiler that pins the scope, then claim the tasks in a new batch. On a decision round, decide by rejecting, which runs no segment, or `prepare` again and claim the tasks in a new batch.
- **A config that changed after `prepare`.** The digest of `.exarchos.yml` and `.exarchos.yaml` at the checkout differs from `scope.configDigest`. On a submission, `prepare` again with the same `repoRoot`, then claim the tasks in a new batch. On a decision round, a new `prepare` does not help, because a held batch stays on its capsule version. Put the config files back to the bytes that `prepare` read and send the same decision again, or decide by rejecting, then `prepare` again and propose the deviation again in a new batch.

## Subagent Not Responding
If a spawned subagent doesn't respond:
1. Check task output via the runtime's result-collection primitive (`Task() reply (inline, no poll)`)
2. If the subagent is stuck: stop it with the runtime's task-stop primitive and re-dispatch

## Task Claim Conflict
If `exarchos_orchestrate` with `action: "task_claim"` returns ALREADY_CLAIMED:
1. Another agent already claimed this task — skip it
2. Check task status via `exarchos_view` with `action: "tasks"` and `filter: { "taskId": "<id>" }`
3. Do not re-dispatch — the other agent is handling it

## Common Workflow Errors

### Error: `all-tasks-complete not satisfied: N task(s) incomplete`

**Cause:** A task is not complete after settlement. Its batch has an unresolved task (`corrective-capsule`), or the batch was rejected, held or stale, and in this build settlement verified nothing at its read. A replayed `rejected` receipt of an earlier build can name verified tasks. A task is unresolved when its verification failed, or when its claim reported it as `failed`, `blocked` or `skipped`. Read the outcome and the `findings` of the settlement receipt: a task that settlement did not verify is not complete, whatever the worker reported. Without the receipt, read the settlement record: `exarchos_event({ action: "query", stream: "<featureId>", filter: { type: "execution.settled" } })` returns one row for each settlement round, with its `outcome` and, under `corrective-capsule`, its `unresolvedTasks`. Or, on the primitive path, a task has no completion: its gates did not pass, or nobody called `task_complete` for it. The `all-tasks-complete` guard checks the exarchos workflow `tasks[]` array, NOT any runtime-native task list.



**Solution:** On the capsule path, make the next call that the outcome names (Step 3 of the skill). For `corrective-capsule`, read the `cause` of each unresolved task. Fix the task, remove its block, or dispatch it. Then settle a new batch id on the same capsule that claims those tasks. Settlement marks each task that passes complete. On the primitive path, run the task-completion runbook for each incomplete task (`exarchos_orchestrate({ action: "runbook", id: "task-completion" })`), or call `task_complete` for the task after its gates pass. `task_complete` marks the task complete in the event stream and in workflow state. If the stream already holds the `task.completed` row of the task, run `exarchos_workflow({ action: "reconcile", featureId: "<id>" })`, then transition again. Do not write `tasks[].status` by hand: only `task_complete` or settlement marks a task complete.

### Error: `Expected object, received array` when setting reviews

**Cause:** The `reviews` field requires a keyed object, not an array.

**Solution:** Use named keys for each review:
```json
{
  "reviews": {
    "spec-review": { "status": "pass", "issues": [] },
    "quality-review": { "status": "pass", "issues": [] }
  }
}
```

### Error: `No transition from 'explore' to 'plan'`

**Cause:** Refactor workflows use different phase names than feature workflows. Feature uses `plan`, refactor uses `overhaul-plan` (overhaul track) or `polish-implement` (polish track).

**Solution:** Check the `validTargets` array in the error response. For refactor overhaul: use `overhaul-plan`. For refactor polish: use `polish-implement`. Use `exarchos_workflow get` with `query: "phase"` to confirm the current phase. The response `data` is `{ "phase": "<current-phase>" }`.

### Error: `invalid_enum_value` on event type (e.g., `wave.completed`)

**Cause:** The event type string doesn't match the enum. Common mistakes: `wave.completed` (not a valid type), `task.progress` (use `task.progressed`).

**Solution:** Use exact type strings from the Event Emission Contract table in SKILL.md. Valid team delegation types: `team.spawned`, `team.task.planned`, `team.teammate.dispatched`, `team.disbanded`, `team.task.completed`, `team.task.failed`.

### Error: `Guard 'triage-complete' failed: triage-complete not satisfied`

**Cause:** The guard checks for `state.triage.symptom`, not `state.triage.complete` or `state.triageComplete`.

**Solution:** Set the `triage.symptom` field:
```json
{
  "action": "update",
  "featureId": "<id>",
  "updates": {
    "triage": { "symptom": "<description of the bug or issue>" }
  }
}
```

### Error: `Guard 'root-cause-found' failed`

**Cause:** Guard checks `state.investigation.rootCause`, not `state.rootCause`.

**Solution:** Set `investigation.rootCause`:
```json
{
  "action": "update",
  "featureId": "<id>",
  "updates": {
    "investigation": { "rootCause": "<root cause description>" }
  }
}
```
