/**
 * GC safety-ladder: a pure classifier for one worktree prune candidate.
 *
 * The worktree GC (`prune_worktrees`, DR-6) must never destroy un-saved work
 * (the Claude Code #55724 failure mode: 13 parallel agents, 8 lost uncommitted
 * work). The reclaim decision is therefore a **conservative, fail-closed
 * ladder** that deletes nothing it cannot prove is safe.
 *
 * This module is the ladder's pure core: given one candidate's **injected**
 * facts it returns a {@link PruneClassification}. It performs NO real git/fs
 * calls — every fact (projection state, in-use liveness, dirty flag, merge
 * ancestry, backing-gitdir presence, origin reachability) is supplied by the
 * orchestrating handler (Task 007), which owns the step-0 adopt-gate, the
 * per-worktree `integrationRef` lookup, and the real probes. Keeping the ladder
 * pure makes every classification deterministic and table-testable.
 *
 * **Eligibility is STATE-BASED, never time-based.** Only a worktree whose
 * projection state is `released` or `orphan` can be deletion-eligible; an
 * `adopted` or `reserved` worktree (and one with no adoption record at all) is
 * always skipped. There is deliberately **no mtime / recency heuristic** — a
 * long-running agent's worktree has a stale mtime yet is in active use, so mtime
 * is unsafe.
 */

// ============================================================
// Inputs
// ============================================================

/**
 * Lifecycle state of a worktree as reduced by the `worktrees@v1` projection.
 * Only `released` and `orphan` are deletion-eligible.
 */
export type WorktreeState = 'adopted' | 'reserved' | 'released' | 'orphan';

/**
 * One worktree prune candidate plus the injected facts the ladder classifies
 * over. Every field is supplied by the handler — the ladder computes none of
 * them — so classification is pure and deterministic.
 */
export interface PruneCandidate {
  /**
   * The candidate's `worktrees@v1` projection state, or `undefined` when there
   * is **no adoption record** for it. Absence is treated as unverifiable (and
   * therefore not deletable) — defense in depth behind the handler's step-0
   * adopt-gate, which should have reconciled every on-disk worktree first.
   */
  state?: WorktreeState;
  /**
   * Reserved-with-a-live-owner, per DR-3 ownership liveness (PID present AND
   * recorded create-time matches). Injected by the handler; `true` ⇒ the
   * worktree is actively in use and must never be deleted.
   */
  inUse: boolean;
  /**
   * Whether the working tree has changes, from
   * `git status --porcelain --untracked-files=all` — **untracked-aware**, so an
   * agent that created only untracked files is still protected. Injected.
   */
  dirty: boolean;
  /**
   * The integration ref this candidate's HEAD is merge-checked against, resolved
   * per-worktree by the handler from `synthesis.integrationBranch`. `null` when
   * the candidate is unattached (no `featureId`) or the branch is unresolvable —
   * which makes the candidate unverifiable (fail-closed skip). Injected.
   */
  integrationRef: string | null;
  /**
   * Result of `git merge-base --is-ancestor HEAD <integrationRef>` — `true` when
   * HEAD is already merged into the integration ref, `false` when it carries
   * unmerged work, and `null` when the probe could not run (e.g. an orphan with
   * no backing repo). Injected.
   */
  headAncestorOfIntegration: boolean | null;
  /**
   * Whether the backing repository's `.git` gitdir pointer resolves (stat). When
   * `false` the backing repo is gone and the worktree's content cannot be
   * verified — an **orphan**. Injected.
   */
  backingGitdirPresent: boolean;
  /**
   * Whether `origin` is reachable. When `false` merge ancestry cannot be trusted
   * and the candidate is left untouched (fail-closed). Injected.
   */
  originReachable: boolean;
}

// ============================================================
// Result
// ============================================================

/**
 * Why a candidate was skipped. A small, stable enum so the handler can **group**
 * skips by reason in its dry-run report (the "scannable skip reason" contract).
 */
export type PruneSkipReason =
  | 'no-adoption-record'
  | 'in-use'
  | 'active'
  | 'dirty'
  | 'unverifiable-integration-ref'
  | 'unmerged'
  | 'cannot-verify-merge'
  | 'origin-unreachable';

/**
 * Classification of a single prune candidate.
 *
 * - `skip` — not deletable; carries a scannable {@link PruneSkipReason}.
 * - `orphan-unverifiable` — the backing repo is missing, so the content cannot
 *   be verified; deletable only under an explicit orphan opt-in the **handler**
 *   passes (`--prune-orphans --yes`). The ladder never deletes it implicitly.
 * - `delete-eligible` — state-based, clean, merged, origin-reachable, backing
 *   repo present: safe to reclaim.
 */
