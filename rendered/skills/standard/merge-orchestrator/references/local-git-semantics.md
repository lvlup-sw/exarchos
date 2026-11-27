# Local-Git Semantics

This reference explains why a landing is a local `git merge` that the coordinator runs through its harness, and why it does not call the VCS provider.

## The model

The integration branch collects the accepted work of a feature. A landing adds one accepted head commit to it. Every step is a local git operation in the integration worktree:

- **Ancestry check** — `git merge-base --is-ancestor <accepted head> <integration-branch>`. Exit 0 skips the landing, exit 1 lands, and any other exit stops.
- **Clean-tree check** — `git rev-parse --abbrev-ref HEAD` names the integration branch, and `git status --porcelain` prints nothing.
- **Rollback commit** — `git rev-parse <integration-branch>` captures the tip before the landing.
- **Landing** — `git merge --ff-only <accepted head commit>`, or `git merge --no-ff <accepted head commit>` when the integration branch advanced.

The coordinator runs these steps with the git of its harness. No step calls an Exarchos action to merge.

The integration branch is later pushed and merged into `main` through a pull request, in the synthesize phase. The coordinator creates and merges that pull request through its harness, outside governance.

## Why not call the VCS provider here?

An earlier design merged through the API of the VCS provider (GitHub, GitLab or Azure DevOps). A server-side merge does not move the local integration branch. Settlement, `prepare` and the verifier read local commits: they need each accepted head as an ancestor of the integration tip and of the fork of each dependent. A remote merge leaves those local checks with nothing to read. A squash on the server also makes a commit that settlement never judged.

| What runs locally | What runs remotely |
|-------------------|--------------------|
| Ancestry and clean-tree checks | (nothing) |
| Rollback commit `git rev-parse` | (nothing) |
| Landing `git merge` | (nothing) |
| (nothing) | The pull request of the synthesize phase, through the harness |

## Why the integration branch and not main?

The integration branch is the long-lived collection point for the subagent work of a feature. The `delegate` phase lands each accepted worktree head on it, so the review reads one coherent state. A landing on the integration branch is an internal coordination step: the operator has not yet asked for human review, and the work has not yet earned a place on `main`.

The work reaches `main` later, through the pull request that the coordinator opens from the integration branch in the synthesize phase. By then the `review` phase has judged the integration branch.

## Landing shapes

| Shape | Effect on the integration branch | When |
|-------|----------------------------------|------|
| Fast-forward | The branch moves to the accepted head, with no new commit | The normal landing: the accepted head holds the integration tip |
| Merge commit | A new commit with two parents: the earlier tip and the accepted head | The integration branch advanced after the base of the task |

Both shapes keep the accepted head reachable from the integration tip.

Never rebase or squash an accepted head. Both make a new commit that settlement never judged, and the accepted head stops being an ancestor of the integration tip. A dependent then forks from a commit that does not hold its blocker head, and `settle` refuses it. A squash or a rebase appears only as an out-of-band case: a blocker that already landed that way. That case needs the recovery row of the skill (Step 4), and the row satisfies `prepare` only.

## What a failed landing leaves

- A refused fast-forward changes nothing.
- A conflicted merge commit leaves a merge in progress. `git merge --abort` makes no commit and restores the branch to its tip before the merge. No step resets the branch.
- The INV-14 rule holds: never `git reset --hard`. The earlier merge executor rewound a failed merge with `git merge --abort`, then `git reset --keep <recoveryPointSha>`. `--keep` refuses to clobber uncommitted local changes, where `--hard` silently destroys them. Its recovery rows stay readable, and `recovery-runbook.md` explains them.
