// ─── Review Triage Tool Handler ─────────────────────────────────────────────
//
// Scores PRs by risk and dispatches to CodeRabbit or self-hosted review
// based on velocity. Emits review.routed events for each dispatched PR.
// ────────────────────────────────────────────────────────────────────────────

import type { ToolResult } from '../format.js';
import { EventStore } from '../event-store/store.js';
import { detectVelocity } from './velocity.js';
import { dispatchReviews } from './dispatch.js';
import type { PRDiffMetadata, ReviewContext, ReviewDispatch } from './types.js';

// ─── Input Validation ──────────────────────────────────────────────────────

interface ReviewTriageInput {
  featureId: string;
  prs: PRDiffMetadata[];
  activeWorkflows?: Array<{ phase: string }>;
  pendingCodeRabbitReviews?: number;
}

function parseInput(args: Record<string, unknown>): ReviewTriageInput | ToolResult {
  const featureId = args.featureId as string | undefined;
  if (!featureId) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'featureId is required' },
    };
  }

  const prs = args.prs as PRDiffMetadata[] | undefined;
  if (!Array.isArray(prs)) {
    return {
      success: false,
      error: { code: 'INVALID_INPUT', message: 'prs must be an array' },
    };
  }

  return {
    featureId,
    prs,
    activeWorkflows: (args.activeWorkflows as Array<{ phase: string }>) ?? [],
    pendingCodeRabbitReviews: (args.pendingCodeRabbitReviews as number) ?? 0,
  };
}

function isError(result: ReviewTriageInput | ToolResult): result is ToolResult {
  return 'success' in result && result.success === false;
}

// ─── Event Emission ────────────────────────────────────────────────────────

async function emitRoutedEvents(
  eventStore: EventStore,
  featureId: string,
  dispatches: ReviewDispatch[],
): Promise<void> {
  for (const dispatch of dispatches) {
    const idempotencyKey = `${featureId}:review.routed:${dispatch.pr}`;
    await eventStore.append(featureId, {
      type: 'review.routed',
      data: {
        pr: dispatch.pr,
        riskScore: dispatch.riskScore.score,
        factors: dispatch.riskScore.factors.filter(f => f.matched).map(f => f.name),
        destination: dispatch.coderabbit ? 'both' : 'self-hosted',
        velocityTier: dispatch.velocity,
        semanticAugmented: false,
      },
    }, { idempotencyKey });
  }
}

// ─── Summary ───────────────────────────────────────────────────────────────

interface DispatchSummary {
  total: number;
  coderabbit: number;
  selfHostedOnly: number;
}

function summarizeDispatches(dispatches: ReviewDispatch[]): DispatchSummary {
  const coderabbitCount = dispatches.filter(d => d.coderabbit).length;
  return {
    total: dispatches.length,
    coderabbit: coderabbitCount,
    selfHostedOnly: dispatches.length - coderabbitCount,
  };
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleReviewTriage(
  args: Record<string, unknown>,
  stateDir: string,
): Promise<ToolResult> {
  const input = parseInput(args);
  if (isError(input)) return input;

  const context: ReviewContext = {
    activeWorkflows: input.activeWorkflows ?? [],
    pendingCodeRabbitReviews: input.pendingCodeRabbitReviews ?? 0,
  };

  const velocity = detectVelocity(context);
  const dispatches = dispatchReviews(input.prs, velocity);

  // Emit review.routed events (skip if no dispatches)
  if (dispatches.length > 0) {
    const eventStore = new EventStore(stateDir);
    await emitRoutedEvents(eventStore, input.featureId, dispatches);
  }

  return {
    success: true,
    data: {
      velocity,
      dispatches,
      summary: summarizeDispatches(dispatches),
    },
  };
}
