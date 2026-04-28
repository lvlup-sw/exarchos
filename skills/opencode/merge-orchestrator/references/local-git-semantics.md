# Local-Git Semantics

This reference explains why `merge_orchestrate` performs a local `git merge` rather than calling the VCS provider — and why that distinction matters for the rollback contract.

## The model

`merge_orchestrate` is the SDLC handoff for landing a subagent's worktree branch onto the integration branch in the **main worktree**. Every operation in the orchestrator is a local-git operation:

- **Preflight** — `git status --porcelain`, `git diff --cached --quiet`, `git rev-parse --abbrev-ref HEAD`, `git merge-base --is-ancestor`, `git rev-parse --git-dir`. All run against local refs.
- **Rollback anchor** — `git rev-parse HEAD` captures the integration branch's tip before the merge.
- **Merge** — `git merge --no-ff` / `--squash` / rebase + ff-only against local branches, in the main worktree's working directory.
- **Rollback execution** — `git reset --hard <rollbackSha>` restores the integration branch's tip if the merge or post-merge verification fails.

The integration branch may eventually be pushed to a remote and merged into `main` via a PR — that is a separate concern handled by `merge_pr` in the synthesize phase, when the full feature is ready for human review.

## Why not call the VCS provider here?

An earlier implementation of this orchestrator routed the merge through `provider.mergePr(prId, strategy)` — a remote API call (GitHub / GitLab / Azure DevOps). That created an architectural mismatch (#1194):

| What runs locally | What runs remotely |
|-------------------|--------------------|
| Preflight (drift, ancestry, branch protection, worktree assertion) | (nothing) |
| Rollback anchor `git rev-parse HEAD` | (nothing) |
| Rollback `git reset --hard` | (nothing) |
| ❌ Merge | ✅ Merge (server-side via VCS API) |

A server-side merge does not move local `HEAD`. So the recorded `rollbackSha` corresponded to a local ref the merge never touched, and `git reset --hard <rollbackSha>` was a **no-op** in production. Worse, a server-side merge that succeeded with a post-merge verification failure left a local/remote divergence with no automatic recovery.

The fix was structural: align the merge primitive with the rollback primitive. Both are now local-git, and the rollback is a real undo operation.

## Why the integration branch and not main?

The integration branch is the long-lived collection point for a feature's subagent work. It's where the `delegate` phase composes parallel worktree branches into a single coherent state for review. Landing a subagent branch on the integration branch is an internal coordination operation — the operator has not yet asked for human review, and the work has not yet earned a place on `main`.

Pushing to `main` happens later, via `merge_pr`, against a PR opened from the integration branch by the synthesize-phase shepherd loop. By then, the integration branch's content has been reviewed (`review` phase) and prepared for the wider audience.

## Branch precondition

The local-git merge adapter (`orchestrate/local-git-merge.ts`) checks out the target branch defensively at the top of every invocation. This makes the precondition explicit: the orchestrator expects to be in the main worktree, on (or able to switch to) the target branch. A wrong-state caller surfaces as a clear `git checkout` failure rather than silent misbehavior.

The preflight composer separately asserts main-worktree (`git rev-parse --git-dir` shape) — this catches the case of an operator running `merge_orchestrate` from inside a subagent worktree, which would otherwise corrupt that worktree's state.

## Strategy semantics

| Strategy | Effect on integration branch | Effect on source branch |
|----------|------------------------------|-------------------------|
| `merge`  | New merge commit with two parents (target's previous HEAD + source's HEAD) | Unchanged |
| `squash` | New single-parent commit containing source's diff | Unchanged |
| `rebase` | Source's commits replayed atop target; integration branch ff-merges to source's new tip — linear history, no merge commit | History rewritten (source's commits get new SHAs) |

`rebase` rewrites the source branch's history. For ephemeral subagent branches (created by `delegate`, deleted after merge), this is fine — the branch has no consumers other than the orchestrator. Don't pick `rebase` for source branches that are pushed and shared.

## What the rollback actually undoes

`git reset --hard <rollbackSha>` on the integration branch restores `HEAD` to the recorded SHA. This **does** undo:

- A merge commit created by `--no-ff`
- A squash commit created by `--squash` + `git commit`
- A fast-forward advance from a `rebase` strategy (target moves back to its pre-rebase tip)

The reset **does not** undo:

- The source branch's history rewrite from a `rebase` strategy. The source branch keeps the rebased commits; only the integration branch's reference returns to its prior state. This is acceptable in the SDLC model because the source branch is ephemeral — it gets deleted after the merge cycle either way. If you need to inspect the original source commits, the reflog still has them until expiry.
