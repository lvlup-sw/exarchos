/** GitHub `VcsProvider`. It wraps the `gh` CLI, which must be installed and authenticated. */

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
  ReplyResult,
  GetPrCommentsOptions,
  PrCommentsPage,
} from './provider.js';
import { windowPrComments, computeOverallCiStatus } from './provider.js';
import { exec } from './shell.js';

/**
 * `gh pr checks --json` fields. `state` holds the check state, and `link` holds
 * the details URL. `gh` exits non-zero ("Unknown JSON field") for `conclusion`
 * or `detailsUrl`.
 */
interface GhCheckEntry {
  readonly name: string;
  readonly state: string;
  readonly link?: string;
}

interface GhReviewEntry {
  readonly author: { readonly login: string };
  readonly state: string;
}

interface GhReviewResponse {
  readonly reviews: readonly GhReviewEntry[];
  readonly reviewDecision: string;
}

/** An entry of `issues/{pr}/comments`: a PR-level comment without a diff anchor or threads. */
interface GhIssueCommentEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
}

/**
 * An entry of `pulls/{pr}/comments`: a line review comment. `in_reply_to_id` is
 * the id of the top-level comment that this reply answers. Threads have one level.
 */
interface GhReviewCommentEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
  readonly path?: string;
  readonly line?: number;
  readonly in_reply_to_id?: number;
}

/** An entry of `pulls/{pr}/reviews`: a submitted review. */
interface GhReviewSummaryEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly state: string;
  readonly submitted_at: string;
}

/**
 * A GraphQL `reviewThreads` node. It holds the resolution flag and the
 * `databaseId` of each inline comment, which is the REST `pulls/comments` id.
 */
interface GhReviewThreadNode {
  readonly isResolved: boolean;
  readonly comments: { readonly nodes: ReadonlyArray<{ readonly databaseId: number | null }> };
}

interface GhRepoViewResponse {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

/** The reply from `POST pulls/{pr}/comments/{comment_id}/replies`. */
interface GhReplyResponse {
  readonly id: number;
}

/**
 * Maps a `gh pr checks` `state` to a `CiCheck` status, after the state buckets
 * of `gh` (`pkg/cmd/pr/checks/aggregate.go`). SUCCESS is pass. ERROR, FAILURE,
 * TIMED_OUT and ACTION_REQUIRED are fail. SKIPPED and NEUTRAL are skipped.
 * Other values are not terminal, so they are pending. CANCELLED is fail,
 * because it is terminal and not a pass, so it must block the gate.
 */
function mapState(state: string): CiCheck['status'] {
  switch (state.toUpperCase()) {
    case 'SUCCESS':
      return 'pass';
    case 'ERROR':
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'CANCELLED':
      return 'fail';
    case 'SKIPPED':
    case 'NEUTRAL':
      return 'skipped';
    default:
      return 'pending';
  }
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
  }

