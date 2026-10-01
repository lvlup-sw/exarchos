/**
 * The review triage handler. It scores each PR by risk. Each PR gets self-hosted review, and a PR
 * at or above the threshold for the current velocity also gets CodeRabbit. It emits a
 * `review.routed` event for each dispatched PR.
 */
import type { ToolResult } from '../format.js';
import type { EventStore } from '../events/store.js';
import { detectVelocity } from './velocity.js';
import { dispatchReviews } from './dispatch.js';
import type { PRDiffMetadata, ReviewContext, ReviewDispatch } from './types.js';

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

/** Triages the review of each PR. The caller injects the event store, and this handler never creates one. */
export async function handleReviewTriage(
  args: Record<string, unknown>,
  _stateDir: string,
  eventStore: EventStore,
): Promise<ToolResult> {
  const input = parseInput(args);
  if (isError(input)) return input;

  const context: ReviewContext = {
    activeWorkflows: input.activeWorkflows ?? [],
    pendingCodeRabbitReviews: input.pendingCodeRabbitReviews ?? 0,
  };

  const velocity = detectVelocity(context);
  const dispatches = dispatchReviews(input.prs, velocity);

  if (dispatches.length > 0) {
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
