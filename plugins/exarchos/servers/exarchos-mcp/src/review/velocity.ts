import type { ReviewContext, VelocityTier } from './types.js';

const ACTIVE_PHASES = new Set(['delegate', 'review', 'synthesize']);

export function detectVelocity(context: ReviewContext): VelocityTier {
  const activeStacks = context.activeWorkflows.filter(
    w => ACTIVE_PHASES.has(w.phase)
  ).length;
  const pendingReviews = context.pendingCodeRabbitReviews;

  if (pendingReviews > 6) return 'high';
  if (activeStacks >= 2) return 'elevated';
  return 'normal';
}
