// ─── GitHub VCS Provider ─────────────────────────────────────────────────────
//
// Implements VcsProvider by wrapping the `gh` CLI.
// Requires `gh` to be installed and authenticated.

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
import { exec } from './shell.js';

interface GhCheckEntry {
  readonly name: string;
  readonly conclusion: string | null;
  readonly detailsUrl?: string;
}

interface GhReviewEntry {
  readonly author: { readonly login: string };
  readonly state: string;
}

interface GhReviewResponse {
  readonly reviews: readonly GhReviewEntry[];
  readonly reviewDecision: string;
}

interface GhPrCommentEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
  readonly path?: string;
  readonly line?: number;
}

interface GhRepoViewResponse {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

function mapConclusion(conclusion: string | null): CiCheck['status'] {
  if (conclusion === null) return 'pending';
  switch (conclusion) {
    case 'success':
      return 'pass';
    case 'failure':
      return 'fail';
    case 'skipped':
    case 'neutral':
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

function mapReviewState(ghState: string): ReviewerStatus['state'] {
  switch (ghState) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'COMMENTED':
      return 'commented';
    default:
      return 'pending';
  }
}

function mapReviewDecision(decision: string): ReviewStatus['state'] {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    default:
      return 'pending';
  }
}

export class GitHubProvider implements VcsProvider {
  readonly name = 'github' as const;

  constructor(_config: Record<string, unknown>) {
    // Config reserved for future use (e.g., custom gh path)
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    const args = [
      'pr',
      'create',
      '--title',
      opts.title,
      '--body',
      opts.body,
      '--base',
      opts.baseBranch,
      '--head',
      opts.headBranch,
      '--json',
      'url,number',
    ];

    if (opts.draft) {
      args.push('--draft');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--label', opts.labels.join(','));
    }

    const output = await exec('gh', args);
    const parsed = JSON.parse(output) as { url: string; number: number };
    return { url: parsed.url, number: parsed.number };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    const output = await exec('gh', [
      'pr',
      'checks',
      prId,
      '--json',
      'name,conclusion,detailsUrl',
    ]);

    const entries = JSON.parse(output) as readonly GhCheckEntry[];
    const checks: CiCheck[] = entries.map((entry) => ({
      name: entry.name,
      status: mapConclusion(entry.conclusion),
      url: entry.detailsUrl,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const strategyFlag = `--${strategy}`;

    try {
      // gh pr merge outputs human-readable text, not JSON — don't parse it
      await exec('gh', ['pr', 'merge', prId, strategyFlag]);

      // Merge succeeded — fetch the merge commit SHA via gh pr view
      try {
        const viewOutput = await exec('gh', [
          'pr',
          'view',
          prId,
          '--json',
          'mergeCommit',
        ]);
        const parsed = JSON.parse(viewOutput) as { mergeCommit?: { oid?: string } };
        const sha = parsed.mergeCommit?.oid;
        return sha ? { merged: true, sha } : { merged: true };
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
    await exec('gh', ['pr', 'comment', prId, '--body', body]);
  }

  async getReviewStatus(prId: string): Promise<ReviewStatus> {
    const output = await exec('gh', [
      'pr',
      'view',
      prId,
      '--json',
      'reviews,reviewDecision',
    ]);

    const parsed = JSON.parse(output) as GhReviewResponse;
    const reviewers: ReviewerStatus[] = parsed.reviews.map((r) => ({
      login: r.author.login,
      state: mapReviewState(r.state),
    }));

    return {
      state: mapReviewDecision(parsed.reviewDecision),
      reviewers,
    };
  }

  async listPrs(filter?: PrFilter): Promise<PrSummary[]> {
    const args = [
      'pr',
      'list',
      '--json',
      'number,url,title,headRefName,baseRefName,state',
    ];

    if (filter?.state && filter.state !== 'all') {
      args.push('--state', filter.state);
    } else if (filter?.state === 'all') {
      args.push('--state', 'all');
    }

    if (filter?.head) {
      args.push('--head', filter.head);
    }

    if (filter?.base) {
      args.push('--base', filter.base);
    }

    const output = await exec('gh', args);
    const entries = JSON.parse(output) as PrSummary[];
    return entries;
  }

  async getPrComments(prId: string): Promise<PrComment[]> {
    const output = await exec('gh', [
      'api',
      `repos/{owner}/{repo}/pulls/${prId}/comments`,
      '--paginate',
    ]);

    const entries = JSON.parse(output) as readonly GhPrCommentEntry[];
    return entries.map((entry) => ({
      id: entry.id,
      author: entry.user.login,
      body: entry.body,
      createdAt: entry.created_at,
      path: entry.path,
      line: entry.line,
    }));
  }

  async getPrDiff(prId: string): Promise<string> {
    return exec('gh', ['pr', 'diff', prId]);
  }

  async createIssue(opts: CreateIssueOpts): Promise<IssueResult> {
    const args = [
      'issue',
      'create',
      '--title',
      opts.title,
      '--body',
      opts.body,
    ];

    if (opts.labels && opts.labels.length > 0) {
      args.push('--label', opts.labels.join(','));
    }

    const output = await exec('gh', args);
    const match = output.match(/\/issues\/(\d+)/);
    const number = match ? parseInt(match[1], 10) : 0;
    return { url: output.trim(), number };
  }

  async getRepository(): Promise<RepoInfo> {
    const output = await exec('gh', [
      'repo',
      'view',
      '--json',
      'nameWithOwner,defaultBranchRef',
    ]);

    const parsed = JSON.parse(output) as GhRepoViewResponse;
    return {
      nameWithOwner: parsed.nameWithOwner,
      defaultBranch: parsed.defaultBranchRef.name,
    };
  }
}
