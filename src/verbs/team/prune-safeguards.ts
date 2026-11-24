/**
 * The production recent-commits safeguard for `handlePruneStaleWorkflows`. It reads the
 * remote-tracking tip through the constrained Git reader.
 * The handler takes it as an injected dependency, so tests can use a stub and run no Git command.
 * One prune call shares one located checkout and one reader between the branch-activity read and the recent-commits read.
 * The safeguard reads no PR from a provider. The harness checks for an open PR before it starts a prune.
 */

import { exitedWithOne, locateObservational, type ObservationalCheckout, type Observation } from '../../utils/git-observer.js';
import { constrainedCommitId, observationalReader, type ConstrainedGitReads } from '../../utils/git-tree.js';

/**
 * The safeguard backend. It accepts an `undefined` branch name for a workflow
 * that has no branch yet.
 */
export interface PruneSafeguards {
  /** Returns true if `branchName` has commits inside the last `windowHours`. */
  hasRecentCommits: (branchName: string | undefined, windowHours: number) => Promise<boolean>;
}

/**
 * The Git observation of one prune call: the one reader source and the one located checkout of the working directory.
 * The checkout read runs once, at its first use.
 */
export interface PruneObservation {
  readonly reader: () => Promise<ConstrainedGitReads>;
  readonly checkout: () => Promise<Observation>;
}

/**
 * Create the Git observation of one prune call. A non-empty `gitPath` names the Git executable, else the reads use the process-wide Git path.
 * Nothing is memoized past the call, so a long-lived server sees a Git upgrade.
 */
export function pruneObservation(gitPath?: string): PruneObservation {
  const reader = observationalReader(gitPath);
  let checkout: Promise<Observation> | undefined;
  return {
    reader,
    checkout: () => (checkout ??= locateObservational(process.cwd(), reader)),
  };
}

/**
 * The commit time of one exact commit, as epoch seconds. The read passes `--no-show-signature`.
 * A read that fails, or an output that is not a positive integer, gives undefined.
 */
export async function observedCommitTime(located: ObservationalCheckout, commit: string): Promise<number | undefined> {
  try {
    const seconds = Number.parseInt((await located.reads.commitTime(located.gitDir, located.checkout, commit)).trim(), 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a branch name holds only alphanumerics, `/`, `_`, `.`, and `-`, and
 * no `..`. The ref read takes only these names.
 */
function isSafeBranchName(branch: string): boolean {
  return /^[A-Za-z0-9/_.\-]+$/.test(branch) && !branch.includes('..');
}

/**
 * Compares the commit time of the `refs/remotes/origin/<branchName>` tip with the last `windowHours`. The branch name is one argument.
 * No branch name and a missing remote-tracking ref return false.
 * An unsafe name, an unreadable checkout and a failed read return true, so the candidate stays with the active-branch reason.
 */
async function observedHasRecentCommits(
  observation: PruneObservation,
  branchName: string | undefined,
  windowHours: number,
): Promise<boolean> {
  if (!branchName) return false;
  if (!isSafeBranchName(branchName)) return true;
  const checkout = await observation.checkout();
  if (checkout.kind !== 'located') return true;
  const { located } = checkout;
  let tip: string;
  try {
    tip = constrainedCommitId((await located.reads.remoteCommit(located.gitDir, located.checkout, `refs/remotes/origin/${branchName}`)).trim());
  } catch (error) {
    return !exitedWithOne(error);
  }
  const seconds = await observedCommitTime(located, tip);
  if (seconds === undefined) return true;
  return seconds * 1000 >= Date.now() - windowHours * 3_600_000;
}

/**
 * Builds the production safeguard.
 *
 * @param observation - The Git observation of the prune call.
 */
export function defaultSafeguards(observation: PruneObservation = pruneObservation()): PruneSafeguards {
  return {
    hasRecentCommits: (branchName, windowHours) => observedHasRecentCommits(observation, branchName, windowHours),
  };
}
