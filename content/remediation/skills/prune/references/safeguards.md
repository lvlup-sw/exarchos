# Prune Safeguards

The `prune_stale_workflows` orchestrate action runs one safeguard on each
candidate before it cancels the workflow. The candidate is pruned only when
the safeguard passes, unless the caller passes `force: true` to bypass it.

## Open PR check: the harness owns it

Exarchos reads no PR, so the action does not check for an open pull request.
Before you apply a prune, read the open PRs of each candidate branch with
your own tools (for example `gh pr list --state open --head <branchName>`).

Rationale: an open PR means that work on the feature is still in progress.
If you cancel the workflow, the PR loses its event-sourced state. Apply mode
prunes every candidate, so do not apply while a candidate has an open PR
unless the user accepts that it will be cancelled.

## Safeguard: `hasRecentCommits` (user-facing: `active-branch`)

Checks whether any commits landed on the workflow's branch within a
24-hour window. Implementation: the commit time of the
`refs/remotes/origin/<branchName>` tip — if it is inside the window, the
safeguard fails and the candidate is skipped with reason `active-branch`.

Rationale: commits on the branch mean the workflow isn't actually stale,
it just missed the last event checkpoint. The underlying branch is the
ground truth for "is this work still alive?" — if someone is committing,
we don't care what the checkpoint timestamp says.

The window is locked at 24 hours for v1. It's exposed as a module
constant (`RECENT_COMMITS_WINDOW_HOURS` in `prune-stale-workflows.ts`)
so tests can see the contract, but it's not yet configurable through
the public handler args.

## Short-circuit: missing `branchName`

If the workflow state has no top-level `branchName` field, the safeguard
is skipped (it has nothing to look up). The candidate still proceeds to
cancel. This is safe because a workflow without a branch has no recent
commits by definition.

## `force: true` bypass semantics

Passing `force: true` skips safeguard evaluation for every candidate.
The handler still does everything else — the cancel, the event emission,
the audit trail — but `hasRecentCommits` is never called.

Every `workflow.pruned` event emitted during a `force: true` run carries
a `skippedSafeguards: ['active-branch']` marker on its payload. This makes
forced prunes distinguishable in the audit stream from safeguard-approved
ones. Events from older versions carry `['open-pr', 'active-branch']`.

The marker list is intentionally hardcoded to *all* safeguards, not just
the ones that would have failed. Running `force: true` is a blanket
"I know what I'm doing" override — we want the audit trail to reflect
that the user chose to bypass the whole safeguard layer, not to imply
selective bypassing.

## See also

- `src/verbs/team/prune-safeguards.ts` — the default implementation (the
  Git backend) and the `PruneSafeguards` interface for DI.
- `src/verbs/team/prune-stale-workflows.ts` — the handler that composes
  the safeguard with selection and cancel.
