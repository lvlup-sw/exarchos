/** The PR stack gate. It checks through the `VcsProvider` that the open PRs form one linear chain. */

import type { VcsProvider, PrSummary } from '../../vcs/provider.js';
import { requiresGitHub } from '../../vcs/require-github.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { ToolResult } from '../../format.js';
import type { EventStore } from '../../events/store.js';
import { createEvidenceSubject } from '../../workflow/admission/evidence-subject.js';
import { runPhaseGateWithEvidence } from '../gates/gate-runner.js';

export interface ValidatePrStackArgs {
  /** The stream the gate's durable evidence is recorded against. */
  readonly featureId: string;
  readonly baseBranch: string;
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

/**
 * Runs the gate through the shared phase-gate runner, which records durable gate evidence before a
 * success carrier returns. The action declares no catalog emission, so the gate appends no `gate.executed` row.
 */
export async function handleValidatePrStack(
  args: ValidatePrStackArgs,
  stateDir: string,
  eventStore: EventStore,
  provider?: VcsProvider,
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.baseBranch) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'baseBranch is required' },
    };
  }

  return runPhaseGateWithEvidence({
    streamId: args.featureId,
    gateClass: 'pr-stack',
    requirementId: 'requirement:pr-stack',
    stateDir,
    eventStore,
    subject: (phaseAttemptId) =>
      createEvidenceSubject(
        { kind: 'phase-attempt', phaseAttemptId },
        { gate: 'pr-stack', phase: 'synthesize', baseBranch: args.baseBranch },
      ),
    providerInput: args,
    executeProvider: async () => executeValidatePrStack(args, provider),
  });
}

/**
 * Lists the open PRs and checks three rules. The base of each PR is the stack base or the head of
 * another open PR. Exactly one PR targets the stack base. No branch is the base of more than one PR.
 * The GitHub check runs here, inside the runner, so an early return also carries the durable evidence.
 */
async function executeValidatePrStack(
  args: ValidatePrStackArgs,
  provider?: VcsProvider,
): Promise<ToolResult> {
  const vcsGuard = requiresGitHub(provider, 'validate_pr_stack');
  if (vcsGuard) return vcsGuard;

  const { baseBranch } = args;
  const vcs = provider ?? await createVcsProvider();

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

  const prs: PrEntry[] = prSummaries.map(pr => ({
    number: pr.number,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    state: pr.state,
  }));

  if (prs.length === 0) {
    const result: ValidatePrStackResult = {
      passed: true,
      report: 'No open PRs found -- nothing to validate.',
      prCount: 0,
      errors: [],
    };
    return { success: true, data: result };
  }

  const headBranches = new Set(prs.map((pr) => pr.headRefName));
  const errors: string[] = [];

  for (const pr of prs) {
    if (pr.baseRefName === baseBranch) continue;
    if (headBranches.has(pr.baseRefName)) continue;
    errors.push(
      `PR #${pr.number} (${pr.headRefName}): base '${pr.baseRefName}' is not '${baseBranch}' and not a head branch of any other open PR`,
    );
  }

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

  for (const head of headBranches) {
    const depCount = prs.filter((pr) => pr.baseRefName === head).length;
    if (depCount > 1) {
      errors.push(`Branch '${head}' is used as base by ${depCount} PRs -- stack has a fork`);
    }
  }

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

  return { success: true, data: result };
}
