/**
 * The `assess_stack` composite action. It checks the health of a PR stack for
 * the shepherd loop, which runs inside the `synthesize` phase.
 *
 * For each PR it queries CI, reviews, and comments through `VcsProvider`. It
 * appends `ci.status` for each PR and `ci.check_observed` for each check. The
 * result holds one truncated copy of each comment body, the check counts, and
 * only the failing checks in detail, so the output stays small.
 */

import type { VcsProvider, CiStatus, PrComment as VcsPrComment } from '../../vcs/provider.js';
import { createVcsProvider } from '../../vcs/factory.js';
import type { EventStore } from '../../events/store.js';
import type { ToolResult } from '../../format.js';
import type { ResolvedProjectConfig } from '../../config/resolve.js';
import { orchestrateLogger } from '../../logger.js';
import {
  countShepherdIterations,
  resolveEscalationPolicy,
  DEFAULT_MAX_ITERATIONS,
} from '../review/escalation-policy.js';

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending';
  readonly url?: string | undefined;
}

/**
 * The check counts for one PR. Only failing checks need action, so only they
 * keep full detail, in {@link PrStatus.failingChecks}. Event emission still
 * appends one `ci.check_observed` for each check.
 */
export interface CheckCounts {
  readonly pass: number;
  readonly fail: number;
  readonly pending: number;
}

/**
 * The comment window of one PR. `assess_stack` caps `unresolvedComments` to a
 * page, so one PR with many comments cannot exceed the output budget.
 * `hasMore`, `offset`, and `limit` let the shepherd loop read the next page.
 */
export interface CommentPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * A reference from an action item to the unresolved comment that produced it.
 * The comment body lives once, in `status.prs[…].unresolvedComments[…]`, with
 * the same `commentId` on the same PR. The reference travels on
 * `ActionItem.raw`, which has the type `unknown`.
 */
export interface CommentRef {
  readonly pr: number;
  readonly commentId: number;
}

interface PrReview {
  readonly state: string;
  readonly author: string;
}

interface PrComment {
  /** A stable id. It matches {@link CommentRef.commentId} for this PR. */
  readonly id: number;
  /** The truncated body. This is the only copy of the body in the result. */
  readonly body: string;
  readonly isResolved: boolean;
  /**
   * The adapter classification, without its `raw` copy. The top-level action
   * item carries a {@link CommentRef} back to this comment.
   */
  readonly actionItem?: ActionItem;
  /**
   * The feedback surface of the comment, for observability only. The harvest
   * loop treats every source the same.
   */
  readonly source?: VcsPrComment['source'];
  /** The parent comment id of a threaded reply, for observability only. */
  readonly parentId?: number;
}

export interface PrStatus {
  readonly pr: number;
  readonly checkCounts: CheckCounts;
  readonly failingChecks: readonly CiCheck[];
  readonly overallCi: 'pass' | 'fail' | 'pending';
  readonly reviews: readonly PrReview[];
  readonly unresolvedComments: readonly PrComment[];
  readonly commentPage: CommentPage;
}

/**
 * The internal working set for one PR, which is not serialized. It holds every
 * check and unresolved comment for event emission, classification, and the
 * recommendation. {@link buildPrStatus} projects it to the windowed {@link PrStatus}.
 */
interface PrAssessment {
  readonly pr: number;
  readonly checks: readonly CiCheck[];
  readonly overallCi: 'pass' | 'fail' | 'pending';
  readonly reviews: readonly PrReview[];
  readonly comments: readonly PrComment[];
}

import type { Severity, ReviewerKind, ActionItem, ReviewAdapterRegistry } from '../../review/types.js';
import { createReviewAdapterRegistry, detectKind } from '../../review/registry.js';
export type { Severity, ReviewerKind, ActionItem };

export interface ShepherdStatusState {
  readonly prs: readonly PrStatus[];
  readonly iterationCount: number;
}

export interface AssessStackResult {
  readonly status: ShepherdStatusState;
  readonly actionItems: readonly ActionItem[];
  readonly recommendation: 'request-approval' | 'fix-and-resubmit' | 'wait' | 'escalate';
}

/**
 * The default auto-fix bound for the shepherd loop, equal to the fallback of
 * `resolveEscalationPolicy`. The handler resolves the live bound from config.
 */
const MAX_SHEPHERD_ITERATIONS = DEFAULT_MAX_ITERATIONS;

const COMMENT_BODY_LIMIT = 200;

/** The page size for the unresolved comments of one PR when `limit` is absent. */
const DEFAULT_COMMENT_PAGE_LIMIT = 20;
/** The highest page size, so an explicit `limit` cannot request an unbounded window. */
const MAX_COMMENT_PAGE_LIMIT = 100;

