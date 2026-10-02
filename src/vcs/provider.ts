/**
 * Provider interface for version control operations on GitHub, GitLab, and Azure DevOps.
 */
export interface CreatePrOpts {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft?: boolean | undefined;
  readonly labels?: readonly string[] | undefined;
}

export interface PrResult {
  readonly url: string;
  readonly number: number;
}

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending' | 'skipped';
  readonly url?: string | undefined;
}

export interface CiStatus {
  readonly status: 'pass' | 'fail' | 'pending';
  readonly checks: readonly CiCheck[];
}

/**
 * Folds the per-check statuses into one overall CI verdict. The `checkCi` method of each of the three providers uses it.
 * Any `fail` check gives `fail`. Otherwise any `pending` check gives `pending`.
 * Otherwise the result is `pass`, also for an empty list. The function is pure.
 */
export function computeOverallCiStatus(
  checks: readonly CiCheck[],
): CiStatus['status'] {
  const hasFailure = checks.some((c) => c.status === 'fail');
  if (hasFailure) return 'fail';

  const hasPending = checks.some((c) => c.status === 'pending');
  if (hasPending) return 'pending';

  return 'pass';
}

export interface MergeResult {
  readonly merged: boolean;
  readonly sha?: string;
  readonly error?: string;
}

export interface ReviewerStatus {
  readonly login: string;
  readonly state: 'approved' | 'changes_requested' | 'pending' | 'commented';
}

export interface ReviewStatus {
  readonly state: 'approved' | 'changes_requested' | 'pending';
  readonly reviewers: readonly ReviewerStatus[];
}

export interface PrFilter {
  readonly state?: 'open' | 'closed' | 'merged' | 'all' | undefined;
  readonly head?: string | undefined;
  readonly base?: string | undefined;
}

export interface PrSummary {
  readonly number: number;
  readonly url: string;
  readonly title: string;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly state: string;
}

/**
 * One piece of PR feedback in a shape that is the same for all providers.
 * The `source` field names the kind of feedback, not a provider endpoint or field.
 */
export interface PrComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  /**
   * Kind of feedback:
   *  - `'issue-comment'`: PR-level conversation, not anchored to a diff line.
   *  - `'review-inline'`: a review thread anchored to `path` and `line`.
   *  - `'review-summary'`: the body of a review submission. `state` holds the review state.
   */
  readonly source: 'issue-comment' | 'review-inline' | 'review-summary';
  readonly path?: string | undefined;
  readonly line?: number | undefined;
  /**
   * Id of the top-level comment that this reply answers. Threading has one level only.
   * When it is absent, the comment is top-level.
   */
  readonly parentId?: number;
  /**
   * `true` is resolved, `false` is explicitly unresolved, and absent is unknown.
   * Consumers must not convert absent to `false`. Use {@link isResolvedKnown}.
   */
  readonly resolved?: boolean;
  /**
   * Review state for `source: 'review-summary'`, such as `'APPROVED'`. It is absent on other sources.
   * It is a string, not a provider enum, so the contract stays the same for all providers.
   */
  readonly state?: string;
}

/** True when `resolved` is an explicit boolean. It lets consumers tell "unknown" from "unresolved". */
export function isResolvedKnown(comment: PrComment): boolean {
  return comment.resolved !== undefined;
}

/**
 * Number of newest comments that a read returns when the caller omits `limit`.
 * It keeps a default read well under the output-token budget. One measured PR had 85 comments and 37,613 tokens.
 * The `page` metadata and the notice keep the other comments reachable.
 */
export const DEFAULT_PR_COMMENTS_LIMIT = 20;

/**
 * Window and projection inputs for a paged PR-comments read.
 * An omitted `limit` is {@link DEFAULT_PR_COMMENTS_LIMIT}. An omitted or negative `offset` is `0`.
 * An omitted or empty `fields` returns every comment key.
 */
export interface GetPrCommentsOptions {
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  readonly fields?: readonly string[] | undefined;
}

/**
 * Pagination metadata of a windowed read. `total` is the count before the window, and `offset` and `limit` are the window.
 * `hasMore` is true when comments remain after this page.
 */
export interface PageMeta {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * Windowed and projected result of a PR-comments read. `comments` holds at most `page.limit` entries, newest first.
 * With `fields`, each entry holds only those keys, so the type is `Partial<PrComment>`.
 * `notice` is present only when `page.hasMore` is true, and tells the reader how to page or project.
 */
export interface PrCommentsPage {
  readonly comments: readonly Partial<PrComment>[];
  readonly page: PageMeta;
  readonly notice?: string;
}

/**
 * Converts an optional `limit` to a positive integer, with the default for an invalid value.
 * It must never return 0. A fraction in (0, 1) floors to 0, and a zero-sized page reports `hasMore: true` forever.
 */
function normalizePrCommentsLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PR_COMMENTS_LIMIT;
  }
  const normalized = Math.floor(limit);
  return normalized > 0 ? normalized : DEFAULT_PR_COMMENTS_LIMIT;
}

