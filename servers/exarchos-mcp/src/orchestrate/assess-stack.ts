// ─── Assess Stack Composite Action ──────────────────────────────────────────
//
// Orchestrates PR stack health assessment for the shepherd workflow.
// Queries CI status, reviews, and comments per PR via `gh` CLI, then emits
// dual events: `ci.status` for ShepherdStatusView and `gate.executed` for
// CodeQualityView/flywheel pass rate tracking.
// ────────────────────────────────────────────────────────────────────────────

import { execSync } from 'node:child_process';
import type { EventStore } from '../event-store/store.js';
import { getOrCreateEventStore } from '../views/tools.js';
import type { ToolResult } from '../format.js';

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
  readonly body: string;
  readonly isResolved: boolean;
}

export interface ActionItem {
  readonly type: 'ci-fix' | 'comment-reply' | 'review-address' | 'stack-fix';
  readonly pr: number;
  readonly description: string;
  readonly severity: 'critical' | 'major' | 'minor';
}

export interface ShepherdStatusState {
  readonly prs: readonly PrStatus[];
  readonly iterationCount: number;
}

export interface AssessStackResult {
  readonly status: ShepherdStatusState;
  readonly actionItems: readonly ActionItem[];
  readonly recommendation: 'request-approval' | 'fix-and-resubmit' | 'escalate';
}

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SHEPHERD_ITERATIONS = 5;

// ─── GitHub Query Helpers ───────────────────────────────────────────────────

interface GhCheckRaw {
  readonly name: string;
  readonly state: string;
  readonly targetUrl?: string;
}

interface GhReviewRaw {
  readonly state: string;
  readonly author: string;
}

interface GhCommentRaw {
  readonly body: string;
  readonly isResolved: boolean;
}

function queryPrChecks(prNumber: number): CiCheck[] {
  try {
    const output = execSync(
      `gh pr checks ${prNumber} --json name,state,targetUrl`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const raw = JSON.parse(output) as GhCheckRaw[];
    return raw.map(normalizeCiCheck);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[assess-stack] Failed to query checks for PR #${prNumber}: ${message}`);
    return [];
  }
}

function normalizeCiCheck(raw: GhCheckRaw): CiCheck {
  const statusMap: Record<string, 'pass' | 'fail' | 'pending'> = {
    SUCCESS: 'pass',
    FAILURE: 'fail',
    PENDING: 'pending',
  };
  return {
    name: raw.name,
    status: statusMap[raw.state] ?? 'pending',
    url: raw.targetUrl || undefined,
  };
}

function queryPrReviews(prNumber: number): PrReview[] {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --json reviews --jq '.reviews'`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const raw = JSON.parse(output) as Array<{ state: string; author: { login: string } }>;
    return raw.map(r => ({ state: r.state, author: r.author.login }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[assess-stack] Failed to query reviews for PR #${prNumber}: ${message}`);
    return [];
  }
}

function queryPrComments(prNumber: number): PrComment[] {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --json comments --jq '.comments'`,
      { encoding: 'utf-8', timeout: 30_000 },
    );
    const raw = JSON.parse(output) as Array<{ body: string }>;
    // General PR comments are not individually resolvable
    return raw.map(c => ({ body: c.body, isResolved: false }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[assess-stack] Failed to query comments for PR #${prNumber}: ${message}`);
    return [];
  }
}

function computeOverallCi(checks: readonly CiCheck[]): 'pass' | 'fail' | 'pending' {
  if (checks.length === 0) return 'pending';
  if (checks.some(c => c.status === 'fail')) return 'fail';
  if (checks.some(c => c.status === 'pending')) return 'pending';
  return 'pass';
}

function queryPrStatus(prNumber: number): PrStatus {
  const checks = queryPrChecks(prNumber);
  const reviews = queryPrReviews(prNumber);
  const allComments = queryPrComments(prNumber);
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
        });
      }
    }

    // Unresolved comments -> comment-reply items
    for (const comment of prStatus.unresolvedComments) {
      items.push({
        type: 'comment-reply',
        pr: prStatus.pr,
        description: `Unresolved comment: ${comment.body.slice(0, 100)}`,
        severity: 'major',
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
): 'request-approval' | 'fix-and-resubmit' | 'escalate' {
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
    return 'fix-and-resubmit';
  }

  return 'request-approval';
}

// ─── Event Emission ─────────────────────────────────────────────────────────

async function emitCiStatusEvents(
  eventStore: EventStore,
  featureId: string,
  prStatuses: readonly PrStatus[],
): Promise<void> {
  for (const prStatus of prStatuses) {
    await eventStore.append(featureId, {
      type: 'ci.status' as const,
      data: {
        pr: prStatus.pr,
        status: prStatus.overallCi,
      },
    }, {
      idempotencyKey: `${featureId}:ci.status:${prStatus.pr}:${Date.now()}`,
    });
  }
}

async function emitGateExecutedEvents(
  eventStore: EventStore,
  featureId: string,
  prStatuses: readonly PrStatus[],
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
        idempotencyKey: `${featureId}:gate.executed:${prStatus.pr}:${check.name}:${Date.now()}`,
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

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleAssessStack(
  args: { featureId: string; prNumbers: number[] },
  stateDir: string,
): Promise<ToolResult> {
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

  const eventStore = getOrCreateEventStore(stateDir);

  // Query current iteration count from event store
  const iterationCount = await getIterationCount(eventStore, args.featureId);

  // Query status for each PR
  const prStatuses = args.prNumbers.map(queryPrStatus);

  // Emit dual events
  await emitCiStatusEvents(eventStore, args.featureId, prStatuses);
  await emitGateExecutedEvents(eventStore, args.featureId, prStatuses);

  // Classify action items
  const actionItems = classifyActionItems(prStatuses);

  // Compute recommendation
  const recommendation = computeRecommendation(actionItems, iterationCount, prStatuses);

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