function truncateBody(body: string): string {
  if (body.length <= COMMENT_BODY_LIMIT) return body;
  return body.slice(0, COMMENT_BODY_LIMIT) + '...';
}

export interface CommentWindow {
  readonly limit: number;
  readonly offset: number;
}

/**
 * Resolves the comment window from the optional paging inputs. The function
 * floors each value before it checks it. A limit below 1 after the floor gets
 * the default, so `0.5` does not give an empty page. A limit above the cap
 * gets the cap. An offset below 1 after the floor becomes 0.
 */
export function resolveCommentWindow(limit?: number, offset?: number): CommentWindow {
  const flooredLimit =
    typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : NaN;
  const l =
    flooredLimit >= 1
      ? Math.min(flooredLimit, MAX_COMMENT_PAGE_LIMIT)
      : DEFAULT_COMMENT_PAGE_LIMIT;

  const flooredOffset =
    typeof offset === 'number' && Number.isFinite(offset) ? Math.floor(offset) : NaN;
  const o = flooredOffset >= 1 ? flooredOffset : 0;

  return { limit: l, offset: o };
}

function countChecks(checks: readonly CiCheck[]): CheckCounts {
  let pass = 0;
  let fail = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.status === 'pass') pass += 1;
    else if (c.status === 'fail') fail += 1;
    else pending += 1;
  }
  return { pass, fail, pending };
}

/**
 * Removes the `raw` comment copy from an adapter action item. Downstream code
 * reads only the classified fields. The top-level action item gets a
 * {@link CommentRef} instead.
 */
function withoutRaw(item: ActionItem): ActionItem {
  const { raw: _raw, ...rest } = item;
  return rest;
}

/**
 * Maps a provider check to a {@link CiCheck}. A skipped check counts as a pass,
 * and an unknown status counts as pending.
 */
function mapCiCheck(check: { name: string; status: string; url?: string | undefined }): CiCheck {
  const statusMap: Record<string, 'pass' | 'fail' | 'pending'> = {
    pass: 'pass',
    fail: 'fail',
    pending: 'pending',
    skipped: 'pass',
  };
  return {
    name: check.name,
    status: statusMap[check.status] ?? 'pending',
    url: check.url,
  };
}

async function queryPrChecks(provider: VcsProvider, prNumber: number): Promise<CiCheck[]> {
  try {
    const ciStatus: CiStatus = await provider.checkCi(String(prNumber));
    return ciStatus.checks.map(mapCiCheck);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    orchestrateLogger.warn({ prNumber, err: message }, 'Failed to query checks');
    return [];
  }
}

