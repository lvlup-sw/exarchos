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

export interface VcsProvider {
  readonly name: 'github' | 'gitlab' | 'azure-devops';
  createPr(opts: CreatePrOpts): Promise<PrResult>;
  checkCi(prId: string): Promise<CiStatus>;
  mergePr(prId: string, strategy: string): Promise<MergeResult>;
  addComment(prId: string, body: string): Promise<void>;
  getReviewStatus(prId: string): Promise<ReviewStatus>;
  listPrs(filter?: PrFilter): Promise<PrSummary[]>;
  getPrComments(prId: string): Promise<PrComment[]>;
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
