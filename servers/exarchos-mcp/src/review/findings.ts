// ─── Review Finding & Escalation Event Emission ─────────────────────────────
//
// Utility functions for emitting review.finding and review.escalated events.
// These can be called when review processing (e.g., CodeRabbit comment parsing
// or review triage) identifies actionable findings or escalation conditions.
// ────────────────────────────────────────────────────────────────────────────

import type { EventStore } from '../event-store/store.js';
import type { ReviewFinding, ReviewEscalated } from '../event-store/schemas.js';

/**
 * Emit a `review.finding` event for each actionable finding.
 *
 * Fire-and-forget: individual append failures are silently swallowed
 * so callers are never blocked by event emission errors.
 */
export async function emitReviewFindings(
  findings: ReviewFinding[],
  streamId: string,
  eventStore: EventStore,
): Promise<void> {
  for (const finding of findings) {
    try {
      await eventStore.append(streamId, {
        type: 'review.finding',
        data: {
          pr: finding.pr,
          source: finding.source,
          severity: finding.severity,
          filePath: finding.filePath,
          lineRange: finding.lineRange,
          message: finding.message,
          rule: finding.rule,
        },
      });
    } catch {
      // Intentionally swallowed — event emission is fire-and-forget
    }
  }
}

/**
 * Emit a `review.escalated` event when a PR is escalated to human review.
 *
 * Fire-and-forget: append failures are silently swallowed.
 */
export async function emitReviewEscalated(
  escalation: ReviewEscalated,
  streamId: string,
  eventStore: EventStore,
): Promise<void> {
  try {
    await eventStore.append(streamId, {
      type: 'review.escalated',
      data: {
        pr: escalation.pr,
        reason: escalation.reason,
        originalScore: escalation.originalScore,
        triggeringFinding: escalation.triggeringFinding,
      },
    });
  } catch {
    // Intentionally swallowed — event emission is fire-and-forget
  }
}
