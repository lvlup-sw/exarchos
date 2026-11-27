/**
 * Production open-PR and recent-commits safeguards for
 * `handlePruneStaleWorkflows`. The open-PR check uses a `VcsProvider`, and the
 * recent-commits check reads the remote-tracking tip through the constrained Git reader.
 * The handler takes them as injected dependencies, so tests can use stubs and run no git or VCS commands.
 * One prune call shares one located checkout and one reader between the branch-activity read, the recent-commits read and detection.
 */

import type { VcsProvider } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import { exitedWithOne, locateObservational, type ObservationalCheckout, type Observation } from '../../utils/git-observer.js';
import { constrainedCommitId, observationalReader, type ConstrainedGitReads } from '../../utils/git-tree.js';

/**
 * Safeguard backends. Both accept an `undefined` branch name for a workflow
 * that has no branch yet.
 */
export interface PruneSafeguards {
  /** Returns true if there is an OPEN pull request whose head is `branchName`. */
  hasOpenPR: (featureId: string, branchName: string | undefined) => Promise<boolean>;
  /** Returns true if `branchName` has commits inside the last `windowHours`. */
  hasRecentCommits: (branchName: string | undefined, windowHours: number) => Promise<boolean>;
}

/**
 * The Git observation of one prune call: the selected connector Git path, the one reader source, and the one located checkout of the working directory.
 * The checkout read runs once, at its first use.
 */
export interface PruneObservation {
  readonly gitPath?: string;
  readonly reader: () => Promise<ConstrainedGitReads>;
  readonly checkout: () => Promise<Observation>;
}

/**
 * Create the Git observation of one prune call. A non-empty `gitPath` is the connector Git path, else the reads use the process-wide Git path.
 * Nothing is memoized past the call, so a long-lived server sees a Git upgrade.
 */
export function pruneObservation(gitPath?: string): PruneObservation {
  const reader = observationalReader(gitPath);
  let checkout: Promise<Observation> | undefined;
  return {
    ...(gitPath === undefined || gitPath === '' ? {} : { gitPath }),
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
 * no `..`. The provider query and the ref read take only these names.
 */
function isSafeBranchName(branch: string): boolean {
  return /^[A-Za-z0-9/_.\-]+$/.test(branch) && !branch.includes('..');
}

/**
 * Asks the provider for an open PR with `branchName` as its head. A provider
 * failure returns false, so the prune can continue.
 */
async function defaultHasOpenPR(
  provider: VcsProvider,
  _featureId: string,
  branchName: string | undefined,
): Promise<boolean> {
  if (!branchName || !isSafeBranchName(branchName)) return false;
  try {
    const prs = await provider.listPrs({ head: branchName, state: 'open' });
    return prs.length > 0;
  } catch {
    return false;
  }
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
 * Builds the production safeguards. When the caller passes a provider other
 * than GitHub, the open-PR check always returns false.
 *
 * @param provider - An optional `VcsProvider`. Without it, the first open-PR check calls `createVcsProvider()`.
 * @param observation - The Git observation of the prune call. Detection gets its Git path and its reader, so it runs no second probe.
 */
export function defaultSafeguards(provider?: VcsProvider, observation: PruneObservation = pruneObservation()): PruneSafeguards {
  const hasRecentCommits = (branchName: string | undefined, windowHours: number) =>
    observedHasRecentCommits(observation, branchName, windowHours);
  if (provider && provider.name !== 'github') {
    return {
      hasOpenPR: async () => false,
      hasRecentCommits,
    };
  }

  let resolvedProvider: VcsProvider | undefined = provider;

  return {
    hasOpenPR: async (featureId, branchName) => {
      if (!resolvedProvider) {
        resolvedProvider = await createVcsProvider({
          detectorDeps: {
            ...(observation.gitPath === undefined ? {} : { gitPath: observation.gitPath }),
            reader: observation.reader,
          },
        });
      }
      return defaultHasOpenPR(resolvedProvider, featureId, branchName);
    },
    hasRecentCommits,
  };
}
