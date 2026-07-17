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
  ReplyResult,
  GetPrCommentsOptions,
  PrCommentsPage,
} from './provider.js';
import { windowPrComments, computeOverallCiStatus } from './provider.js';
import { exec } from './shell.js';

// `gh pr checks --json` fields. The `gh` CLI dropped the legacy `conclusion`
// and `detailsUrl` fields; the current schema exposes `state` (the check's
// state/conclusion enum) and `link` (the details URL). Requesting the removed
// field names now makes `gh` exit non-zero ("Unknown JSON field").
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

// `repos/{owner}/{repo}/issues/{pr}/comments` — PR-level conversation
// (`gh pr comment` posts here). No diff anchor, no threading.
interface GhIssueCommentEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
}

// `repos/{owner}/{repo}/pulls/{pr}/comments` — per-line review threads.
// `in_reply_to_id` (when present) is the id of the top-level comment this one
// replies to; threading is one level only.
interface GhReviewCommentEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly created_at: string;
  readonly path?: string;
  readonly line?: number;
  readonly in_reply_to_id?: number;
}

// `repos/{owner}/{repo}/pulls/{pr}/reviews` — review submissions. Only those
// with a non-empty body become `review-summary` comments; state-only reviews
// are handled by getReviewStatus, not here.
interface GhReviewSummaryEntry {
  readonly id: number;
  readonly user: { readonly login: string };
  readonly body: string;
  readonly state: string;
  readonly submitted_at: string;
}

// A `reviewThreads` node from the GraphQL resolved-status query. Each thread
// carries its resolution flag plus the databaseIds of the inline comments it
// contains, which map back to the REST `pulls/comments` ids.
interface GhReviewThreadNode {
  readonly isResolved: boolean;
  readonly comments: { readonly nodes: ReadonlyArray<{ readonly databaseId: number | null }> };
}

interface GhRepoViewResponse {
  readonly nameWithOwner: string;
  readonly defaultBranchRef: { readonly name: string };
}

// Response from `POST pulls/{pr}/comments/{comment_id}/replies` — the newly
// created reply review-comment. `id` is the same databaseId space as the
// inline-comment ids returned by getPrComments.
interface GhReplyResponse {
  readonly id: number;
}