/** Converts an optional `offset` to a non-negative integer, with 0 for an invalid value. */
function normalizePrCommentsOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

/**
 * Newest-first comparator. `createdAt` is ISO-8601, so a lexical compare is a chronological compare.
 * Ties break by `id` descending, so paging is deterministic when two comments share a timestamp.
 */
function compareNewestFirst(a: PrComment, b: PrComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/** Keeps only the requested keys of a comment that are present and defined. */
function projectComment(comment: PrComment, fields: readonly string[]): Partial<PrComment> {
  const source = comment as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source && source[field] !== undefined) {
      out[field] = source[field];
    }
  }
  return out as Partial<PrComment>;
}

/**
 * Windows and projects a full comment list into a bounded {@link PrCommentsPage}. It is pure.
 * A provider without `getPrCommentsPage` gets this helper over its `getPrComments` result, so the contract is the same.
 * The order is newest first, and the window is `[offset, offset+limit)`.
 * A non-empty `fields` keeps only those keys. A `notice` is present only when comments remain after the window.
 */
export function windowPrComments(
  comments: readonly PrComment[],
  opts?: GetPrCommentsOptions,
): PrCommentsPage {
  const total = comments.length;
  const offset = normalizePrCommentsOffset(opts?.offset);
  const limit = normalizePrCommentsLimit(opts?.limit);

  const ordered = [...comments].sort(compareNewestFirst);
  const windowed = ordered.slice(offset, offset + limit);
  const projected =
    opts?.fields && opts.fields.length > 0
      ? windowed.map((c) => projectComment(c, opts.fields as readonly string[]))
      : windowed;

  const hasMore = offset + windowed.length < total;
  const page: PageMeta = { total, offset, limit, hasMore };

  if (!hasMore) {
    return { comments: projected, page };
  }
  const notice =
    `Showing ${windowed.length} of ${total} comments (newest first). ` +
    `Narrow with limit/offset to page, or fields=[...] to project keys.`;
  return { comments: projected, page, notice };
}

export interface CreateIssueOpts {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[] | undefined;
  readonly assignees?: readonly string[] | undefined;
}

export interface IssueResult {
  readonly number: number;
  readonly url: string;
}

/**
 * Issue found by `VcsProvider.searchIssuesByMarker`. The recovery precheck in `handleCreateIssue` uses it.
 */
export interface IssueSearchSummary {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

export interface RepoInfo {
  readonly nameWithOwner: string;
  readonly defaultBranch: string;
}

/**
 * Result of {@link VcsProvider.addReply}. `id` identifies the new reply comment.
 * On GitHub it is the `pulls/comments` databaseId, the same id space as {@link PrComment.id} for `review-inline` comments.
 * Consumers use it to find the reply in a later `getPrComments` read.
 */
export interface ReplyResult {
  readonly id: number;
}

export interface VcsProvider {
  readonly name: 'github' | 'gitlab' | 'azure-devops';
  createPr(opts: CreatePrOpts): Promise<PrResult>;
  checkCi(prId: string): Promise<CiStatus>;
  mergePr(prId: string, strategy: string): Promise<MergeResult>;
  addComment(prId: string, body: string): Promise<void>;
  /**
   * Posts a reply in a review-comment thread, so the reply nests under that comment.
   * {@link addComment} posts a PR-level comment that is not in a thread.
   * `threadId` is the {@link PrComment.id} of the top-level `review-inline` comment. A reply attaches to that comment, not to another reply.
   * An implementation without thread replies must throw {@link UnsupportedOperationError}, and must not do nothing.
   */
  addReply(prId: string, threadId: string, body: string): Promise<ReplyResult>;
  getReviewStatus(prId: string): Promise<ReviewStatus>;
  listPrs(filter?: PrFilter): Promise<PrSummary[]>;
  getPrComments(prId: string): Promise<PrComment[]>;
  /**
   * Windowed and projected read of PR comments for the read-only tool.
   * Internal callers that need the full feed use {@link getPrComments}.
   * This method is optional. For a provider without it, the caller applies {@link windowPrComments} to {@link getPrComments}.
   */
  getPrCommentsPage?(prId: string, opts?: GetPrCommentsOptions): Promise<PrCommentsPage>;
  getPrDiff(prId: string): Promise<string>;
  createIssue(opts: CreateIssueOpts): Promise<IssueResult>;
  /**
   * Searches the current repository for issues whose body holds the marker `<!-- exarchos-op:UUID -->`.
   * The create-issue recovery precheck uses it to find an issue that exists but has no `issue.create.executed` event.
   * An empty array means no match. A provider failure must throw, and must not return `[]`.
   */
  searchIssuesByMarker(operationId: string): Promise<IssueSearchSummary[]>;
  getRepository(): Promise<RepoInfo>;
}

export class UnsupportedOperationError extends Error {
  readonly operation: string;
  readonly provider: string;
  constructor(provider: string, operation: string) {
    super(`${provider}: ${operation} is not yet supported`);
    this.name = 'UnsupportedOperationError';
    this.provider = provider;
    this.operation = operation;
  }
}
