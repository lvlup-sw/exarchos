# Recovery Runbook

What to do when `merge_orchestrate` returns a non-`completed` outcome.

## `phase: 'aborted'` — preflight blocked

The merge was never attempted. `data.preflight` carries the structured guard sub-results so you can identify which guard failed without reading workflow state.

### Diagnose

Inspect each guard field in order (the orchestrator evaluates them in this precedence):

1. **`preflight.ancestry.passed === false`** — source does not descend from target.
   - Check `preflight.ancestry.missing` for the missing ref(s).
   - Resolution: rebase or merge target into source first, then re-dispatch.

2. **`preflight.currentBranchProtection.blocked === true`** — current branch is protected.
   - Check `preflight.currentBranchProtection.currentBranch` and `.hint`.
   - Resolution: switch off the protected branch (`git checkout <non-protected>`) and re-dispatch.

3. **`preflight.worktree.isMain === false`** — invoked from a subagent worktree.
   - Resolution: `cd` to the main worktree (`preflight.worktree.expected`) and re-dispatch.

4. **`preflight.drift.clean === false`** — uncommitted work in the working tree.
   - Sub-fields: `drift.uncommittedFiles[]`, `drift.indexStale`, `drift.detachedHead`.
   - Resolution depends on intent:
     - Want to keep the work → `git stash` or commit it on a new branch.
     - Want to discard → `git restore .` (or `git reset --hard HEAD` if the index is also dirty).
     - Detached HEAD → `git checkout <branch>` to attach.
   - Per design, the orchestrator never auto-recovers from drift — this is deliberate, to ensure no code path can destroy uncommitted work.

`failureReasons` on the emitted `merge.preflight` event carries the operator-facing diagnostic string `describePreflightFailure` produces, mirroring what the ToolResult shows.

### Re-dispatch

After resolving the underlying condition, re-invoke `merge_orchestrate` with the same arguments. The fresh dispatch re-runs preflight; if all guards now pass, the executor proceeds.

## `phase: 'rolled-back'` — merge attempted, reverted

The executor recorded the rollback SHA, attempted the merge, the merge or post-merge verification failed, and `git reset --hard <rollbackSha>` ran. The integration branch is restored to its pre-merge state.

### Diagnose

Check `data.reason`:

| `reason` | Meaning | Typical cause |
|----------|---------|---------------|
| `merge-failed` | Git merge command exited non-zero | Merge conflict, missing source branch, ref corruption |
| `verification-failed` | Post-merge verification step rejected the merge | Custom verification adapter detected a problem (rare in default config) |
| `timeout` | Underlying operation exceeded the 120s timeout | Repo size, slow disk, lock contention |

### Then check `data.rollbackError`

If present, the reset itself failed and **the working tree is stranded**. The integration branch may not be back at the recorded `rollbackSha`. This is a critical condition requiring manual intervention:

```bash
# Verify current state
git status
git log --oneline -5

# If the integration branch is in an unexpected state:
git checkout <integration-branch>
git reset --hard <rollbackSha-from-the-event-log>

# Where <rollbackSha-from-the-event-log> can be retrieved from the most recent
# merge.executed (completed run) or merge.rollback (rolled-back run) event:
exarchos_event query stream=<featureId> filter='{"type":"merge.rollback"}'
# fall back to merge.executed if no rollback was emitted.
# (merge.preflight does NOT carry rollbackSha — it runs before the rollback
# anchor is captured.)
```

If `rollbackError` is absent, the reset succeeded and the working tree is back to the recorded state — proceed to the conflict-resolution flow below.

### Resolve a `merge-failed` outcome

For merge conflicts (most common cause of `merge-failed`):

1. `git checkout <target-branch>` (the integration branch)
2. `git merge <source-branch>` to surface the conflicts in the working tree
3. Resolve conflicts manually
4. `git add` the resolved files
5. `git commit` to complete the merge
6. **Do not** re-dispatch `merge_orchestrate` — the merge is now done manually. Follow the repository's event-first commit-point invariant (#1109 §1): emit the `merge.executed` event FIRST, then update `mergeOrchestrator.phase` to `completed` via `mcp__exarchos__exarchos_workflow set`. Reversing the order risks a state-file/event-stream divergence if the event append fails after the state write.

```typescript
// Event first — the repository treats event append as the commit point.
mcp__exarchos__exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "merge.executed",
  data: {
    taskId: "<task-id>",
    sourceBranch: "<source>",
    targetBranch: "<target>",
    mergeSha: "<the-manual-merge-commit-sha>",
    rollbackSha: "<rollbackSha-from-prior-event>",
  },
}});

// Then update workflow state to reflect the terminal phase.
mcp__exarchos__exarchos_workflow({ action: "set", featureId: "<featureId>",
  updates: { mergeOrchestrator: {
    phase: "completed",
    sourceBranch: "<source>", targetBranch: "<target>",
    taskId: "<task-id>",
    mergeSha: "<the-manual-merge-commit-sha>",
    rollbackSha: "<rollbackSha-from-prior-event>",
  } } });
```

This is one of the rare cases where manual event emission is appropriate — the merge happened outside the orchestrator's control, but the event log must reflect the actual state for downstream projections to work.

For `timeout`: investigate disk / lock issues, then re-dispatch with `resume: true` to leverage the executor's idempotency.

For `verification-failed`: the verification adapter's specific failure determines the recovery path; consult its own documentation.

## `phase: 'completed'` with unexpected state

If the handler returned `completed` but the integration branch's HEAD doesn't match the recorded `mergeSha`:

1. Something between the merge and your inspection mutated the branch (concurrent push? local commit?).
2. Inspect `git reflog show <integration-branch>` to trace the divergence.
3. The orchestrator's guarantees end at the moment it returns success; no recovery is automatic for post-completion drift.

## Re-entering `merge-pending`

The HSM `merge-pending → delegate` exit fires when `mergeOrchestrator.phase` enters a terminal value. After a recovery flow that updates state to `completed` manually (e.g., the conflict-resolution flow above), the workflow naturally exits `merge-pending`. The next worktree-bearing `task.completed` re-enters `merge-pending` for the next task.

To force re-evaluation of the entry guard without waiting for a new `task.completed`, call `mcp__exarchos__exarchos_workflow reconcile` to rebuild state from the event log.
