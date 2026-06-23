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
  IssueSearchSummary,
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
    // The `/pulls/{prId}/comments` endpoint returns *inline review*
    // comments — the per-line discussion attached to a diff. General
    // PR-level conversation (what `gh pr comment` posts) lives on the
    // shared issues comment endpoint. Reading from the wrong endpoint
    // means the post-then-verify path never finds the comment it just
    // wrote, the verification fails, and the recovery branch posts a
    // duplicate. We fetch the issues endpoint so producer and consumer
    // see the same comment stream.
    const output = await exec('gh', [
      'api',
      `repos/{owner}/{repo}/issues/${prId}/comments`,
      '--paginate',
    ]);

    const entries = JSON.parse(output) as readonly GhPrCommentEntry[];
    return entries.map((entry) => ({
      id: entry.id,
      author: entry.user.login,
      body: entry.body,
      createdAt: entry.created_at,
      source: 'issue-comment' as const,
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

    if (opts.assignees && opts.assignees.length > 0) {
      args.push('--assignee', opts.assignees.join(','));
    }

    const output = await exec('gh', args);
    const url = output.trim();
    const match = url.match(/\/issues\/(\d+)/);
    if (!match) {
      throw new Error(`Failed to parse issue number from gh output: ${url}`);
    }
    return { url, number: parseInt(match[1], 10) };
  }

  async searchIssuesByMarker(operationId: string): Promise<IssueSearchSummary[]> {
    // Two-event-split recovery precheck for create-issue.
    //
    // The marker we embed is an HTML comment (`<!-- exarchos-op:UUID -->`)
    // chosen so it is invisible to humans reading the issue. GitHub's
    // server-side search index strips HTML comments before tokenizing, so
    // `gh issue list --search "<!-- exarchos-op:UUID -->"` returns no
    // results even when an issue with that marker exists in its body —
    // Sentry #14058284 and #14058450. Switching the marker to a visible
    // footer would change rendered-issue UX, so instead we list issues
    // and scan their bodies client-side, which sees the marker regardless
    // of indexing rules.
    //
    // Scope: open + closed, walked newest-first via gh's default sort.
    // Earlier revisions used a 200-issue cap; under issue churn the
    // original marker could fall outside the window and Phase C would
    // create a duplicate (CodeRabbit review #4278133032). Bumped to
    // gh's effective per-call ceiling (1000) so the recovery window
    // matches what gh can return in a single batch. Repositories with
    // >1000 open+closed issues created since the prior crash should
    // route through `args.operationId` (orchestrator-supplied) so this
    // scan never has to be authoritative — see #1352.
    const RECENT_ISSUE_LIMIT = 1000;
    const marker = `<!-- exarchos-op:${operationId} -->`;
    const output = await exec('gh', [
      'issue',
      'list',
      '--state',
      'all',
      '--json',
      'number,url,body',
      '--limit',
      String(RECENT_ISSUE_LIMIT),
    ]);
    const parsed = JSON.parse(output) as Array<{
      number: number;
      url: string;
      body: string | null;
    }>;
    return parsed
      .filter((entry): entry is { number: number; url: string; body: string } =>
        typeof entry.body === 'string' && entry.body.includes(marker),
      )
      .map((entry) => ({
        number: entry.number,
        url: entry.url,
        body: entry.body,
      }));
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
