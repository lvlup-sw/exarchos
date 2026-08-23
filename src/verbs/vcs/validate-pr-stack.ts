// ─── Validate PR Stack Handler ──────────────────────────────────────────────
//
// Validates that open PRs form a proper linear chain (stack).
// Uses VcsProvider to query open PRs instead of direct gh CLI calls.
// ────────────────────────────────────────────────────────────────────────────

import type { VcsProvider, PrSummary } from '../../vcs/provider.js';
import { requiresGitHub } from '../../vcs/require-github.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import type { ToolResult } from '../../format.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ValidatePrStackArgs {
  readonly baseBranch: string;
  /**
   * The resolved project config, injected by the dispatch adapter.
   *
   * It is what makes `.exarchos.yml`'s `vcs.provider` reach the factory. Without
   * it the factory falls through to detection, which reads the git remote's
   * HOSTNAME — so a self-hosted GitLab at `git.acme.internal`, or an enterprise
   * GitHub, matches no pattern and resolves to the GitHub default. That is the
   * setting being ignored precisely where a project stated it explicitly.
   */
  readonly projectConfig?: ResolvedProjectConfig;
}

interface PrEntry {
  readonly number: number;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: string;
}

interface ValidatePrStackResult {
  readonly passed: boolean;
  readonly report: string;
  readonly prCount: number;
  readonly errors: readonly string[];
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleValidatePrStack(
  args: ValidatePrStackArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  // 1. Validate args
  if (!args.baseBranch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'baseBranch is required' },
    };
  }

  const { baseBranch } = args;

  // The guard runs against the RESOLVED provider, not the parameter.
  //
  // The composed router calls this handler with its args and nothing else, so
  // `provider` is always undefined in production — and `requiresGitHub` reads an
  // absent provider as "unconfigured, GitHub is implicit" and waves it through.
  // Guarding the parameter therefore declared a graceful skip that no real call
  // could ever reach: a GitLab or Azure DevOps repository fell past it into
  // `listPrs`, which throws `UnsupportedOperationError` on both partials, and a
  // BLOCKING synthesis gate reported a hard `GH_CLI_ERROR` for an obligation
  // that simply does not apply to that host. Resolving first is what makes the
  // declared skip reachable without the router having to hand the provider in.
  //
  // The config goes WITH the request: `createVcsProvider` consults
  // `config.vcs.provider` first and only auto-detects when nothing was declared,
  // so calling it bare would silently demote an explicit setting to a hostname
  // guess.
  const vcs = provider ?? (await createVcsProvider({ config: args.projectConfig }));
  const vcsGuard = requiresGitHub(vcs, 'validate_pr_stack');
  if (vcsGuard) return vcsGuard;

  // 2. Query open PRs via VcsProvider
  let prSummaries: PrSummary[];
  try {
    prSummaries = await vcs.listPrs({ state: 'open' });
  } catch (err: unknown) {
    return {
      success: false,
      error: {
        code: 'GH_CLI_ERROR',
        message: `PR list query failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // 3. Map to PrEntry shape
  const prs: PrEntry[] = prSummaries.map(pr => ({
    number: pr.number,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    state: pr.state,
  }));

  // No open PRs
  if (prs.length === 0) {
    const result: ValidatePrStackResult = {
      passed: true,
      report: 'No open PRs found -- nothing to validate.',
      prCount: 0,
      errors: [],
    };
    return { success: true, data: result };
  }

  // 4. Run 3 validation checks
  const headBranches = new Set(prs.map((pr) => pr.headRefName));
  const errors: string[] = [];

  // Check 1: Each PR's base must be the stack base or another PR's head
  for (const pr of prs) {
    if (pr.baseRefName === baseBranch) continue;
    if (headBranches.has(pr.baseRefName)) continue;
    errors.push(
      `PR #${pr.number} (${pr.headRefName}): base '${pr.baseRefName}' is not '${baseBranch}' and not a head branch of any other open PR`,
    );
  }

  // Check 2: Exactly one PR should target the base branch (linear chain root)
  const rootCount = prs.filter((pr) => pr.baseRefName === baseBranch).length;
  if (rootCount === 0) {
    errors.push(
      `No PR targets '${baseBranch}' directly -- stack root is missing (cyclic or disconnected)`,
    );
  } else if (rootCount > 1) {
    errors.push(
      `Multiple PRs target '${baseBranch}' directly (found ${rootCount}) -- stack is not a linear chain`,
    );
  }

  // Check 3: No branch should be used as a base by more than one PR (no forks)
  for (const head of headBranches) {
    const depCount = prs.filter((pr) => pr.baseRefName === head).length;
    if (depCount > 1) {
      errors.push(`Branch '${head}' is used as base by ${depCount} PRs -- stack has a fork`);
    }
  }

  // 5. Build markdown report
  const passed = errors.length === 0;
  const lines: string[] = [];

  if (passed) {
    lines.push(`Stack is healthy -- ${prs.length} open PR(s) properly chained on '${baseBranch}'.`);
    lines.push('');
    lines.push('Chain:');
    for (const pr of prs) {
      lines.push(`  #${pr.number}: ${pr.baseRefName} <- ${pr.headRefName}`);
    }
  } else {
    lines.push(`Stack validation failed -- ${errors.length} issue(s) found:`);
    for (const error of errors) {
      lines.push(`  - ${error}`);
    }
    lines.push('');
    lines.push('All open PRs:');
    for (const pr of prs) {
      lines.push(`  #${pr.number}: ${pr.baseRefName} <- ${pr.headRefName}`);
    }
  }

  const result: ValidatePrStackResult = {
    passed,
    report: lines.join('\n'),
    prCount: prs.length,
    errors,
  };

  // 6. Return ToolResult
  return { success: true, data: result };
}
