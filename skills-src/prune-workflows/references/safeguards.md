# Prune Safeguards

The `prune_stale_workflows` orchestrate action runs two safeguards on each
candidate before it will actually cancel the workflow. Both must pass for
the candidate to be pruned, unless the caller passes `force: true` to
bypass them.

## Safeguard 1: `hasOpenPR`

Checks whether there's an open pull request targeting the workflow's
branch. Implementation: `gh pr list --state open --head <branchName>` —
if the list is non-empty, the safeguard fails and the candidate is
skipped with reason `open-pr`.

Rationale: an open PR means human work is still in-flight on this feature.
Cancelling the workflow would orphan the PR from its event-sourced state,
which makes it invisible to `exarchos_view` and breaks auto-merge gates.
We refuse to prune workflows with open PRs by default.

## Safeguard 2: `hasRecentCommits` (user-facing: `active-branch`)

Checks whether any commits landed on the workflow's branch within a
24-hour window. Implementation: `git log --since="24 hours ago"
<branchName>` — if the output is non-empty, the safeguard fails and the
candidate is skipped with reason `active-branch`.

Rationale: commits on the branch mean the workflow isn't actually stale,
it just missed the last event checkpoint. The underlying branch is the
ground truth for "is this work still alive?" — if someone is committing,
we don't care what the checkpoint timestamp says.

The window is locked at 24 hours for v1. It's exposed as a module
constant (`RECENT_COMMITS_WINDOW_HOURS` in `prune-stale-workflows.ts`)
so tests can see the contract, but it's not yet configurable through
the public handler args.

## Short-circuit: missing `branchName`

If the workflow state has no top-level `branchName` field, both
safeguards are skipped entirely (they have nothing to look up). The
candidate still proceeds to cancel. This is safe because a workflow
without a branch can't have an open PR or recent commits by definition.

## `force: true` bypass semantics

Passing `force: true` skips safeguard evaluation for every candidate.
The handler still does everything else — the cancel, the event emission,
the audit trail — but `hasOpenPR` and `hasRecentCommits` are never
called.

Every `workflow.pruned` event emitted during a `force: true` run carries
a `skippedSafeguards: ['open-pr', 'active-branch']` marker on its payload.
This makes forced prunes distinguishable in the audit stream from
safeguard-approved ones, so operators reviewing the event log can see
exactly which workflows were cancelled despite having open PRs or active
branches.

The marker list is intentionally hardcoded to *all* safeguards, not just
the ones that would have failed. Running `force: true` is a blanket
"I know what I'm doing" override — we want the audit trail to reflect
that the user chose to bypass the whole safeguard layer, not to imply
selective bypassing.

## See also

- `servers/exarchos-mcp/src/orchestrate/prune-safeguards.ts` — the
  default implementations (gh/git backends) and the `PruneSafeguards`
  interface for DI.
- `servers/exarchos-mcp/src/orchestrate/prune-stale-workflows.ts` —
  the handler that composes safeguards with selection and cancel.
