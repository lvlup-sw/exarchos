import { describe, it, expect } from 'vitest';
import {
  classifyPruneCandidate,
  type PruneCandidate,
  type PruneClassification,
} from './prune-ladder.js';

/**
 * A worktree that passes every safety rung: `released` state, clean tree,
 * merged into a resolvable integration ref, backing repo present, origin
 * reachable. Each test overrides exactly the field(s) under exercise so the
 * single deviation drives the classification.
 */
function eligibleCandidate(overrides: Partial<PruneCandidate> = {}): PruneCandidate {
  return {
    state: 'released',
    inUse: false,
    dirty: false,
    integrationRef: 'main',
    headAncestorOfIntegration: true,
    backingGitdirPresent: true,
    originReachable: true,
    ...overrides,
  };
}

describe('classifyPruneCandidate', () => {
  it('PruneLadder_ReservedLiveOwner_SkippedInUse', () => {
    // Reserved with a live owner (DR-3): actively in use -> never deleted.
    const result = classifyPruneCandidate(
      eligibleCandidate({ state: 'reserved', inUse: true }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'in-use' });
  });

  it('PruneLadder_UntrackedOnlyChanges_SkippedDirty', () => {
    // `dirty` reflects `git status --porcelain --untracked-files=all` — untracked-
    // aware — so a worktree whose ONLY changes are untracked files is still
    // protected (the #55724 preserve-uncommitted guarantee).
    const result = classifyPruneCandidate(eligibleCandidate({ dirty: true }));
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'dirty' });
  });

  it('PruneLadder_HeadNotAncestorOfInjectedIntegrationRef_SkippedUnmerged', () => {
    // HEAD is NOT an ancestor of the injected integration ref -> it carries
    // unmerged work -> skip, do not delete.
    const result = classifyPruneCandidate(
      eligibleCandidate({ integrationRef: 'feat/wlm', headAncestorOfIntegration: false }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'unmerged' });
  });

  it('PruneLadder_NullIntegrationRef_TreatedUnverifiable_FailClosed', () => {
    // No resolvable integration ref (unattached / unresolvable branch) -> merge
    // state cannot be verified -> fail closed (skip), never delete.
    const result = classifyPruneCandidate(
      eligibleCandidate({ integrationRef: null, headAncestorOfIntegration: null }),
    );
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'unverifiable-integration-ref',
    });
  });

  it('PruneLadder_NoAdoptionRecord_ClassifiedUnverifiable_NotDeletable', () => {
    // No adoption record (state absent): defense in depth behind the handler's
    // step-0 adopt-gate -> unverifiable -> not deletable.
    const result = classifyPruneCandidate(eligibleCandidate({ state: undefined }));
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'no-adoption-record',
    });
  });

  it('PruneLadder_BackingGitdirMissing_ClassifiedOrphan', () => {
    // Backing `.git` gitdir pointer is gone -> content cannot be verified (the
    // merge probe can't run either, hence null) -> orphan, deletable only under
    // the handler's explicit orphan opt-in, never implicitly.
    const result = classifyPruneCandidate(
      eligibleCandidate({
        state: 'orphan',
        backingGitdirPresent: false,
        headAncestorOfIntegration: null,
      }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'orphan-unverifiable' });
  });

  it('PruneLadder_NullHeadAncestorWithBacking_FailsClosed', () => {
    // The merge probe was UNCOMPUTABLE (`null`) while the backing repo is
    // PRESENT (so the orphan rung does not catch it). Merge state is therefore
    // unverified — we could not prove HEAD is merged — so the candidate must
    // fail closed (skip), NOT fall through to `delete-eligible`. This is the
    // destructive hole: a `null` ancestry with a live backing repo previously
    // reached deletion.
    const result = classifyPruneCandidate(
      eligibleCandidate({
        backingGitdirPresent: true,
        headAncestorOfIntegration: null,
      }),
    );
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'cannot-verify-merge',
    });
  });

  it('PruneLadder_OriginUnreachable_LeftUntouchedFailClosed', () => {
    // Origin unreachable -> merge ancestry cannot be trusted -> fail closed,
    // left untouched.
    const result = classifyPruneCandidate(eligibleCandidate({ originReachable: false }));
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'origin-unreachable',
    });
  });

  it('PruneLadder_ReleasedCleanMergedReachable_DeleteEligible', () => {
    // The positive path: released state, clean tree, merged into a resolvable
    // ref, backing repo present, origin reachable -> safe to reclaim.
    const result = classifyPruneCandidate(eligibleCandidate());
    expect(result).toEqual<PruneClassification>({ action: 'delete-eligible' });
  });

  it('PruneLadder_AdoptedNeverReleased_SkippedActive_NotMtimeBased', () => {
    // An `adopted` worktree (e.g. a just-created harness dir, or a long-running
    // agent's worktree with a stale mtime) is NOT deletion-eligible — eligibility
    // is state-based, never mtime-based. Reproduces + blocks the #55724 shape at
    // the pure layer.
    const result = classifyPruneCandidate(eligibleCandidate({ state: 'adopted' }));
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'active' });
  });

  it('PruneLadder_ReservedDeadOwnerNotYetReconciled_SkippedActive', () => {
    // Reserved but the owner is not live (inUse=false) and no reconcile fold has
    // collapsed it to `released` yet -> still not deletion-eligible by state.
    // Defense in depth: a reserved entry is never deleted regardless of liveness.
    const result = classifyPruneCandidate(
      eligibleCandidate({ state: 'reserved', inUse: false }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'active' });
  });

  it('PruneLadder_InUseTakesPrecedenceOverDirtyAndUnmerged', () => {
    // Ladder ordering: an in-use worktree is skipped as in-use even when other
    // disqualifiers (dirty, unmerged) are also present — the most-protective
    // reason wins and the worktree is never a delete candidate.
    const result = classifyPruneCandidate(
      eligibleCandidate({
        state: 'reserved',
        inUse: true,
        dirty: true,
        headAncestorOfIntegration: false,
      }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'in-use' });
  });
});
