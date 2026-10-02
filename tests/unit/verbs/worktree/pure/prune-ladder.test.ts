import { describe, it, expect } from 'vitest';
import {
  classifyPruneCandidate,
  type PruneCandidate,
  type PruneClassification,
} from '../../../../../src/verbs/worktree/pure/prune-ladder.js';

/**
 * A candidate that passes every rung: `released`, clean, merged into a
 * resolvable integration ref, with its backing repo and a reachable origin.
 * Each test overrides only the fields under test.
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
    const result = classifyPruneCandidate(
      eligibleCandidate({ state: 'reserved', inUse: true }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'in-use' });
  });

  /**
   * The `dirty` fact comes from `git status --porcelain --untracked-files=all`.
   * So a worktree with only untracked changes is dirty and stays.
   */
  it('PruneLadder_UntrackedOnlyChanges_SkippedDirty', () => {
    const result = classifyPruneCandidate(eligibleCandidate({ dirty: true }));
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'dirty' });
  });

  it('PruneLadder_HeadNotAncestorOfInjectedIntegrationRef_SkippedUnmerged', () => {
    const result = classifyPruneCandidate(
      eligibleCandidate({ integrationRef: 'feat/wlm', headAncestorOfIntegration: false }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'unmerged' });
  });

  /** With no resolvable integration ref, the merge state cannot be verified, so the ladder skips. */
  it('PruneLadder_NullIntegrationRef_TreatedUnverifiable_FailClosed', () => {
    const result = classifyPruneCandidate(
      eligibleCandidate({ integrationRef: null, headAncestorOfIntegration: null }),
    );
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'unverifiable-integration-ref',
    });
  });

  /** An absent state means no adoption record. This rung backs up the adopt gate of the handler. */
  it('PruneLadder_NoAdoptionRecord_ClassifiedUnverifiable_NotDeletable', () => {
    const result = classifyPruneCandidate(eligibleCandidate({ state: undefined }));
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'no-adoption-record',
    });
  });

  /**
   * With no backing gitdir, the content and the merge state cannot be verified.
   * The candidate is an orphan, which the handler deletes only on an explicit opt-in.
   */
  it('PruneLadder_BackingGitdirMissing_ClassifiedOrphan', () => {
    const result = classifyPruneCandidate(
      eligibleCandidate({
        state: 'orphan',
        backingGitdirPresent: false,
        headAncestorOfIntegration: null,
      }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'orphan-unverifiable' });
  });

  /**
   * A `null` ancestry with the backing repo present does not reach the orphan
   * rung. The merge is not proven, so the candidate must skip and not become
   * `delete-eligible`.
   */
  it('PruneLadder_NullHeadAncestorWithBacking_FailsClosed', () => {
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

  /** With an unreachable origin, the ladder does not trust the merge ancestry. */
  it('PruneLadder_OriginUnreachable_LeftUntouchedFailClosed', () => {
    const result = classifyPruneCandidate(eligibleCandidate({ originReachable: false }));
    expect(result).toEqual<PruneClassification>({
      action: 'skip',
      reason: 'origin-unreachable',
    });
  });

  it('PruneLadder_ReleasedCleanMergedReachable_DeleteEligible', () => {
    const result = classifyPruneCandidate(eligibleCandidate());
    expect(result).toEqual<PruneClassification>({ action: 'delete-eligible' });
  });

  /**
   * Eligibility comes from the state, not the mtime. An `adopted` worktree is
   * not eligible, even when a long-running agent leaves it with a stale mtime.
   */
  it('PruneLadder_AdoptedNeverReleased_SkippedActive_NotMtimeBased', () => {
    const result = classifyPruneCandidate(eligibleCandidate({ state: 'adopted' }));
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'active' });
  });

  /**
   * A `reserved` entry with an owner that is not live stays until a reconcile
   * changes it to `released`. The ladder does not delete a `reserved` entry.
   */
  it('PruneLadder_ReservedDeadOwnerNotYetReconciled_SkippedActive', () => {
    const result = classifyPruneCandidate(
      eligibleCandidate({ state: 'reserved', inUse: false }),
    );
    expect(result).toEqual<PruneClassification>({ action: 'skip', reason: 'active' });
  });

  /** The rungs run in order, so `in-use` wins over `dirty` and `unmerged`. */
  it('PruneLadder_InUseTakesPrecedenceOverDirtyAndUnmerged', () => {
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
