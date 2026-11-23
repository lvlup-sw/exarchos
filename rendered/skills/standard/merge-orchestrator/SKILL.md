---
name: merge-orchestrator
description: "Merge-pending guide. The coordinator lands the accepted head commit of a settled task on the integration branch through its harness, from the clean integration worktree, and records a `merge.executed` row only for a stream parked in `merge-pending` or for a blocker that landed by a squash or a rebase. Use when a workflow is in `merge-pending`, when `prepare` refuses `BASE_UNRESOLVED` for a squashed or rebased blocker, or when you read merge rows in the history of a stream. Local git landing only. The coordinator creates and merges a pull request through its harness, outside governance. Do NOT use for the normal delegate Step 4 landing, which appends no event."
metadata:
  author: exarchos
  version: 2.0.0
  mcp-server: exarchos
  category: behavior
---

# Merge Orchestrator Skill

## Local Git, Through the Harness

This skill lands one accepted head commit on the integration branch with a local `git merge`. The coordinator runs each step with the git of its harness. No step calls an Exarchos action to merge, no step calls the VCS provider, and the landing needs no pull request.

A pull request from the integration branch is a different concern. The coordinator creates and merges that pull request through its harness, outside governance.

`references/local-git-semantics.md` gives the model. `references/recovery-runbook.md` gives the recovery for each failure.

## When to Use

- The workflow is in the `merge-pending` phase. An older stream can park there after a completion row that names a worktree.
- `prepare` refuses `BASE_UNRESOLVED`, because a completed blocker landed by a squash or a rebase and the base does not hold its accepted head.
- You read `merge.*` rows in the history of a stream.

Do not use this skill for the normal landing of delegate Step 4. That landing follows the delegate skill (`@skills/delegate/SKILL.md`, section "Worktree-Bearing Tasks"). It makes no Exarchos call and appends no `merge.executed` row.

## Process

### Step 1: Identify the accepted head

Land the accepted head commit of the settled claim: the commit that settlement accepted for the task. Do not land a branch name. If a step names the task branch, first check that `git rev-parse <task branch>` equals the accepted head, and stop on a difference. A fixer continues the earlier branch of its task, so the branch can move after the settlement.

### Step 2: Check whether the head landed already

```bash
git merge-base --is-ancestor <accepted head> <integration-branch>
```

Exit 0 skips the landing, because the integration branch holds the accepted head already. Exit 1 lands it. Any other exit stops the landing and reports. Run this check before each landing, and again before a landing is tried again after a crash or a lost reply.

### Step 3: Land through the harness

Run each step from the integration worktree, never from the task worktree.

1. Check that the integration worktree is on the integration branch and that `git status --porcelain` prints nothing. If not, stop and report.
2. Capture the integration tip before the landing with `git rev-parse <integration-branch>`. A row of Step 4 records this value as `rollbackSha`.
3. Land the accepted head:

   ```bash
   git merge --ff-only <accepted head commit>
   ```

Each landing is a fast-forward or a merge commit of the accepted head, so that head stays reachable. Never rebase or squash an accepted head: settle and the verifier need each blocker head as an ancestor of the fork of a dependent. When the fast-forward fails because the integration branch advanced, follow the delegate runbook "When integration advances mid-wave". It lands the accepted head unchanged with `git merge --no-ff <accepted head commit>`, and on a conflict it aborts the merge and plans a rework task.

A squash or a rebase is never a strategy to choose. It occurs only as an out-of-band case: a blocker that already landed that way. That case needs the recovery row of Step 4.

### Step 4: Record a row only where one is required

The normal landing appends no `merge.executed` row. Two cases need one:

- **A stream parked in `merge-pending`.** The `merge-pending → delegate` exit guard reads a `merge.executed` row that follows the latest `task.completed`.
- **A blocker that landed by a squash or a rebase.** `prepare` refuses `BASE_UNRESOLVED` until a row names the commit that landed.

Append the row after the git landing, because `mergeSha` does not exist before it. "Event first" means only that the append comes before any update of `mergeOrchestrator` state. A harness landing makes no such update. Set the fields so:

- `taskId`: the task that landed. For a recovery, the blocker.
- `sourceBranch`: the task branch.
- `targetBranch`: the integration branch.
- `mergeSha`: the integration tip after the landing, which holds the accepted head. For a recovery, the commit that landed, an ancestor of the integration branch.
- `rollbackSha`: the integration tip before the landing, from Step 3.

