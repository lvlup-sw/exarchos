// ─── Assess Stack Composite Action ──────────────────────────────────────────
//
// Orchestrates PR stack health assessment for the shepherd iteration loop.
// Shepherd is NOT a separate HSM phase — it operates within the `synthesize`
// phase. This action queries CI status, reviews, and comments per PR via
// `VcsProvider`, then emits dual events: `ci.status` for ShepherdStatusView and
// `gate.executed` for CodeQualityView/flywheel pass rate tracking.
// ────────────────────────────────────────────────────────────────────────────

import type { VcsProvider, CiStatus, PrComment as VcsPrComment } from '../vcs/provider.js';
import { createVcsProvider } from '../vcs/factory.js';
import type { EventStore } from '../event-store/store.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import { orchestrateLogger } from '../logger.js';
import {
  countShepherdIterations,
  resolveEscalationPolicy,
  DEFAULT_MAX_ITERATIONS,
} from './escalation-policy.js';

// ─── Types (DR-2: minimal, single-copy comment shape) ───────────────────────
//
// The audit measured `assess_stack` returning 153,844 tokens on a 3-PR stack:
// the same comment text was serialized up to 4× (`fullBody`, the embedded
// `actionItem.raw` full-comment copy, the top-level `actionItems[].raw`
// full-comment copy, and the truncated `body`), and every CI check was emitted
// verbatim. DR-2 collapses this to ONE copy of each comment body (the truncated
// `body` on `unresolvedComments`), replaces the dead `raw` copies with a
// lightweight {@link CommentRef}, caps comments per PR with {@link CommentPage}
// metadata, and reduces `checks` to counts + failing-check detail.

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending';
  readonly url?: string;
}

/**
 * DR-2 per-PR check roll-up. Passing/pending checks carry no actionable detail,
 * so the RESULT surfaces only their counts; failing checks (the only ones a
 * shepherd acts on) keep their full detail in {@link PrStatus.failingChecks}.
 * This is a result-shape economy only — `emitGateExecutedEvents` still emits one
 * `gate.executed` per check from the internal full set, so per-check event
 * fidelity is unchanged.
 */
export interface CheckCounts {
  readonly pass: number;
  readonly fail: number;
  readonly pending: number;
}

/**
 * DR-2 per-PR comment-window descriptor. `assess_stack` caps the verbose,
 * body-carrying `unresolvedComments` list to a page so a single comment-heavy PR
 * cannot blow the output-token budget; `hasMore`/`offset`/`limit` steer the
 * shepherd loop to page through the rest (see the paging test).
 */
export interface CommentPage {
  readonly total: number;
  readonly offset: number;
  readonly limit: number;
  readonly hasMore: boolean;
}

/**
 * DR-2 reference from an action item back to the unresolved comment that
 * produced it. Replaces the former `raw` full-comment copy: the comment body
 * lives ONCE, in `status.prs[…].unresolvedComments[…]` (matched by `commentId`
 * on the same PR). Consumers resolve the reference there instead of re-reading a
 * duplicated body. Carried on `ActionItem.raw` (typed `unknown`), so no shared
 * `ActionItem` shape change is needed.
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
  readonly id: number;         // stable id; matches CommentRef.commentId for this PR
  readonly body: string;       // truncated for display — the ONLY copy of the body
  readonly isResolved: boolean;
  // Adapter-parsed classification (#1159). Its `raw` full-comment copy is
  // stripped (DR-2) — the top-level `actionItems[]` carries a {@link CommentRef}
  // pointing back here instead of a second body copy.
  readonly actionItem?: ActionItem;
  // Observability only — carried through from the unified PR-feedback feed so
  // callers can see which surface a comment came from and whether it threads a
  // reply. NOT a dispatch branch: the harvest loop treats every source the same
  // (INV-6). `source`/`parentId` are absent only when the provider omits them.
  readonly source?: VcsPrComment['source'];
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
 * Internal per-PR working set (NOT serialized). Carries the FULL check and
 * unresolved-comment lists so event emission, action-item classification, and
 * the recommendation see everything; {@link buildPrStatus} projects it to the
 * minimal, windowed {@link PrStatus} that ships in the result.
 */
