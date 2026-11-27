# Recovery Runbook

What to do when a harness landing of an accepted head does not finish cleanly, and how to read the recovery rows of the earlier merge executor. No step discards uncommitted work or sets it aside, and no step rebases or squashes an accepted head.

## The fast-forward refuses

`git merge --ff-only <accepted head commit>` prints `fatal: Not possible to fast-forward, aborting.` The integration branch advanced after the base of the task, and the refusal changed nothing.

Follow the delegate runbook "When integration advances mid-wave" (`@skills/delegate/SKILL.md`). It checks ancestry first, captures the rollback commit with `git rev-parse <integration-branch>`, and lands the accepted head unchanged with `git merge --no-ff <accepted head commit>`. On a conflict it goes to its Rollback procedure: `git merge --abort`, a compare of the integration branch with the captured commit, and a rework task. Do not resolve a conflict in the integration worktree.

## The integration worktree is not clean

`git status --porcelain` prints a line before the landing. Stop and report. Find the owner of the change, and let that owner commit it on its own branch. The landing never discards work and never sets it aside.

## A landing was interrupted

After a crash or a lost reply, first run:

```bash
git merge-base --is-ancestor <accepted head> <integration-branch>
```

Exit 0 means that the landing happened: do not land again. Exit 1 means that it did not: start again at Step 3 of the skill. Any other exit stops the recovery and reports.

If `git status` shows a merge in progress, the operator runs `git merge --abort` by hand, checks that `git status --porcelain` prints nothing, and then runs the ancestry check again.

## The `merge.executed` row is required

A stream parked in `merge-pending`, or a blocker that landed by a squash or a rebase, needs one `merge.executed` row (skill Step 4). Append it after the git landing, never before it, and before any update of `mergeOrchestrator` state. A harness landing makes no state update, so the row is the whole record.

```typescript
exarchos_event({
  action: "append",
  stream: "<featureId>",
  idempotencyKey: "<taskId>:<mergeSha>",
  event: {
    type: "merge.executed",
    data: {
      taskId: "<taskId>",
      sourceBranch: "<task branch>",
      targetBranch: "<integration-branch>",
      mergeSha: "<integration tip after the landing>",
      rollbackSha: "<integration tip before the landing>",
    },
  },
})
```

For a squash or rebase recovery, `mergeSha` is the commit that landed, an ancestor of the integration branch. That row satisfies `prepare` only. `settle` still needs a `forkCommit` that holds the accepted blocker head.

If the append fails or its reply is lost, send the same append again with the same `idempotencyKey`. The event store returns the original row, so the resend adds no second row.

## Leave `merge-pending`

The `merge-pending → delegate` exit guard reads a `merge.executed` row that follows the latest `task.completed`. After the row, run `exarchos_workflow({ action: "transition", featureId: "<featureId>", target: "delegate" })`. If the state document is stale, run `exarchos_workflow({ action: "reconcile", featureId: "<featureId>" })` first, which rebuilds the state from the event log.

The next worktree-bearing `task.completed` of an older stream can park it in `merge-pending` again. Land that task the same way.

## A landing ran twice

Until the `merge-pending` path stops offering the earlier merge executor, a head can reach the integration branch through that executor and through the harness. Both orders are safe. The ancestry check skips a head that landed already, and git merges an ancestor as already up to date.

## A stranded tree from the earlier executor

This section is read-side history. The earlier merge executor recorded its recovery in `merge.recovered` (legacy `merge.rollback`). If that row carries `recoveryError` or `recoveryErrorDetail`, its recovery did not finish, and the integration worktree can be stranded.

1. Read the recovery point. Query `exarchos_event({ action: "query", stream: "<featureId>", filter: { type: "merge.recovered" } })` and take `recoveryPointSha` from the latest row. If no such row exists, take `rollbackSha` from the latest legacy `merge.rollback` row. A `merge.preflight` row does not carry the recovery point.
2. Inspect the branch:

   ```bash
   git status
   git log --oneline -5
   ```

   Each commit above the recovery point must be the merge of that executor. If another commit is there, stop and report. Never reset over a commit that the executor did not make.
3. Rewind the integration branch from the integration worktree:

   ```bash
   git switch <integration-branch>
   git reset --keep <recoveryPointSha>
   ```

   `--keep` refuses to discard uncommitted work. If it refuses, stop and report. Do not replace `--keep` with a reset that discards work (INV-14).

Then land the accepted head again through the harness, from Step 2 of the skill.
