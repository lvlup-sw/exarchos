// Tests for `defaultSafeguards`. The safeguard reads branch activity through the injected Git
// observation, and it reads no PR. The harness owns the open-PR check before a prune.

import { describe, it, expect, vi } from 'vitest';
import { defaultSafeguards, type PruneObservation } from '../../../../src/verbs/team/prune-safeguards.js';
import type { Observation } from '../../../../src/utils/git-observer.js';

/** A Git observation whose checkout read gives `checkout`. The reader source refuses, so no test starts Git. */
function observation(checkout: Observation) {
  const read = vi.fn(async (): Promise<Observation> => checkout);
  const reader = vi.fn(async () => { throw new Error('no reader in this test'); });
  const value: PruneObservation = { reader, checkout: read };
  return { value, read, reader };
}

describe('defaultSafeguards', () => {
  /** The production bundle holds only the recent-commits safeguard. */
  it('DefaultSafeguards_HoldsNoOpenPrCheck', () => {
    const { value } = observation({ kind: 'unreadable', reason: 'not used' });

    expect(Object.keys(defaultSafeguards(value))).toEqual(['hasRecentCommits']);
  });

  /** A workflow with no branch has no recent commits, and the safeguard reads nothing. */
  it('HasRecentCommits_UndefinedBranch_ReturnsFalseWithoutAnyRead', async () => {
    const { value, read, reader } = observation({ kind: 'unreadable', reason: 'not used' });

    expect(await defaultSafeguards(value).hasRecentCommits(undefined, 24)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  /** An unsafe branch name keeps the candidate, and the safeguard reads nothing. */
  it('HasRecentCommits_UnsafeBranchName_KeepsCandidateWithoutAnyRead', async () => {
    const { value, read } = observation({ kind: 'unreadable', reason: 'not used' });

    expect(await defaultSafeguards(value).hasRecentCommits('branch; rm -rf /', 24)).toBe(true);
    expect(await defaultSafeguards(value).hasRecentCommits('a/../b', 24)).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  /** An unreadable checkout keeps the candidate with the active-branch reason. */
  it('HasRecentCommits_UnreadableCheckout_KeepsCandidate', async () => {
    const { value, read } = observation({ kind: 'unreadable', reason: 'no Git' });

    expect(await defaultSafeguards(value).hasRecentCommits('feat/test', 24)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
