// ─── VCS Provider Interface ──────────────────────────────────────────────────
//
// Abstraction layer for version control system operations.
// Enables Exarchos to work with GitHub, GitLab, and Azure DevOps.

export interface CreatePrOpts {
  readonly title: string;
  readonly body: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft?: boolean;
  readonly labels?: readonly string[];
}

export interface PrResult {
  readonly url: string;
  readonly number: number;
}

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending' | 'skipped';
  readonly url?: string;
}

export interface CiStatus {
  readonly status: 'pass' | 'fail' | 'pending';
  readonly checks: readonly CiCheck[];
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
  readonly state?: 'open' | 'closed' | 'merged' | 'all';
  readonly head?: string;
  readonly base?: string;
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
 * A single piece of PR feedback, normalized across providers.
 *
 * Three feedback surfaces collapse into one platform-neutral shape via
 * `source`:
 *  - `'issue-comment'`   — PR-level conversation (the shared discussion thread,
 *                          not anchored to a diff line).
 *  - `'review-inline'`   — a per-line review thread anchored to `path`/`line`.
 *  - `'review-summary'`  — the body of a review submission (its top-level
 *                          verdict); `state` carries the review state.
 * The discriminant is named for the feedback *kind*, never for a provider's
 * endpoint or field (e.g. not GitHub's `subject_type`), so consumers stay
 * provider-agnostic.
 *
 * Threading is **one level only**: a reply sets `parentId` to the id of the
 * top-level comment it answers; a reply's parent is always top-level. We do not
 * model deeper nesting. An absent `parentId` means the comment is top-level.
 *
 * `resolved` is **tri-state** and the distinction is load-bearing:
 *  - `true`              — the thread is resolved.
 *  - `false`             — the thread is explicitly unresolved.
 *  - absent / `undefined`— resolution status is *unknown* (e.g. the provider
 *                          does not report it for this surface). Consumers MUST
 *                          treat absent as "unknown" and MUST NOT coerce it to
 *                          `false`. Use {@link isResolvedKnown} to gate on this.
 */
export interface PrComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  /**
   * Which feedback surface this comment came from. Platform-neutral
   * discriminant — see the interface doc for the three kinds.
   */
  readonly source: 'issue-comment' | 'review-inline' | 'review-summary';
  readonly path?: string;
  readonly line?: number;
  /**
   * Id of the top-level comment this one replies to (one-level threading).
   * Absent ⇒ this comment is top-level.
   */
  readonly parentId?: number;
  /**
   * Tri-state resolution status: `true` (resolved), `false` (explicitly
   * unresolved), absent (unknown — NOT false). Never coerce absent to `false`.
   */
  readonly resolved?: boolean;
  /**
   * For `source: 'review-summary'`, the review state (e.g. `'APPROVED'`,
   * `'CHANGES_REQUESTED'`, `'COMMENTED'`). Absent on non-summary sources. A
   * string, not a provider-specific enum, to keep the contract platform-neutral.
   */
  readonly state?: string;
}

/**
 * Whether a comment's resolution status is *known* — i.e. `resolved` was set to
 * an explicit boolean rather than left absent. Returns `false` for the absent
 * (unknown) case so consumers can distinguish "unknown" from "unresolved"
 * instead of silently coercing absent → `false`.
 */
export function isResolvedKnown(comment: PrComment): boolean {
  return comment.resolved !== undefined;
}

// ─── DR-3: get_pr_comments window + projection ───────────────────────────────

/**
 * Default number of (newest-first) comments returned when the caller omits
 * `limit`. Chosen to keep a default read well under the output-token budget: the
 * audit measured an 85-comment PR at 37,613 tokens unbounded, and windowing to
 * the newest ~20 collapses that to a fraction while the `page` metadata + steer
 * notice keep the rest reachable. An explicit `limit` overrides it.
 */
export const DEFAULT_PR_COMMENTS_LIMIT = 20;

/**
 * Window + projection inputs for a paged {@link VcsProvider.getPrCommentsPage}
 * read (DR-3). All optional: an omitted `limit` defaults to
 * {@link DEFAULT_PR_COMMENTS_LIMIT}, an omitted/negative `offset` is `0`, and an
 * omitted/empty `fields` returns every comment key.
 */
export interface GetPrCommentsOptions {
  readonly limit?: number;
  readonly offset?: number;
  readonly fields?: readonly string[];
}

/**
 * Pagination metadata attached to a windowed read: `total` is the full
 * pre-window count, `offset`/`limit` are the effective window, and `hasMore`
 * says whether comments remain past this page (so a client knows to advance
 * `offset`). Provider-neutral — the same shape every provider returns.
 */
export interface PageMeta {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * Windowed + projected result of a PR-comments read (DR-3).
 *
 * `comments` is at most `page.limit` entries, newest-first. Each entry is a
 * {@link PrComment} when no projection was requested, or a partial carrying ONLY
 * the {@link GetPrCommentsOptions.fields} keys otherwise — hence
 * `Partial<PrComment>`. `notice`, present only when `page.hasMore`, is a
 * human-readable steer toward a narrower/paged call.
 */
export interface PrCommentsPage {
  readonly comments: readonly Partial<PrComment>[];
  readonly page: PageMeta;
  readonly notice?: string;
}

/** Coerce an optional `limit` to a positive integer, defaulting when invalid. */
function normalizePrCommentsLimit(limit?: number): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_PR_COMMENTS_LIMIT;
  }
  return Math.floor(limit);
}

