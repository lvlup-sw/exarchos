/**
 * Production open-PR and recent-commits safeguards for
 * `handlePruneStaleWorkflows`. The open-PR check uses a `VcsProvider`, and the
 * recent-commits check runs `git log`. The handler takes them as injected
 * dependencies, so tests can use stubs and run no git or VCS commands.
 */

import { execSync } from 'node:child_process';
import type { VcsProvider } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';

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
 * True when a branch name holds only alphanumerics, `/`, `_`, `.`, and `-`, and
 * no `..`. The shell command embeds the name, so only these names are safe.
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
 * Runs `git log` on `origin/<branchName>` for the last `windowHours`. A missing
 * remote branch or a git error returns false.
 */
async function defaultHasRecentCommits(
  branchName: string | undefined,
  windowHours: number,
): Promise<boolean> {
  if (!branchName || !isSafeBranchName(branchName)) return false;
  try {
    const output = execSync(
      `git log --since "${windowHours} hours ago" --format=%H origin/${branchName}`,
      {
        encoding: 'utf-8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

/**
 * Builds the production safeguards. When the caller passes a provider other
 * than GitHub, the open-PR check always returns false.
 *
 * @param provider - An optional `VcsProvider`. Without it, the first open-PR check calls `createVcsProvider()`.
 */
export function defaultSafeguards(provider?: VcsProvider): PruneSafeguards {
  if (provider && provider.name !== 'github') {
    return {
      hasOpenPR: async () => false,
      hasRecentCommits: defaultHasRecentCommits,
    };
  }

  let resolvedProvider: VcsProvider | undefined = provider;

  return {
    hasOpenPR: async (featureId, branchName) => {
      if (!resolvedProvider) {
        resolvedProvider = await createVcsProvider();
      }
      return defaultHasOpenPR(resolvedProvider, featureId, branchName);
    },
    hasRecentCommits: defaultHasRecentCommits,
  };
}