// Maps a `gh pr checks --json state` value onto our CiCheck status. `gh`
// replaced the removed `conclusion` field with `state`, whose values are gh's
// own check-state enum (upper-case). This mirrors gh's own state→bucket
// classification (cli/cli `pkg/cmd/pr/checks/aggregate.go`): SUCCESS→pass;
// ERROR/FAILURE/TIMED_OUT/ACTION_REQUIRED→fail; SKIPPED/NEUTRAL→skipped;
// everything else (EXPECTED, REQUESTED, WAITING, QUEUED, PENDING, IN_PROGRESS,
// STALE, or empty) is not yet terminal → pending. CANCELLED is gh's own
// `cancel` bucket; our status set has no cancel state, so a cancelled check is
// folded into `fail` — it is terminal and not a pass, so it must block gating.
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
    // Config reserved for future use (e.g., custom gh path)
  }

  async createPr(opts: CreatePrOpts): Promise<PrResult> {
    // NB: `gh pr create` has NO `--json` flag (that's valid only on
    // `gh pr view`/`gh pr list`); passing it makes gh exit non-zero on
    // flag-parse BEFORE creating the PR. On success gh prints the created PR
    // URL to stdout, so we parse the URL/number from that — mirroring how
    // createIssue derives the issue number from its `gh issue create` stdout.
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
    // gh may print progress/notice lines before the URL; take the last
    // non-empty line as the created PR URL.
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

    // Fallback: stdout carried no parseable trailing PR number. Resolve the
    // structured fields via `gh pr view` rather than throwing.
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

  async addReply(prId: string, threadId: string, body: string): Promise<ReplyResult> {
    // Reply into an existing review-comment thread. GitHub's dedicated reply
    // endpoint is REST-only — `gh pr comment` can ONLY post a PR-level issue
    // comment, so a thread reply must go through `gh api`:
    //
    //   POST repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies
    //
    // `{owner}/{repo}` are placeholders gh resolves from the current repo (same
    // pattern as getPrComments). The body is passed via `-f body=...`; `id` in
    // the response is the new reply's databaseId, in the same id space as the
    // inline-comment ids getPrComments returns (so the comment-marker
    // verification path can correlate it back).
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

  async getPrComments(prId: string): Promise<PrComment[]> {
    // Aggregate all three GitHub feedback surfaces into one PrComment[],
    // for ANY author (bots included). A single surface never sees the
    // whole conversation: issue comments, inline review threads, and
    // review summaries each live on a distinct endpoint.
    //
    //  1. issues/{pr}/comments  → 'issue-comment'  (PR-level discussion;
    //     `gh pr comment` posts here, so this surface is load-bearing for
    //     add-comment's post-then-verify path).
    //  2. pulls/{pr}/comments   → 'review-inline'  (per-line threads;
    //     `in_reply_to_id` → parentId, one level only).
    //  3. pulls/{pr}/reviews    → 'review-summary' (review bodies only;
    //     state-only reviews are getReviewStatus's job, not ours).
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
        // One-level threading: a reply points straight at the top-level
        // comment it answers. Absent in_reply_to_id ⇒ top-level.
        ...(entry.in_reply_to_id !== undefined ? { parentId: entry.in_reply_to_id } : {}),
      });
    }

    for (const entry of reviewEntries) {
      // Only reviews with an actual body are feedback; a CHANGES_REQUESTED
      // or APPROVED review with no body is a verdict getReviewStatus reports.
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
   * DR-3 — windowed + projected read. Fetches the full aggregated feed via
   * {@link getPrComments} (all three surfaces + resolution enrichment), then
   * hands it to the shared, provider-agnostic {@link windowPrComments} so the
   * newest-first window / `page` metadata / `fields` projection / steer notice
   * are byte-identical to what the GitLab/ADO fallback path produces.
   */
  async getPrCommentsPage(
    prId: string,
    opts?: GetPrCommentsOptions,
  ): Promise<PrCommentsPage> {
    const all = await this.getPrComments(prId);
    return windowPrComments(all, opts);
  }

  /**
   * Fail-soft enrichment of `resolved` on `review-inline` comments.
   *
   * REST inline comments don't carry resolution state — it lives on GraphQL
   * `reviewThreads`. We query that, build a `databaseId → isResolved` map, and
   * stamp `resolved` onto any inline comment whose id appears in it. An inline
   * comment NOT in the map keeps `resolved` absent (unknown — never coerced to
   * false); issue-comment and review-summary always stay absent (threads are
   * inline-only).
   *
   * Load-bearing fail-soft: the entire GraphQL pass (exec + parse + mapping) is
   * wrapped in try/catch. On ANY failure we return the REST comments untouched
   * with every `resolved` absent, rather than throwing — a missing resolution
   * signal must degrade to "unknown", not block the whole read.
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

      // Paginate `reviewThreads` with an `after` cursor so resolution is
      // enriched for EVERY thread, not just the first 100 — on a large PR the
      // overflow threads would otherwise keep `resolved` absent (unknown). Inner
      // `comments(first:100)` stays single-page: >100 replies in ONE thread is
      // not a realistic shape, and an overflow there still degrades safe (absent
      // → surfaced, never wrongly resolved).
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
      // Defensive page cap (50 × 100 = 5000 threads) so a misbehaving
      // `pageInfo` can never spin this into an unbounded loop.
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
      // GraphQL enrichment is best-effort — any failure leaves every
      // `resolved` absent (unknown), and getPrComments still returns the
      // REST comments rather than throwing.
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