Give the append an `idempotencyKey` built from the `taskId` and the `mergeSha`. A resent append after a lost reply then returns the original row and adds no second row.

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

The recovery row satisfies `prepare` only. `settle` still needs a `forkCommit` that holds the accepted blocker head, so it refuses a compiler 8 dependent whose fork does not hold that head.

### Step 5: Leave `merge-pending`

After the row, move the workflow back to `delegate`:

```typescript
exarchos_workflow({ action: "transition", featureId: "<featureId>", target: "delegate" })
```

The exit guard reads the row on that move. If the state document is stale, run `exarchos_workflow({ action: "reconcile", featureId: "<featureId>" })` first, which rebuilds the state from the event log. The landing itself writes no transition.

## Merge Event History

The event log can hold merge rows from an earlier merge executor. Read them as history. Only `merge.executed` is still appended, and only by Step 4.

| Event type | Meaning | Carries |
|------------|---------|---------|
| `merge.preflight` | The earlier executor checked the landing before a merge | Guard sub-results, and `failureReasons` when `passed: false` |
| `merge.requested` | The earlier executor recorded its intent before a merge | `sourceBranch`, `targetBranch`, `strategy`, `taskId` |
| `merge.executed` | A landing happened. Step 4 appends it for the two cases above | `mergeSha`, `rollbackSha`, `taskId`, source and target branches |
| `merge.recovered` | The earlier executor rewound a failed merge to its recovery point | `recoveryPointSha`, `reason`, `recoveryError?`, `recoveryErrorDetail?`, `taskId`, source and target branches |
| `merge.rollback` | Legacy recovery row. Nothing writes it, and it folds the same as `merge.recovered` | `rollbackSha`, `reason`, `taskId`, source and target branches |

Discover the payload schemas with `exarchos_event({ action: "describe", eventTypes: ["merge.preflight", "merge.requested", "merge.executed", "merge.rollback", "merge.recovered"] })`.

## Recovery Rule (INV-14)

Never run `git reset --hard` on the integration branch. A landing that fails leaves the branch as it was: a refused fast-forward changes nothing, and `git merge --abort` on a conflict makes no commit. The only rewind in this skill is the read-side recovery of a stranded tree from the earlier executor, and it uses `git reset --keep`, which refuses to discard uncommitted work. See `references/recovery-runbook.md`.

## Reserved Fields

`mergeOrchestrator.*` fields on workflow state hold the record of the earlier executor, and gates read `mergeOrchestrator.phase`. A harness landing writes no `mergeOrchestrator` field. The `phase` workflow field is immutable and changes only through `transition`, not `update`. See the [Reserved fields](../checkpoint/SKILL.md#reserved-fields) section in the `checkpoint` skill for the full immutable-key list and the typed `RESERVED_FIELD` error envelope.

## Anti-Patterns

| Don't | Do Instead |
|-------|------------|
| Land a branch name | Land the accepted head commit, after `git rev-parse <task branch>` equals it |
| Rebase or squash an accepted head | Land it with a fast-forward, or with a merge commit when the integration branch advanced |
| Append `merge.executed` after a normal Step 4 landing | Append it only for a stream parked in `merge-pending` or a squash or rebase recovery |
| Append the row before the git landing | Land first, then append with the tip after the landing as `mergeSha` |
| Append without an `idempotencyKey` | Use `<taskId>:<mergeSha>`, so a resend returns the original row |
| Resolve a conflict in the integration worktree | Run `git merge --abort` and follow the delegate runbook "When integration advances mid-wave" |
| Run `git reset --hard` | Use `git reset --keep`, and only for the stranded-tree recovery of the runbook |
| Land from a task worktree | Land from the clean integration worktree on the integration branch |
| Merge a remote pull request with this skill | The coordinator creates and merges the pull request through its harness, outside governance |

## Completion Criteria

- [ ] `git merge-base --is-ancestor <accepted head> <integration-branch>` exits 0. Do not compare the branch tip with a recorded `mergeSha`, because a later landing moves the tip.
- [ ] `git status --porcelain` in the integration worktree prints nothing.
- [ ] Where Step 4 applies, one `merge.executed` row with all five fields follows the latest `task.completed`.
- [ ] A stream that was parked in `merge-pending` is back in `delegate`.

If a criterion fails, consult `references/recovery-runbook.md` before a new landing.