async function queryPrReviews(provider: VcsProvider, prNumber: number): Promise<PrReview[]> {
  try {
    const reviewStatus = await provider.getReviewStatus(String(prNumber));
    return reviewStatus.reviewers.map(r => ({
      state: r.state === 'approved' ? 'APPROVED' :
             r.state === 'changes_requested' ? 'CHANGES_REQUESTED' :
             r.state === 'commented' ? 'COMMENTED' : 'PENDING',
      author: r.login,
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    orchestrateLogger.warn({ prNumber, err: message }, 'Failed to query reviews');
    return [];
  }
}

/**
 * Reads the PR feedback feed and classifies each comment with its reviewer
 * adapter.
 *
 * Only `resolved === true` marks a comment as resolved. An absent value is
 * unknown, and that comment still needs attention. An adapter that throws does
 * not stop the batch. The function appends `provider.parse-error` and keeps
 * the comment without an action item.
 */
async function queryPrComments(
  provider: VcsProvider,
  prNumber: number,
  registry: ReviewAdapterRegistry,
  eventStore: EventStore,
  featureId: string,
): Promise<PrComment[]> {
  try {
    const comments: VcsPrComment[] = await provider.getPrComments(String(prNumber));
    const results: PrComment[] = [];
    for (const c of comments) {
      const kind = detectKind(c.author);
      const adapter = registry.forReviewer(kind);
      let actionItem: ActionItem | undefined;
      try {
        const parsed = adapter?.parse(c) ?? undefined;
        actionItem = parsed ? { ...parsed, pr: prNumber } : undefined;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        orchestrateLogger.warn(
          { prNumber, commentId: c.id, reviewer: kind, err: errorMessage },
          'Review adapter threw while parsing comment; skipping item',
        );
        await eventStore.append(featureId, {
          type: 'provider.parse-error' as const,
          data: {
            reviewer: kind,
            commentId: c.id,
            errorMessage,
          },
        }, {
          idempotencyKey: `${featureId}:provider.parse-error:${prNumber}:${c.id}`,
        });
      }
      if (actionItem?.unknownTier) {
        await eventStore.append(featureId, {
          type: 'provider.unknown-tier' as const,
          data: {
            reviewer: actionItem.reviewer ?? kind,
            commentId: c.id,
            ...(actionItem.rawTier ? { rawTier: actionItem.rawTier } : {}),
          },
        }, {
          idempotencyKey: `${featureId}:provider.unknown-tier:${prNumber}:${c.id}`,
        });
      }
      results.push({
        id: c.id,
        body: truncateBody(c.body),
        isResolved: c.resolved === true,
        ...(actionItem ? { actionItem: withoutRaw(actionItem) } : {}),
        source: c.source,
        ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
      });
    }
    return results;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    orchestrateLogger.warn({ prNumber, err: message }, 'Failed to query comments');
    return [];
  }
}

function computeOverallCi(checks: readonly CiCheck[]): 'pass' | 'fail' | 'pending' {
  if (checks.length === 0) return 'pending';
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'pending')) return 'pending';
  return 'pass';
}

async function assessPr(
  provider: VcsProvider,
  prNumber: number,
  registry: ReviewAdapterRegistry,
  eventStore: EventStore,
  featureId: string,
): Promise<PrAssessment> {
  const checks = await queryPrChecks(provider, prNumber);
  const reviews = await queryPrReviews(provider, prNumber);
  const allComments = await queryPrComments(provider, prNumber, registry, eventStore, featureId);
  const comments = allComments.filter(c => !c.isResolved);

  return {
    pr: prNumber,
    checks,
    overallCi: computeOverallCi(checks),
    reviews,
    comments,
  };
}

/**
 * Projects the full {@link PrAssessment} onto the windowed {@link PrStatus}.
 * Checks become counts plus the failing checks. The comment list is cut to the
 * window, and `commentPage` reports the full total and `hasMore`.
 */
function buildPrStatus(a: PrAssessment, window: CommentWindow): PrStatus {
  const unresolvedComments = a.comments.slice(window.offset, window.offset + window.limit);
  return {
    pr: a.pr,
    checkCounts: countChecks(a.checks),
    failingChecks: a.checks.filter(c => c.status === 'fail'),
    overallCi: a.overallCi,
    reviews: a.reviews,
    unresolvedComments,
    commentPage: {
      total: a.comments.length,
      offset: window.offset,
      limit: window.limit,
      hasMore: window.offset + window.limit < a.comments.length,
    },
  };
}

/**
 * Builds the action items: `ci-fix` for each failing check, `comment-reply`
 * for each unresolved comment, and `review-address` for each change request.
 * A comment without an adapter item gets the normalized severity MEDIUM.
 */
export function classifyActionItems(assessments: readonly PrAssessment[]): ActionItem[] {
  const items: ActionItem[] = [];

  for (const a of assessments) {
    for (const check of a.checks) {
      if (check.status === 'fail') {
        items.push({
          type: 'ci-fix',
          pr: a.pr,
          description: `CI check '${check.name}' is failing`,
          severity: 'critical',
          normalizedSeverity: 'HIGH',
        });
      }
    }

    for (const comment of a.comments) {
      const adapterItem = comment.actionItem;
      items.push({
        type: 'comment-reply',
        pr: a.pr,
        description: adapterItem?.description
          ?? `Unresolved comment: ${comment.body.slice(0, 100)}`,
        severity: 'major',
        normalizedSeverity: adapterItem?.normalizedSeverity ?? 'MEDIUM',
        ...(adapterItem?.reviewer ? { reviewer: adapterItem.reviewer } : {}),
        ...(adapterItem?.file ? { file: adapterItem.file } : {}),
        ...(adapterItem?.line !== undefined ? { line: adapterItem.line } : {}),
        ...(adapterItem?.threadId ? { threadId: adapterItem.threadId } : {}),
        raw: { pr: a.pr, commentId: comment.id } satisfies CommentRef,
      });
    }

    for (const review of a.reviews) {
      if (review.state === 'CHANGES_REQUESTED') {
        items.push({
          type: 'review-address',
          pr: a.pr,
          description: `Changes requested by ${review.author}`,
          severity: 'major',
          normalizedSeverity: 'HIGH',
        });
      }
    }
  }

  return items;
}

/**
 * Picks the next shepherd step. At the iteration bound it escalates. A critical
 * or major item means fix and resubmit. Pending CI means wait. Otherwise it
 * requests approval.
 */
export function computeRecommendation(
  actionItems: readonly ActionItem[],
  iterationCount: number,
  prStatuses?: readonly Pick<PrAssessment, 'overallCi'>[],
  maxIterations: number = MAX_SHEPHERD_ITERATIONS,
): 'request-approval' | 'fix-and-resubmit' | 'wait' | 'escalate' {
  if (iterationCount >= maxIterations) {
    return 'escalate';
  }

  const hasCritical = actionItems.some(item => item.severity === 'critical');
  const hasMajor = actionItems.some(item => item.severity === 'major');

  if (hasCritical || hasMajor) {
    return 'fix-and-resubmit';
  }

  const hasPendingCi = prStatuses?.some(pr => pr.overallCi === 'pending');
  if (hasPendingCi) {
    return 'wait';
  }

  return 'request-approval';
}

function toCiStatusSchemaValue(
  status: 'pass' | 'fail' | 'pending',
): 'passing' | 'failing' | 'pending' {
  if (status === 'pass') return 'passing';
  if (status === 'fail') return 'failing';
  return 'pending';
}

async function emitCiStatusEvents(
  eventStore: EventStore,
  featureId: string,
  prStatuses: readonly PrAssessment[],
  iterationCount: number,
): Promise<void> {
  for (const prStatus of prStatuses) {
    await eventStore.append(featureId, {
      type: 'ci.status' as const,
      data: {
        pr: prStatus.pr,
        status: toCiStatusSchemaValue(prStatus.overallCi),
      },
    }, {
      idempotencyKey: `${featureId}:ci.status:${prStatus.pr}:iter-${iterationCount}`,
    });
  }
}

/**
 * Appends one `ci.check_observed` row for each CI check, beside the per-PR
 * `ci.status` rows. External checks have their own event type, so their pass
 * rates do not mix with the gates that this repository runs. The field
 * `skill: 'shepherd'` keeps the measurement for each skill.
 */
async function emitCiCheckObservedEvents(
  eventStore: EventStore,
  featureId: string,
  prStatuses: readonly PrAssessment[],
  iterationCount: number,
): Promise<void> {
  for (const prStatus of prStatuses) {
    for (const check of prStatus.checks) {
      await eventStore.append(featureId, {
        type: 'ci.check_observed' as const,
        data: {
          pr: prStatus.pr,
          check: check.name,
          passed: check.status === 'pass',
          skill: 'shepherd',
        },
      }, {
        idempotencyKey: `${featureId}:ci.check_observed:${prStatus.pr}:${check.name}:iter-${iterationCount}`,
      });
    }
  }
}

/**
 * Counts the `shepherd.iteration` events with `countShepherdIterations`, not
 * an `iteration` value in a payload. The shepherd status view uses the same
 * rule, so the loop and `shepherd_status` agree on the count.
 */
async function getIterationCount(
  eventStore: EventStore,
  featureId: string,
): Promise<number> {
  const events = await eventStore.query(featureId, { type: 'shepherd.iteration' });
  return countShepherdIterations(events);
}

async function hasShepherdStarted(
  eventStore: EventStore,
  featureId: string,
): Promise<boolean> {
  const events = await eventStore.query(featureId, { type: 'shepherd.started' });
  return events.length > 0;
}

async function emitShepherdStarted(
  eventStore: EventStore,
  featureId: string,
): Promise<void> {
  await eventStore.append(featureId, {
    type: 'shepherd.started' as const,
    data: { featureId },
  }, {
    idempotencyKey: `${featureId}:shepherd.started`,
  });
}

async function emitShepherdApprovalRequested(
  eventStore: EventStore,
  featureId: string,
  prNumbers: readonly number[],
  iterationCount: number,
): Promise<void> {
  const prUrl = `PR#${prNumbers[0]}`;
  await eventStore.append(featureId, {
    type: 'shepherd.approval_requested' as const,
    data: { prUrl },
  }, {
    idempotencyKey: `${featureId}:shepherd.approval_requested:${iterationCount}`,
  });
}

/**
 * Appends a structured `shepherd.escalated` event when the loop reaches the
 * auto-fix bound. The handler then returns its normal result and does not
 * wait. The idempotency key holds `iterationCount`, so a second assessment at
 * the same count appends nothing new.
 */
async function emitShepherdEscalated(
  eventStore: EventStore,
  featureId: string,
  prNumbers: readonly number[],
  iterationCount: number,
  maxIterations: number,
): Promise<void> {
  const reason = `auto-fix bound (${maxIterations}) reached after ${iterationCount} iterations`;
  await eventStore.append(featureId, {
    type: 'shepherd.escalated' as const,
    data: {
      featureId,
      prNumbers: [...prNumbers],
      iterationCount,
      maxIterations,
      reason,
    },
  }, {
    idempotencyKey: `${featureId}:shepherd.escalated:${iterationCount}`,
  });
}

async function queryPrMergeState(provider: VcsProvider, prNumber: number): Promise<number | null> {
  try {
    const prs = await provider.listPrs({ head: undefined, state: 'all' });
    const pr = prs.find(p => p.number === prNumber);
    if (pr && pr.state === 'MERGED') {
      return prNumber;
    }
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    orchestrateLogger.warn({ prNumber, err: message }, 'Failed to query PR merge state');
    return null;
  }
}

async function emitShepherdCompleted(
  eventStore: EventStore,
  featureId: string,
  mergedPr: number,
): Promise<void> {
  const prUrl = `PR#${mergedPr}`;
  await eventStore.append(featureId, {
    type: 'shepherd.completed' as const,
    data: { prUrl, outcome: 'merged' },
  }, {
    idempotencyKey: `${featureId}:shepherd.completed`,
  });
}

/**
 * Assesses each PR of the stack and returns the shepherd recommendation.
 *
 * The handler has no provider gate. Each provider call works on GitLab and
 * ADO, or fails soft. Classification and the recommendation use every
 * unresolved comment, so a critical comment on a later page still counts. The
 * result shows only the comment window that `limit` and `offset` select. The
 * serialized `comment-reply` items use the same window, and the other items
 * repeat on each page. A merged PR or an earlier `shepherd.completed` event
 * stops the `shepherd.approval_requested` append.
 */
export async function handleAssessStack(
  args: {
    featureId: string;
    prNumbers: number[];
    limit?: number;
    offset?: number;
    projectConfig?: ResolvedProjectConfig;
  },
  _stateDir: string,
  injectedEventStore: EventStore,
  provider?: VcsProvider,
  registry: ReviewAdapterRegistry = createReviewAdapterRegistry(),
): Promise<ToolResult> {
  if (!args.featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  if (!args.prNumbers || args.prNumbers.length === 0) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prNumbers must be a non-empty array' },
    };
  }

  const vcs = provider ?? await createVcsProvider();
  const eventStore = injectedEventStore;

  const iterationCount = await getIterationCount(eventStore, args.featureId);

  const alreadyStarted = await hasShepherdStarted(eventStore, args.featureId);
  if (!alreadyStarted) {
    await emitShepherdStarted(eventStore, args.featureId);
  }

  const mergeResults = await Promise.all(
    args.prNumbers.map(pr => queryPrMergeState(vcs, pr)),
  );
  const mergedPr = mergeResults.find((pr) => pr !== null);
  const anyMerged = mergedPr !== undefined && mergedPr !== null;
  if (anyMerged) {
    await emitShepherdCompleted(eventStore, args.featureId, mergedPr);
  }

  const assessments = await Promise.all(
    args.prNumbers.map(pr => assessPr(vcs, pr, registry, eventStore, args.featureId)),
  );

  await emitCiStatusEvents(eventStore, args.featureId, assessments, iterationCount);
  await emitCiCheckObservedEvents(eventStore, args.featureId, assessments, iterationCount);

  const actionItems = classifyActionItems(assessments);

  const { maxIterations } = resolveEscalationPolicy({
    configMaxIterations: args.projectConfig?.escalation?.maxIterations,
  });

  const recommendation = computeRecommendation(
    actionItems,
    iterationCount,
    assessments,
    maxIterations,
  );

  if (recommendation === 'request-approval' && !anyMerged) {
    const completedEvents = await eventStore.query(args.featureId, { type: 'shepherd.completed' });
    if (completedEvents.length === 0) {
      await emitShepherdApprovalRequested(eventStore, args.featureId, args.prNumbers, iterationCount);
    }
  }

  if (recommendation === 'escalate') {
    await emitShepherdEscalated(
      eventStore,
      args.featureId,
      args.prNumbers,
      iterationCount,
      maxIterations,
    );
  }

  const window = resolveCommentWindow(args.limit, args.offset);
  const windowedAssessments = assessments.map(a => ({
    ...a,
    comments: a.comments.slice(window.offset, window.offset + window.limit),
  }));
  const serializedActionItems = classifyActionItems(windowedAssessments);

  const status: ShepherdStatusState = {
    prs: assessments.map(a => buildPrStatus(a, window)),
    iterationCount,
  };

  const result: AssessStackResult = {
    status,
    actionItems: serializedActionItems,
    recommendation,
  };

  return {
    success: true,
    data: result,
  };
}