export type PruneClassification =
  | { readonly action: 'skip'; readonly reason: PruneSkipReason }
  | { readonly action: 'orphan-unverifiable' }
  | { readonly action: 'delete-eligible' };

// ============================================================
// Pure decision
// ============================================================

const skip = (reason: PruneSkipReason): PruneClassification => ({ action: 'skip', reason });

/**
 * Classify one worktree prune candidate against the safety ladder.
 *
 * The rungs are evaluated in fail-closed order; the first that matches wins, so
 * the result errs toward **not** deleting:
 *
 * 1. No adoption record (`state` absent) ⇒ skip `no-adoption-record`
 *    (unverifiable — defense in depth behind the adopt-gate).
 * 2. In-use (reserved with a live owner) ⇒ skip `in-use`.
 * 3. Not deletion-eligible by state (`adopted` / `reserved`) ⇒ skip `active`.
 *    Only `released` / `orphan` proceed — **state-based, no mtime**.
 * 4. Dirty (untracked-aware) ⇒ skip `dirty`.
 * 5. `integrationRef` null ⇒ skip `unverifiable-integration-ref` (fail-closed).
 * 6. HEAD not an ancestor of the integration ref ⇒ skip `unmerged`.
 * 7. Backing `.git` gitdir missing ⇒ `orphan-unverifiable` (handler-gated
 *    deletion only).
 * 8. Merge ancestry uncomputable (`null`) while the backing repo is PRESENT ⇒
 *    skip `cannot-verify-merge` (fail-closed — we could not prove HEAD is merged).
 * 9. Origin unreachable ⇒ skip `origin-unreachable` (fail-closed).
 * 10. Otherwise ⇒ `delete-eligible`.
 *
 * Pure over its {@link PruneCandidate}; performs no git/fs/OS access.
 */
export function classifyPruneCandidate(candidate: PruneCandidate): PruneClassification {
  // 1. No adoption record at all -> unverifiable -> never deletable.
  if (candidate.state === undefined) {
    return skip('no-adoption-record');
  }

  // 2. Reserved with a live owner (DR-3) -> actively in use.
  if (candidate.inUse) {
    return skip('in-use');
  }

  // 3. State-based eligibility: only `released`/`orphan` are deletion-eligible.
  //    `adopted` (e.g. a just-created harness dir) and `reserved` with a
  //    non-live owner that has not yet been reconciled are both skipped as
  //    active. No mtime/recency logic — a stale mtime is not an idle signal.
  if (candidate.state === 'adopted' || candidate.state === 'reserved') {
    return skip('active');
  }

  // 4. Uncommitted work, including untracked-only changes -> never delete.
  if (candidate.dirty) {
    return skip('dirty');
  }

  // 5. No resolvable integration ref -> cannot verify merge state -> fail closed.
  if (candidate.integrationRef === null) {
    return skip('unverifiable-integration-ref');
  }

  // 6. HEAD carries work not merged into the integration ref -> skip unmerged.
  //    `null` (the merge probe could not run, e.g. an orphan) is NOT treated as
  //    unmerged here; it threads through to the orphan rung (rung 7) or, when the
  //    backing repo is present, to the fail-closed rung 8 below.
  if (candidate.headAncestorOfIntegration === false) {
    return skip('unmerged');
  }

  // 7. Backing repo gone -> content unverifiable -> orphan (handler-gated delete).
  if (!candidate.backingGitdirPresent) {
    return { action: 'orphan-unverifiable' };
  }

  // 8. Backing repo PRESENT but the merge probe was uncomputable (`null`) -> we
  //    could not prove HEAD is merged into the integration ref -> fail closed.
  //    Without this rung a `null` ancestry with a present backing repo fell
  //    through to `delete-eligible`, deleting a worktree of UNVERIFIED merge
  //    state (data loss). A merge state that cannot be verified is never deleted.
  if (candidate.headAncestorOfIntegration === null) {
    return skip('cannot-verify-merge');
  }

  // 9. Cannot reach origin -> cannot trust merge ancestry -> fail closed.
  if (!candidate.originReachable) {
    return skip('origin-unreachable');
  }

  // 10. Released/orphan-state, clean, merged, origin-reachable, backing present.
  return { action: 'delete-eligible' };
}
