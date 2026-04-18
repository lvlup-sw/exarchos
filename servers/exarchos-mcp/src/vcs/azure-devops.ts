// ─── Azure DevOps VCS Provider ───────────────────────────────────────────────
//
// Implements VcsProvider by wrapping the `az repos` and `az pipelines` CLIs.
// Requires `az` CLI with the `azure-devops` extension installed and authenticated.

import type {
  VcsProvider,
  CreatePrOpts,
  PrResult,
  CiCheck,
  CiStatus,
  MergeResult,
  ReviewerStatus,
  ReviewStatus,
  PrFilter,
  PrSummary,
  PrComment,
  CreateIssueOpts,
  IssueResult,
  RepoInfo,
} from './provider.js';
import { UnsupportedOperationError } from './provider.js';
import { exec } from './shell.js';

interface AzPrCreateResponse {
  readonly repository: { readonly webUrl: string };
  readonly pullRequestId: number;
}

interface AzPipelineRun {
  readonly name: string;
  readonly result: string | null;
  readonly status: string;
  readonly _links?: { readonly web?: { readonly href?: string } };
}

interface AzReviewer {
  readonly uniqueName: string;
  readonly vote: number;
  readonly displayName?: string;
}

function mapAzPipelineStatus(run: AzPipelineRun): CiCheck['status'] {
  if (run.status !== 'completed') {
    return 'pending';
  }
  switch (run.result) {
    case 'succeeded':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'canceled':
      return 'skipped';
    default:
      return 'pending';
  }
}

function computeOverallCiStatus(checks: readonly CiCheck[]): CiStatus['status'] {
  const hasFailure = checks.some((c) => c.status === 'fail');
  if (hasFailure) return 'fail';

  const hasPending = checks.some((c) => c.status === 'pending');
  if (hasPending) return 'pending';

  return 'pass';
}

/**
 * Map Azure DevOps vote values to review states.
 *
 * Azure DevOps voting scale:
 *  10 = approved
 *   5 = approved with suggestions
 *   0 = no vote (pending)
 *  -5 = waiting for author (changes requested)
 * -10 = rejected (changes requested)
 */
function mapAzVote(vote: number): ReviewerStatus['state'] {
  if (vote >= 5) return 'approved';
  if (vote < 0) return 'changes_requested';
  return 'pending';
}

export class AzureDevOpsProvider implements VcsProvider {
  readonly name = 'azure-devops' as const;

  constructor(_config: Record<string, unknown>) {
    // Config reserved for future use (e.g., organization URL, project)
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    const args = [
      'repos',
      'pr',
      'create',
      '--title',
      opts.title,
      '--description',
      opts.body,
      '--source-branch',
      opts.headBranch,
      '--target-branch',
      opts.baseBranch,
      '--output',
      'json',
    ];

    if (opts.draft) {
      args.push('--draft', 'true');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--labels', opts.labels.join(' '));
    }

    const output = await exec('az', args);
    const parsed = JSON.parse(output) as AzPrCreateResponse;
    const url = `${parsed.repository.webUrl}/pullrequest/${parsed.pullRequestId}`;
    return { url, number: parsed.pullRequestId };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    // First, get the PR's source branch
    const prOutput = await exec('az', [
      'repos',
      'pr',
      'show',
      '--id',
      prId,
      '--output',
      'json',
    ]);
    const prData = JSON.parse(prOutput) as { sourceRefName: string };
    // Strip refs/heads/ prefix to get plain branch name
    const branch = prData.sourceRefName.replace(/^refs\/heads\//, '');

    // Then list pipeline runs for that branch
    const runsOutput = await exec('az', [
      'pipelines',
      'runs',
      'list',
      '--branch',
      branch,
      '--output',
      'json',
    ]);

    const runs = JSON.parse(runsOutput) as readonly AzPipelineRun[];

    if (runs.length === 0) {
      return { status: 'pending', checks: [] };
    }

    const checks: CiCheck[] = runs.map((run) => ({
      name: run.name,
      status: mapAzPipelineStatus(run),
      url: run._links?.web?.href,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const isSquash = strategy === 'squash';

    // Map strategy names to Azure DevOps merge strategy values
    let azStrategy: string;
    switch (strategy) {
      case 'squash':
        azStrategy = 'squash';
        break;
      case 'rebase':
        azStrategy = 'rebase';
        break;
      case 'merge':
        azStrategy = 'noFastForward';
        break;
      default:
        azStrategy = 'squash';
    }

    try {
      const output = await exec('az', [
        'repos',
        'pr',
        'update',
        '--id',
        prId,
        '--auto-complete',
        'true',
        '--squash',
        isSquash ? 'true' : 'false',
        '--merge-strategy',
        azStrategy,
        '--output',
        'json',
      ]);

      const parsed = JSON.parse(output) as {
        status?: string;
        lastMergeCommit?: { commitId?: string };
      };

      const sha = parsed.lastMergeCommit?.commitId;
      return sha ? { merged: true, sha } : { merged: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { merged: false, error: message };
    }
  }

  async addComment(prId: string, body: string): Promise<void> {
    await exec('az', [
      'repos',
      'pr',
      'comment',
      'create',
      '--id',
      prId,
      '--text',
      body,
      '--output',
      'json',
    ]);
  }

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const output = await exec('az', [
      'repos',
      'pr',
      'reviewer',
      'list',
      '--id',
      prId,
      '--output',
      'json',
    ]);

    const reviewers = JSON.parse(output) as readonly AzReviewer[];

    const mapped: ReviewerStatus[] = reviewers.map((r) => ({
      login: r.uniqueName,
      state: mapAzVote(r.vote),
    }));

    // Overall: approved only if all reviewers approved and there's at least one
    const hasChangesRequested = mapped.some((r) => r.state === 'changes_requested');
    if (hasChangesRequested) {
      return { state: 'changes_requested', reviewers: mapped };
    }

    const allApproved =
      mapped.length > 0 && mapped.every((r) => r.state === 'approved');

    return {
      state: allApproved ? 'approved' : 'pending',
      reviewers: mapped,
    };
  }

  async listPrs(_filter?: PrFilter): Promise<PrSummary[]> {
    throw new UnsupportedOperationError('azure-devops', 'listPrs');
  }

  async getPrComments(_prId: string): Promise<PrComment[]> {
    throw new UnsupportedOperationError('azure-devops', 'getPrComments');
  }

  async getPrDiff(_prId: string): Promise<string> {
    throw new UnsupportedOperationError('azure-devops', 'getPrDiff');
  }

  async createIssue(_opts: CreateIssueOpts): Promise<IssueResult> {
    throw new UnsupportedOperationError('azure-devops', 'createIssue');
  }

  async getRepository(): Promise<RepoInfo> {
    throw new UnsupportedOperationError('azure-devops', 'getRepository');
  }
}