  /**
   * Creates a PR with `gh pr create`, which has no `--json` flag. The PR URL is
   * the last non-empty line of stdout. If that URL ends without a PR number,
   * it reads the number and URL with `gh pr view`.
   */
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
    ];

    if (opts.draft) {
      args.push('--draft');
    }

    if (opts.labels && opts.labels.length > 0) {
      args.push('--label', opts.labels.join(','));
    }

    const output = await exec('gh', args);
    const url =
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .at(-1) ?? '';
    const number = Number(url.match(/\/(\d+)\/?$/)?.[1]);

    if (Number.isFinite(number)) {
      return { url, number };
    }

    const viewOutput = await exec('gh', ['pr', 'view', url, '--json', 'number,url']);
    const parsed = JSON.parse(viewOutput) as { url: string; number: number };
    return { url: parsed.url, number: parsed.number };
  }

  async checkCi(prId: string): Promise<CiStatus> {
    const output = await exec('gh', [
      'pr',
      'checks',
      prId,
      '--json',
      'name,state,link',
    ]);

    const entries = JSON.parse(output) as readonly GhCheckEntry[];
    const checks: CiCheck[] = entries.map((entry) => ({
      name: entry.name,
      status: mapState(entry.state),
      url: entry.link,
    }));

    return {
      status: computeOverallCiStatus(checks),
      checks,
    };
  }

  /**
   * Merges with `gh pr merge`, which prints text, not JSON. Then it reads the
   * merge commit SHA with `gh pr view`. If that read fails, the result is
   * `merged: true` without a SHA.
   */
  async mergePr(prId: string, strategy: string): Promise<MergeResult> {
    const strategyFlag = `--${strategy}`;

    try {
      await exec('gh', ['pr', 'merge', prId, strategyFlag]);

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

  /**
   * Posts a reply in a review-comment thread through the REST reply endpoint,
   * because `gh pr comment` posts only PR-level comments. `gh` fills in
   * `{owner}/{repo}` from the current repository. The returned id is in the
   * id space of the inline comments from `getPrComments`, so a caller can
   * find the reply again.
   */
  async addReply(prId: string, threadId: string, body: string): Promise<ReplyResult> {
    const output = await exec('gh', [
      'api',
      '--method',
      'POST',
      `repos/{owner}/{repo}/pulls/${prId}/comments/${threadId}/replies`,
      '-f',
      `body=${body}`,
    ]);
    const parsed = JSON.parse(output) as GhReplyResponse;
    return { id: parsed.id };
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

  /**
   * Reads the PR feedback of all authors, bots included, from three endpoints:
   *
   * - `issues/{pr}/comments` gives `issue-comment`. `gh pr comment` posts here,
   *   so the add-comment check reads it.
   * - `pulls/{pr}/comments` gives `review-inline`. `in_reply_to_id` sets `parentId`.
   * - `pulls/{pr}/reviews` gives `review-summary`, only for a review with a body.
   *   `getReviewStatus` reports a review without a body.
   */
  async getPrComments(prId: string): Promise<PrComment[]> {
    const [issueOut, inlineOut, reviewOut] = await Promise.all([
      exec('gh', ['api', `repos/{owner}/{repo}/issues/${prId}/comments`, '--paginate']),
      exec('gh', ['api', `repos/{owner}/{repo}/pulls/${prId}/comments`, '--paginate']),
      exec('gh', ['api', `repos/{owner}/{repo}/pulls/${prId}/reviews`, '--paginate']),
    ]);

    const issueEntries = JSON.parse(issueOut) as readonly GhIssueCommentEntry[];
    const inlineEntries = JSON.parse(inlineOut) as readonly GhReviewCommentEntry[];
    const reviewEntries = JSON.parse(reviewOut) as readonly GhReviewSummaryEntry[];

    const comments: PrComment[] = [];

    for (const entry of issueEntries) {
      comments.push({
        id: entry.id,
        author: entry.user.login,
        body: entry.body,
        createdAt: entry.created_at,
        source: 'issue-comment',
      });
    }

    for (const entry of inlineEntries) {
      comments.push({
        id: entry.id,
        author: entry.user.login,
        body: entry.body,
        createdAt: entry.created_at,
        source: 'review-inline',
        path: entry.path,
        line: entry.line,
        ...(entry.in_reply_to_id !== undefined ? { parentId: entry.in_reply_to_id } : {}),
      });
    }

    for (const entry of reviewEntries) {
      if (typeof entry.body !== 'string' || entry.body.trim() === '') continue;
      comments.push({
        id: entry.id,
        author: entry.user.login,
        body: entry.body,
        createdAt: entry.submitted_at,
        source: 'review-summary',
        state: entry.state,
      });
    }

    return this.enrichResolvedStatus(prId, comments);
  }

  /**
   * Windowed read. It reads the full feed with {@link getPrComments}, then
   * applies the shared {@link windowPrComments}. Thus the output is the same as
   * the fallback path for other providers.
   */
  async getPrCommentsPage(
    prId: string,
    opts?: GetPrCommentsOptions,
  ): Promise<PrCommentsPage> {
    const all = await this.getPrComments(prId);
    return windowPrComments(all, opts);
  }

  /**
   * Sets `resolved` on `review-inline` comments from the GraphQL `reviewThreads`,
   * because REST inline comments do not hold it. A comment that no thread holds
   * keeps `resolved` absent, which means unknown. It reads threads in pages of
   * 100, at most 50 pages, and the first 100 comments of each thread. On any
   * failure, it returns the REST comments without change, so the read does not
   * stop.
   */
  private async enrichResolvedStatus(
    prId: string,
    comments: PrComment[],
  ): Promise<PrComment[]> {
    try {
      const prNumber = Number.parseInt(prId, 10);
      if (!Number.isFinite(prNumber)) return comments;

      const repoOut = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner']);
      const { nameWithOwner } = JSON.parse(repoOut) as { nameWithOwner: string };
      const [owner, repo] = nameWithOwner.split('/');
      if (!owner || !repo) return comments;

      const query =
        'query($owner:String!,$repo:String!,$pr:Int!,$after:String){' +
        'repository(owner:$owner,name:$repo){' +
        'pullRequest(number:$pr){' +
        'reviewThreads(first:100,after:$after){' +
        'pageInfo{hasNextPage endCursor}' +
        'nodes{isResolved comments(first:100){nodes{databaseId}}}' +
        '}}}}';

      const resolvedById = new Map<number, boolean>();
      let after: string | null = null;
      for (let page = 0; page < 50; page++) {
        const graphqlArgs = [
          'api',
          'graphql',
          '-F',
          `owner=${owner}`,
          '-F',
          `repo=${repo}`,
          '-F',
          `pr=${prNumber}`,
          '-f',
          `query=${query}`,
        ];
        if (after) graphqlArgs.push('-F', `after=${after}`);

        const graphqlOut = await exec('gh', graphqlArgs);

        const parsed = JSON.parse(graphqlOut) as {
          data?: {
            repository?: {
              pullRequest?: {
                reviewThreads?: {
                  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
                  nodes?: readonly GhReviewThreadNode[];
                };
              };
            };
          };
        };

        const threads = parsed.data?.repository?.pullRequest?.reviewThreads;
        const nodes = threads?.nodes;
        if (!Array.isArray(nodes)) break;

        for (const thread of nodes) {
          for (const c of thread.comments?.nodes ?? []) {
            if (typeof c.databaseId === 'number') {
              resolvedById.set(c.databaseId, thread.isResolved);
            }
          }
        }

        const pageInfo = threads?.pageInfo;
        if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
        after = pageInfo.endCursor;
      }

      return comments.map((comment) => {
        if (comment.source !== 'review-inline') return comment;
        const resolved = resolvedById.get(comment.id);
        return resolved === undefined ? comment : { ...comment, resolved };
      });
    } catch {
      return comments;
    }
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
    return { url, number: parseInt(match[1] ?? '0', 10) };
  }

  /**
   * Finds the issues whose body holds the `<!-- exarchos-op:ID -->` marker. The
   * create-issue recovery check uses it. GitHub search strips HTML comments, so
   * a search cannot find the marker. Thus it lists the newest 1000 open and
   * closed issues and scans the bodies locally.
   */
  async searchIssuesByMarker(operationId: string): Promise<IssueSearchSummary[]> {
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