/** Coerce an optional `offset` to a non-negative integer, defaulting to 0. */
function normalizePrCommentsOffset(offset?: number): number {
  if (offset === undefined || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

/**
 * Newest-first comparator. `createdAt` is ISO-8601, so a lexical compare is a
 * chronological compare; ties break by `id` descending so paging is fully
 * deterministic even when two comments share a timestamp.
 */
function compareNewestFirst(a: PrComment, b: PrComment): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return b.id - a.id;
}

/** Project a comment to ONLY the requested keys (present, defined ones). */
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
 * Window + project a provider's full comment list into a bounded {@link
 * PrCommentsPage} (DR-3). Pure and provider-agnostic: EVERY provider funnels its
 * raw {@link VcsProvider.getPrComments} result through this one helper, so the
 * window/projection contract is identical across GitHub/GitLab/ADO and callers
 * of providers that don't override {@link VcsProvider.getPrCommentsPage} get the
 * same behavior via this function directly.
 *
 * Ordering is newest-first (see {@link compareNewestFirst}); the window is
 * `[offset, offset+limit)`; `fields`, when non-empty, projects each entry to
 * only those keys. A `notice` is attached iff the window truncated the set.
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
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface IssueResult {
  readonly number: number;
  readonly url: string;
}

/**
 * Summary of an issue surfaced by a marker-based search. Returned by
 * `VcsProvider.searchIssuesByMarker` to support the two-event-split recovery
 * precheck in `handleCreateIssue` (CodeRabbit #3224631237).
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
 * Result of posting a reply to an existing comment thread via
 * {@link VcsProvider.addReply}.
 *
 * `id` is the provider's identifier for the newly created reply comment — on
 * GitHub this is the `pulls/comments` databaseId, the same id space that
 * {@link PrComment.id} carries for `review-inline` comments. Consumers use it to
 * correlate the posted reply back to a later `getPrComments` read (e.g. the
 * marker-scan verification in the add-comment handler).
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
   * Post a reply into an existing per-thread review-comment conversation.
   *
   * This is the thread-aware sibling of {@link addComment}: `addComment` posts
   * a PR-level conversation comment (not anchored to any thread), whereas
   * `addReply` answers a specific review-comment thread so the response nests
   * under the comment it addresses.
   *
   * - `prId`     — the pull/merge request id.
   * - `threadId` — the id of the top-level review comment to reply to. This is
   *                the same id space as {@link PrComment.id} for a
   *                `review-inline` comment (and the value carried by
   *                {@link PrComment.parentId} on its replies). Threading is one
   *                level only: replies attach to the top-level comment, not to
   *                other replies.
   * - `body`     — the reply text.
   *
   * Returns the {@link ReplyResult} for the newly created reply. Implementations
   * that do not yet support thread replies MUST throw
   * {@link UnsupportedOperationError} (never silently no-op), matching the
   * convention used by other not-yet-implemented provider methods.
   */
  addReply(prId: string, threadId: string, body: string): Promise<ReplyResult>;
  getReviewStatus(prId: string): Promise<ReviewStatus>;
  listPrs(filter?: PrFilter): Promise<PrSummary[]>;
  getPrComments(prId: string): Promise<PrComment[]>;
  /**
   * DR-3 — windowed + projected read of PR comments. Returns the newest `limit`
   * comments (default {@link DEFAULT_PR_COMMENTS_LIMIT}) starting at `offset`,
   * projected to {@link GetPrCommentsOptions.fields} when given, plus `page`
   * metadata and a truncation `notice`. Internal callers that need the FULL
   * feed (e.g. the add-comment verify scan, assess-stack) keep using
   * {@link getPrComments}; this is the bounded surface for the read-only tool.
   *
   * OPTIONAL by design: providers that don't override it are windowed by the
   * caller via {@link windowPrComments} over their {@link getPrComments} result,
   * so the GitLab/ADO partials keep their existing behavior unchanged — no new
   * provider method to implement, no throw-behavior to alter.
   */
  getPrCommentsPage?(prId: string, opts?: GetPrCommentsOptions): Promise<PrCommentsPage>;
  getPrDiff(prId: string): Promise<string>;
  createIssue(opts: CreateIssueOpts): Promise<IssueResult>;
  /**
   * Search issues whose body contains the operationId marker
   * `<!-- exarchos-op:UUID -->`. Used by the create-issue handler's recovery
   * precheck to detect crash-recovery cases where the issue was created on
   * the remote but `issue.create.executed` was never committed.
   *
   * Implementations should query the provider's search surface scoped to the
   * current repository. Empty array means "no match" — distinct from a
   * provider failure (which must throw and not return []).
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
