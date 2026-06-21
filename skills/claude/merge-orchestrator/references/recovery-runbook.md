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

## `phase: 'rolled-back'` — merge attempted, recovered

> The phase value is still `rolled-back` — a load-bearing state token intentionally unchanged by the #1306 recovery reframe. The *behavior* it describes is recovery to the recorded recovery point.

The executor recorded the recovery point, attempted the merge, the merge or post-merge verification failed, and the INV-14 recovery ladder (`git merge --abort` → `git reset --keep <recoveryPointSha>`, never `--hard`) ran. The integration branch is rewound to its pre-merge state.

### Diagnose

Check `data.reason`:

| `reason` | Meaning | Typical cause |
|----------|---------|---------------|
| `merge-failed` | Git merge command exited non-zero | Merge conflict, missing source branch, ref corruption |
| `verification-failed` | Post-merge verification step rejected the merge | Custom verification adapter detected a problem (rare in default config) |
| `timeout` | Underlying operation exceeded the 120s timeout | Repo size, slow disk, lock contention |

### Then check `data.recoveryError` / `data.recoveryErrorDetail`

If present, the recovery itself failed and **the working tree is stranded**. The integration branch may not be back at the recorded recovery point. `data.recoveryError` is the INV-14 discriminator (`reset-keep-blocked` / `reset-failed` / `unexpected-mid-merge-drift`) and `data.recoveryErrorDetail` is the human-readable detail. This is a critical condition requiring manual intervention:

```bash
# Verify current state
git status
git log --oneline -5

# If the integration branch is in an unexpected state, rewind it to the
# recovery point. Prefer --keep (refuse-to-discard); use --hard only if you
# have already confirmed there is no uncommitted work you need to preserve.
git checkout <integration-branch>
git reset --keep <recoveryPointSha-from-the-event-log>

# Where <recoveryPointSha-from-the-event-log> can be retrieved from the most
# recent recovery event. Prefer the canonical merge.recovered (#1306), which
# carries recoveryPointSha; fall back to the legacy merge.rollback, whose
# rollbackSha wire field holds the same value during the deprecation window:
exarchos_event query stream=<featureId> filter='{"type":"merge.recovered"}'
# fall back to merge.rollback, then merge.executed, if no recovery event exists.
# (merge.preflight does NOT carry the recovery point — it runs before the
# recovery point is captured.)
```

If neither `recoveryError` nor `recoveryErrorDetail` is present, the recovery succeeded and the working tree is back to the recorded state — proceed to the conflict-resolution flow below.

### Resolve a `merge-failed` outcome

For merge conflicts (most common cause of `merge-failed`):

1. `git checkout <target-branch>` (the integration branch)
2. `git merge <source-branch>` to surface the conflicts in the working tree
3. Resolve conflicts manually
4. `git add` the resolved files
5. `git commit` to complete the merge
6. **Do not** re-dispatch `merge_orchestrate` — the merge is now done manually. Follow the repository's event-first commit-point invariant (#1109 §1): emit the `merge.executed` event FIRST, then update `mergeOrchestrator.phase` to `completed` via `mcp__plugin_exarchos_exarchos__exarchos_workflow update`. Reversing the order risks a state-file/event-stream divergence if the event append fails after the state write.

```typescript
// Event first — the repository treats event append as the commit point.
// Use the same `strategy` the original dispatch was invoked with so the
// projected state matches what the auto-emit path would have produced.
// NOTE: the merge.executed EVENT keeps the legacy `rollbackSha` wire field
// during the v2.11.x deprecation window — supply the recovery-point SHA there.
mcp__plugin_exarchos_exarchos__exarchos_event({ action: "append", stream: "<featureId>", event: {
  type: "merge.executed",
  data: {
    taskId: "<task-id>",
    sourceBranch: "<source>",
    targetBranch: "<target>",
    strategy: "<squash|merge|rebase>",
    mergeSha: "<the-manual-merge-commit-sha>",
    rollbackSha: "<recovery-point-sha-from-prior-event>",
  },
}});

// Then update workflow state to reflect the terminal phase.
// The mergeOrchestrator STATE field is `recoveryPointSha` (renamed from
// `rollbackSha` in #1306 — the state file follows the canonical recovery frame
// even while the legacy event wire field above does not yet).
mcp__plugin_exarchos_exarchos__exarchos_workflow({ action: "update", featureId: "<featureId>",
  updates: { mergeOrchestrator: {
    phase: "completed",
    sourceBranch: "<source>", targetBranch: "<target>",
    taskId: "<task-id>",
    strategy: "<squash|merge|rebase>",
    mergeSha: "<the-manual-merge-commit-sha>",
    recoveryPointSha: "<recovery-point-sha-from-prior-event>",
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

To force re-evaluation of the entry guard without waiting for a new `task.completed`, call `mcp__plugin_exarchos_exarchos__exarchos_workflow reconcile` to rebuild state from the event log.