interface PrAssessment {
  readonly pr: number;
  readonly checks: readonly CiCheck[];
  readonly overallCi: 'pass' | 'fail' | 'pending';
  readonly reviews: readonly PrReview[];
  readonly comments: readonly PrComment[];
}

import type { Severity, ReviewerKind, ActionItem, ReviewAdapterRegistry } from '../review/types.js';
import { createReviewAdapterRegistry, detectKind } from '../review/registry.js';
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

// ─── Constants ──────────────────────────────────────────────────────────────

// Module default auto-fix bound for the shepherd loop. It is the SAME value
// `resolveEscalationPolicy` falls back to (`DEFAULT_MAX_ITERATIONS`); the live
// bound is resolved per-dispatch from config (DR-3, #1595), not read from here.
const MAX_SHEPHERD_ITERATIONS = DEFAULT_MAX_ITERATIONS;

// ─── Comment Truncation & Windowing (DR-2) ──────────────────────────────────

const COMMENT_BODY_LIMIT = 200;

// Default per-PR unresolved-comment page size. Omitting `limit` caps the
// body-carrying list deterministically so one comment-heavy PR cannot blow the
// output-token budget; `commentPage.hasMore` steers the shepherd loop to page.
const DEFAULT_COMMENT_PAGE_LIMIT = 20;

function truncateBody(body: string): string {
  if (body.length <= COMMENT_BODY_LIMIT) return body;
  return body.slice(0, COMMENT_BODY_LIMIT) + '...';
}

interface CommentWindow {
  readonly limit: number;
  readonly offset: number;
}

