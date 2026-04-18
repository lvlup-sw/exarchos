// ─── GitLab VCS Provider ─────────────────────────────────────────────────────
//
// Implements VcsProvider by wrapping the `glab` CLI.
// Requires `glab` to be installed and authenticated.
// GitLab uses "merge request" (MR) terminology; `number` maps to `iid`.

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

interface GlabPipelineJob {
  readonly name: string;
  readonly status: string;
  readonly webUrl?: string;
}

interface GlabPipelineResponse {
  readonly pipeline: {
    readonly jobs: readonly GlabPipelineJob[];
  } | null;
}

interface GlabReviewer {
  readonly username: string;
}

interface GlabReviewResponse {
  readonly reviewers: readonly GlabReviewer[];
  readonly approvedBy: readonly GlabReviewer[];
}

function mapGitLabJobStatus(status: string): CiCheck['status'] {
  switch (status) {
    case 'success':
      return 'pass';
    case 'failed':
      return 'fail';
    case 'skipped':
      return 'skipped';
    case 'created':
    case 'pending':
    case 'running':
    case 'manual':
      return 'pending';
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

export class GitLabProvider implements VcsProvider {
  readonly name = 'gitlab' as const;

  constructor(_config: Record<string, unknown>) {
    // Config reserved for future use (e.g., custom glab path, self-hosted URL)
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    const args = [
      'mr',
      'create',
      '--title',
      opts.title,
      '--description',
      opts.body,
      '--source-branch',
      opts.headBranch,
      '--target-branch',
      opts.baseBranch,
      '--json',
      'url,iid',
    ];

    if (opts.draft) {
      args.push('--draft');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--label', opts.labels.join(','));
    }

    const output = await exec('glab', args);
    const parsed = JSON.parse(output) as { url: string; iid: number };
    return { url: parsed.url, number: parsed.iid };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    const output = await exec('glab', [
      'mr',
      'view',
      prId,
      '--json',
      'pipeline',
    ]);

    const parsed = JSON.parse(output) as GlabPipelineResponse;

    if (!parsed.pipeline) {
      return { status: 'pending', checks: [] };
    }

    const checks: CiCheck[] = parsed.pipeline.jobs.map((job) => ({
      name: job.name,
      status: mapGitLabJobStatus(job.status),
      url: job.webUrl,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const args = ['mr', 'merge', prId];

    // glab supports --squash and --rebase; plain merge needs no extra flag
    if (strategy === 'squash') {
      args.push('--squash');
    } else if (strategy === 'rebase') {
      args.push('--rebase');
    }
    // 'merge' strategy uses the default glab behavior (no flag)

    try {
      await exec('glab', args);

      // Fetch the merge commit SHA via glab mr view
      try {
        const viewOutput = await exec('glab', [
          'mr',
          'view',
          prId,
          '--json',
          'sha',
        ]);
        const parsed = JSON.parse(viewOutput) as { sha?: string };
        return parsed.sha ? { merged: true, sha: parsed.sha } : { merged: true };
      } catch {
        // SHA retrieval failed — merge still succeeded
        return { merged: true };
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { merged: false, error: message };
    }
  }

  async addComment(prId: string, body: string): Promise<void> {
    await exec('glab', ['mr', 'comment', prId, '--message', body]);
  }

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const output = await exec('glab', [
      'mr',
      'view',
      prId,
      '--json',
      'reviewers,approvedBy',
    ]);

    const parsed = JSON.parse(output) as GlabReviewResponse;
    const approvedSet = new Set(parsed.approvedBy.map((a) => a.username));

    const reviewers: ReviewerStatus[] = parsed.reviewers.map((r) => ({
      login: r.username,
      state: approvedSet.has(r.username) ? 'approved' as const : 'pending' as const,
    }));

    // Overall: approved only if all reviewers have approved and there's at least one
    const allApproved =
      reviewers.length > 0 && reviewers.every((r) => r.state === 'approved');

    return {
      state: allApproved ? 'approved' : 'pending',
      reviewers,
    };
  }

  async listPrs(_filter?: PrFilter): Promise<PrSummary[]> {
    throw new UnsupportedOperationError('gitlab', 'listPrs');
  }

  async getPrComments(_prId: string): Promise<PrComment[]> {
    throw new UnsupportedOperationError('gitlab', 'getPrComments');
  }

  async getPrDiff(_prId: string): Promise<string> {
    throw new UnsupportedOperationError('gitlab', 'getPrDiff');
  }

  async createIssue(_opts: CreateIssueOpts): Promise<IssueResult> {
    throw new UnsupportedOperationError('gitlab', 'createIssue');
  }

  async getRepository(): Promise<RepoInfo> {
    throw new UnsupportedOperationError('gitlab', 'getRepository');
  }
}
