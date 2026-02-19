import type { PRDiffMetadata, ReviewDispatch, VelocityTier } from './types.js';
import { scorePR } from './scoring.js';

export const THRESHOLDS: Record<VelocityTier, number> = {
  normal: 0.0,
  elevated: 0.3,
  high: 0.5,
};

export function dispatchReviews(
  prs: PRDiffMetadata[],
  velocity: VelocityTier,
  _basileusConnected: boolean
): ReviewDispatch[] {
  const threshold = THRESHOLDS[velocity];
  return prs.map(pr => {
    const riskScore = scorePR(pr);
    const useCodeRabbit = riskScore.score >= threshold;
    return {
      pr: pr.number,
      riskScore,
      coderabbit: useCodeRabbit,
      selfHosted: true,
      velocity,
      reason: useCodeRabbit
        ? `Risk ${riskScore.score.toFixed(2)} >= threshold ${threshold} (${velocity})`
        : `Risk ${riskScore.score.toFixed(2)} < threshold ${threshold} (${velocity}); self-hosted only`,
    };
  });
}