// Resolve the per-PR comment window from the (optional, schema-declared) paging
// inputs, clamping to sane defaults. A missing/non-positive `limit` falls back
// to DEFAULT_COMMENT_PAGE_LIMIT; a missing/negative `offset` falls back to 0.
function resolveCommentWindow(limit?: number, offset?: number): CommentWindow {
  const l = typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : DEFAULT_COMMENT_PAGE_LIMIT;
  const o = typeof offset === 'number' && Number.isFinite(offset) && offset > 0
    ? Math.floor(offset)
    : 0;
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

// DR-2: drop the `raw` full-comment copy from an adapter-parsed action item.
// Everything downstream reads only the classified fields (description,
// normalizedSeverity, file, line, reviewer, threadId); the raw comment body is
// dead weight. The top-level action item re-attaches a lightweight CommentRef.
function withoutRaw(item: ActionItem): ActionItem {
  const { raw: _raw, ...rest } = item;
  return rest;
}

// ─── VcsProvider Query Helpers ──────────────────────────────────────────────

function mapCiCheck(check: { name: string; status: string; url?: string }): CiCheck {
  const statusMap: Record<string, 'pass' | 'fail' | 'pending'> = {
    pass: 'pass',
    fail: 'fail',
    pending: 'pending',
    skipped: 'pass', // treat skipped as pass for overall status
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

async function queryPrComments(
  provider: VcsProvider,
  prNumber: number,
  registry: ReviewAdapterRegistry,
  eventStore: EventStore,
  featureId: string,
): Promise<PrComment[]> {
  try {
    const comments: VcsPrComment[] = await provider.getPrComments(String(prNumber));
    // `getPrComments` now returns the unified, aggregated PR-feedback feed
    // (issue-comment | review-inline | review-summary, with one-level threading)
    // and a tri-state `resolved`. The github provider enriches review threads via
    // GraphQL; other surfaces leave `resolved` absent. We honor that tri-state
    // below: ONLY `resolved === true` is treated as resolved. Absent = unknown,
    // and an unknown-resolution comment still needs attention, so it stays
    // surfaced (absent ≠ false).
    const results: PrComment[] = [];
    for (const c of comments) {
      const kind = detectKind(c.author);
      const adapter = registry.forReviewer(kind);
      // Outer defensive wrap: even though adapters self-guard in their own
      // try/catch, a malformed comment or a bug in an adapter must not kill
      // the entire batch. On throw we record `provider.parse-error` for
      // observability and continue with actionItem=undefined (#1161).
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
        // Tri-state gate: resolved ONLY when the provider explicitly says so.
        // `resolved === false` and absent/unknown both stay unresolved.
        isResolved: c.resolved === true,
        // DR-2: keep the classified fields but drop the raw full-comment copy.
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

// DR-2: project the internal, full PrAssessment onto the minimal, windowed
// PrStatus that ships in the result. Checks collapse to counts + failing detail;
// the body-carrying unresolved-comment list is capped to the requested window
// with `commentPage` metadata reporting the full total + `hasMore`.
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

// ─── Action Item Classification ─────────────────────────────────────────────

export function classifyActionItems(assessments: readonly PrAssessment[]): ActionItem[] {
  const items: ActionItem[] = [];

  for (const a of assessments) {
    // CI failures -> ci-fix items
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

    // Unresolved comments -> comment-reply items
    for (const comment of a.comments) {
      // Thread the adapter-parsed fields when present (#1159);
      // fall back to MEDIUM when no adapter ran (registry omitted, edge case).
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
        // DR-2: reference into unresolvedComments (matched by pr + commentId)
        // instead of a second full-comment copy on `raw`.
        raw: { pr: a.pr, commentId: comment.id } satisfies CommentRef,
      });
    }

    // Review changes requested -> review-address items
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

// ─── Recommendation Logic ───────────────────────────────────────────────────

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

  // Pending CI should block approval — wait for checks to complete
  const hasPendingCi = prStatuses?.some(pr => pr.overallCi === 'pending');
  if (hasPendingCi) {
    return 'wait';
  }

  return 'request-approval';
}

// ─── Schema Value Mapping ────────────────────────────────────────────────────

function toCiStatusSchemaValue(
  status: 'pass' | 'fail' | 'pending',
): 'passing' | 'failing' | 'pending' {
  if (status === 'pass') return 'passing';
  if (status === 'fail') return 'failing';
  return 'pending';
}

// ─── Event Emission ─────────────────────────────────────────────────────────

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

async function emitGateExecutedEvents(
  eventStore: EventStore,
  featureId: string,
  prStatuses: readonly PrAssessment[],
  iterationCount: number,
): Promise<void> {
  for (const prStatus of prStatuses) {
    for (const check of prStatus.checks) {
      await eventStore.append(featureId, {
        type: 'gate.executed' as const,
        data: {
          gateName: check.name,
          layer: 'ci',
          passed: check.status === 'pass',
          details: {
            skill: 'shepherd',
            gate: check.name,
            pr: prStatus.pr,
          },
        },
      }, {
        idempotencyKey: `${featureId}:gate.executed:${prStatus.pr}:${check.name}:iter-${iterationCount}`,
      });
    }
  }
}

// ─── Iteration Count from Event Store ───────────────────────────────────────

// The loop's iteration count derives from the SINGLE event-sourced authority
// (`countShepherdIterations`, DR-3 #1595) — the number of `shepherd.iteration`
// events — NOT from any `iteration` value stamped in a payload. The shepherd-
// status view folds the same rule, so the loop and `shepherd_status`/`ps` can
// never disagree about how many iterations have run (INV-1: one counter).
async function getIterationCount(
  eventStore: EventStore,
  featureId: string,
): Promise<number> {
  const events = await eventStore.query(featureId, { type: 'shepherd.iteration' });
  return countShepherdIterations(events);
}

// ─── Shepherd Lifecycle Helpers ──────────────────────────────────────────────

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

// DR-3 (#1595): on the bound-hit escalate path, emit a STRUCTURED escalation
// (NOT a hang — INV-10). The handler records the reason + counts, then returns
// its normal terminal result carrying `recommendation:'escalate'`; it does not
// loop or wait. Idempotency-keyed on `iterationCount` so re-assessment at the
// same count does not double-emit. Mirrors `emitShepherdApprovalRequested`.
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleAssessStack(
  args: {
    featureId: string;
    prNumbers: number[];
    // DR-2 per-PR comment paging (schema-declared in registry.ts, Task 022).
    limit?: number;
    offset?: number;
    projectConfig?: ResolvedProjectConfig;
  },
  _stateDir: string,
  injectedEventStore: EventStore,
  provider?: VcsProvider,
  registry: ReviewAdapterRegistry = createReviewAdapterRegistry(),
): Promise<ToolResult> {
  // No provider-identity gate here: every provider call in this handler is
  // supported for GitLab/ADO (`checkCi`, `getReviewStatus`, `getPrComments`)
  // or already fail-soft (`listPrs` via `queryPrMergeState`, and the
  // check/review/comment query helpers, all catch → `null`/`[]`). The harvest
  // loop is provider-branch-free (INV-6), so non-GitHub providers proceed and
  // surface their PR/MR comments as action items. `requiresGitHub` still gates
  // the `gh`-CLI-bound `check_pr_comments`/`validate_pr_stack` handlers.

  // Input validation
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

  // Query current iteration count from event store
  const iterationCount = await getIterationCount(eventStore, args.featureId);

  // Emit shepherd.started on first invocation (idempotent)
  const alreadyStarted = await hasShepherdStarted(eventStore, args.featureId);
  if (!alreadyStarted) {
    await emitShepherdStarted(eventStore, args.featureId);
  }

  // Check if any PR is merged → emit shepherd.completed
  const mergeResults = await Promise.all(
    args.prNumbers.map(pr => queryPrMergeState(vcs, pr)),
  );
  const mergedPr = mergeResults.find((pr) => pr !== null);
  const anyMerged = mergedPr !== undefined && mergedPr !== null;
  if (anyMerged) {
    await emitShepherdCompleted(eventStore, args.featureId, mergedPr);
  }

  // Assess each PR (internal full working set — all checks, all unresolved
  // comments). The serialized result is projected + windowed later.
  const assessments = await Promise.all(
    args.prNumbers.map(pr => assessPr(vcs, pr, registry, eventStore, args.featureId)),
  );

  // Emit dual events (one gate.executed per check, from the FULL set)
  await emitCiStatusEvents(eventStore, args.featureId, assessments, iterationCount);
  await emitGateExecutedEvents(eventStore, args.featureId, assessments, iterationCount);

  // Classify action items over the FULL comment set — the recommendation and
  // the shepherd's fix/escalate decision must see every unresolved comment, not
  // just the first page.
  const actionItems = classifyActionItems(assessments);

  // Resolve the auto-fix bound from the shared escalation policy (DR-3, #1595):
  // config-resolvable, falls back to the module default. The loop and the
  // recommendation gate use the SAME resolved bound (INV-1; the bound is
  // workload-agnostic — no per-workflow branch, INV-6).
  const { maxIterations } = resolveEscalationPolicy({
    configMaxIterations: args.projectConfig?.escalation?.maxIterations,
  });

  // Compute recommendation from the FULL action-item set (a critical comment on
  // a later page must still drive fix-and-resubmit on the first page).
  const recommendation = computeRecommendation(
    actionItems,
    iterationCount,
    assessments,
    maxIterations,
  );

  // Emit shepherd.approval_requested when recommendation is request-approval
  // Guard: never emit approval_requested when a PR is already merged (shepherd.completed wins)
  // Also check event store for prior shepherd.completed to handle transient merge query failures
  if (recommendation === 'request-approval' && !anyMerged) {
    const completedEvents = await eventStore.query(args.featureId, { type: 'shepherd.completed' });
    if (completedEvents.length === 0) {
      await emitShepherdApprovalRequested(eventStore, args.featureId, args.prNumbers, iterationCount);
    }
  }

  // Emit shepherd.escalated on the bound-hit path (DR-3, #1595): a STRUCTURED
  // terminal escalation, NOT a hang (INV-10). The handler records the reason +
  // counts here, then falls through to RETURN its normal terminal result with
  // `recommendation:'escalate'` — it does not loop or wait. Idempotency on
  // `iterationCount` prevents a double-emit if assessed again at the same count.
  if (recommendation === 'escalate') {
    await emitShepherdEscalated(
      eventStore,
      args.featureId,
      args.prNumbers,
      iterationCount,
      maxIterations,
    );
  }

  // DR-2: build the MINIMAL, windowed result. Per-PR unresolved comments are
  // capped to the requested window with `commentPage` metadata; the serialized
  // `actionItems` cover the SAME window so a shepherd paging by `offset` reaches
  // every unresolved actionable comment reference across pages. Non-comment
  // items (ci-fix, review-address) are bounded and appear on every page.
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
