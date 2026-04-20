// ─── Assess Stack Composite Action ──────────────────────────────────────────
//
// Orchestrates PR stack health assessment for the shepherd iteration loop.
// Shepherd is NOT a separate HSM phase — it operates within the `synthesize`
// phase. This action queries CI status, reviews, and comments per PR via
// `VcsProvider`, then emits dual events: `ci.status` for ShepherdStatusView and
// `gate.executed` for CodeQualityView/flywheel pass rate tracking.
// ────────────────────────────────────────────────────────────────────────────

import type { VcsProvider, CiStatus, PrComment as VcsPrComment } from '../vcs/provider.js';
import { requiresGitHub } from '../vcs/require-github.js';
import { createVcsProvider } from '../vcs/factory.js';
import type { EventStore } from '../event-store/store.js';
import { getOrCreateEventStore } from '../views/tools.js';
import type { ToolResult } from '../format.js';
import { orchestrateLogger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CiCheck {
  readonly name: string;
  readonly status: 'pass' | 'fail' | 'pending';
  readonly url?: string;
}

export interface PrStatus {
  readonly pr: number;
  readonly checks: readonly CiCheck[];
  readonly overallCi: 'pass' | 'fail' | 'pending';
  readonly reviews: readonly PrReview[];
  readonly unresolvedComments: readonly PrComment[];
}

interface PrReview {
  readonly state: string;
  readonly author: string;
}

interface PrComment {
  readonly body: string;       // truncated for display
  readonly fullBody: string;   // untruncated; consumed by review provider adapters (#1159)
  readonly isResolved: boolean;
  readonly actionItem?: ActionItem;  // populated by provider adapter dispatch (#1159)
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

const MAX_SHEPHERD_ITERATIONS = 5;

// ─── Comment Truncation ─────────────────────────────────────────────────────

const COMMENT_BODY_LIMIT = 200;

function truncateBody(body: string): string {
  if (body.length <= COMMENT_BODY_LIMIT) return body;
  return body.slice(0, COMMENT_BODY_LIMIT) + '...';
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
    // All comments from VcsProvider are treated as unresolved
    // (GitHub API doesn't provide isResolved for review comments)
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
        body: truncateBody(c.body),
        fullBody: c.body,
        isResolved: false,
        actionItem,
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

async function queryPrStatus(
  provider: VcsProvider,
  prNumber: number,
  registry: ReviewAdapterRegistry,
  eventStore: EventStore,
  featureId: string,
): Promise<PrStatus> {
  const checks = await queryPrChecks(provider, prNumber);
  const reviews = await queryPrReviews(provider, prNumber);
  const allComments = await queryPrComments(provider, prNumber, registry, eventStore, featureId);
  const unresolvedComments = allComments.filter(c => !c.isResolved);

  return {
    pr: prNumber,
    checks,
    overallCi: computeOverallCi(checks),
    reviews,
    unresolvedComments,
  };
}

// ─── Action Item Classification ─────────────────────────────────────────────

export function classifyActionItems(prStatuses: readonly PrStatus[]): ActionItem[] {
  const items: ActionItem[] = [];

  for (const prStatus of prStatuses) {
    // CI failures -> ci-fix items
    for (const check of prStatus.checks) {
      if (check.status === 'fail') {
        items.push({
          type: 'ci-fix',
          pr: prStatus.pr,
          description: `CI check '${check.name}' is failing`,
          severity: 'critical',
          normalizedSeverity: 'HIGH',
        });
      }
    }

    // Unresolved comments -> comment-reply items
    for (const comment of prStatus.unresolvedComments) {
      // Thread the adapter-parsed fields when present (#1159);
      // fall back to MEDIUM when no adapter ran (registry omitted, edge case).
      const adapterItem = comment.actionItem;
      items.push({
        type: 'comment-reply',
        pr: prStatus.pr,
        description: adapterItem?.description
          ?? `Unresolved comment: ${comment.body.slice(0, 100)}`,
        severity: 'major',
        normalizedSeverity: adapterItem?.normalizedSeverity ?? 'MEDIUM',
        ...(adapterItem?.reviewer ? { reviewer: adapterItem.reviewer } : {}),
        ...(adapterItem?.file ? { file: adapterItem.file } : {}),
        ...(adapterItem?.line !== undefined ? { line: adapterItem.line } : {}),
        ...(adapterItem?.threadId ? { threadId: adapterItem.threadId } : {}),
        ...(adapterItem?.raw !== undefined ? { raw: adapterItem.raw } : {}),
      });
    }

    // Review changes requested -> review-address items
    for (const review of prStatus.reviews) {
      if (review.state === 'CHANGES_REQUESTED') {
        items.push({
          type: 'review-address',
          pr: prStatus.pr,
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
  prStatuses?: readonly PrStatus[],
): 'request-approval' | 'fix-and-resubmit' | 'wait' | 'escalate' {
  if (iterationCount >= MAX_SHEPHERD_ITERATIONS) {
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
  prStatuses: readonly PrStatus[],
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
  prStatuses: readonly PrStatus[],
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

async function getIterationCount(
  eventStore: EventStore,
  featureId: string,
): Promise<number> {
  const events = await eventStore.query(featureId, { type: 'shepherd.iteration' });
  return events.length;
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
  args: { featureId: string; prNumbers: number[] },
  stateDir: string,
  provider?: VcsProvider,
  registry: ReviewAdapterRegistry = createReviewAdapterRegistry(),
): Promise<ToolResult> {
  const vcsGuard = requiresGitHub(provider, 'assess_stack');
  if (vcsGuard) return vcsGuard;

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
  const eventStore = getOrCreateEventStore(stateDir);

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

  // Query status for each PR
  const prStatuses = await Promise.all(
    args.prNumbers.map(pr => queryPrStatus(vcs, pr, registry, eventStore, args.featureId)),
  );

  // Emit dual events
  await emitCiStatusEvents(eventStore, args.featureId, prStatuses, iterationCount);
  await emitGateExecutedEvents(eventStore, args.featureId, prStatuses, iterationCount);

  // Classify action items
  const actionItems = classifyActionItems(prStatuses);

  // Compute recommendation
  const recommendation = computeRecommendation(actionItems, iterationCount, prStatuses);

  // Emit shepherd.approval_requested when recommendation is request-approval
  // Guard: never emit approval_requested when a PR is already merged (shepherd.completed wins)
  // Also check event store for prior shepherd.completed to handle transient merge query failures
  if (recommendation === 'request-approval' && !anyMerged) {
    const completedEvents = await eventStore.query(args.featureId, { type: 'shepherd.completed' });
    if (completedEvents.length === 0) {
      await emitShepherdApprovalRequested(eventStore, args.featureId, args.prNumbers, iterationCount);
    }
  }

  // Build result
  const status: ShepherdStatusState = {
    prs: prStatuses,
    iterationCount,
  };

  const result: AssessStackResult = {
    status,
    actionItems,
    recommendation,
  };

  return {
    success: true,
    data: result,
  };
}
