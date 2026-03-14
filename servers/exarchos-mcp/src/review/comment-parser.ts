// ─── Review Comment Parser ──────────────────────────────────────────────────
//
// Parses review comments (e.g., CodeRabbit format) into structured
// ReviewFinding objects and wires them to the event store via existing
// emitReviewFindings/emitReviewEscalated utilities.
// ────────────────────────────────────────────────────────────────────────────

import type { ReviewFinding } from '../event-store/schemas.js';
import type { EventStore } from '../event-store/store.js';
import { emitReviewFindings, emitReviewEscalated } from './findings.js';

// ─── Input Interface ────────────────────────────────────────────────────────

export interface ReviewComment {
  body: string;
  path?: string;
  line?: number;
  author: string;
}

// ─── Severity Mapping ───────────────────────────────────────────────────────

type FindingSeverity = ReviewFinding['severity'];

const HIGH_KEYWORDS = new Set(['bug', 'critical', 'error']);
const MEDIUM_KEYWORDS = new Set(['warning']);
const LOW_KEYWORDS = new Set(['suggestion', 'nit', 'style']);

function extractSeverity(body: string): FindingSeverity {
  const lower = body.toLowerCase();

  for (const keyword of HIGH_KEYWORDS) {
    if (lower.includes(keyword)) return 'critical';
  }
  for (const keyword of MEDIUM_KEYWORDS) {
    if (lower.includes(keyword)) return 'major';
  }
  for (const keyword of LOW_KEYWORDS) {
    if (lower.includes(keyword)) return 'minor';
  }

  return 'suggestion';
}

// ─── Severity Level for Comparison ──────────────────────────────────────────

const SEVERITY_LEVELS: Record<string, number> = {
  critical: 4,
  major: 3,
  minor: 2,
  suggestion: 1,
};

const THRESHOLD_LEVELS: Record<string, number> = {
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

function meetsThreshold(severity: FindingSeverity, threshold: string): boolean {
  const severityLevel = SEVERITY_LEVELS[severity] ?? 0;
  const thresholdLevel = THRESHOLD_LEVELS[threshold] ?? 0;
  return severityLevel >= thresholdLevel;
}

// ─── Public API: Severity Mapping for Tests ─────────────────────────────────

/** Maps internal severity to external reporting severity. */
function toReportingSeverity(severity: FindingSeverity): string {
  switch (severity) {
    case 'critical': return 'high';
    case 'major': return 'medium';
    case 'minor': return 'low';
    case 'suggestion': return 'info';
  }
}

// ─── Parser ─────────────────────────────────────────────────────────────────

export function parseReviewComments(comments: ReviewComment[]): ReviewFinding[] {
  if (comments.length === 0) return [];

  return comments.map((comment) => {
    const severity = extractSeverity(comment.body);

    return {
      pr: 0, // Caller should set this
      source: 'coderabbit' as const,
      severity,
      filePath: comment.path ?? '<unknown>',
      lineRange: comment.line ? [comment.line, comment.line] as [number, number] : undefined,
      message: comment.body,
    };
  });
}

// ─── Emitter ────────────────────────────────────────────────────────────────

export async function emitParsedFindings(
  findings: ReviewFinding[],
  streamId: string,
  eventStore: EventStore,
  escalationThreshold: string,
): Promise<void> {
  // Emit all findings via the existing utility
  await emitReviewFindings(findings, streamId, eventStore);

  // For findings at or above the escalation threshold, emit escalation events
  for (const finding of findings) {
    if (meetsThreshold(finding.severity, escalationThreshold)) {
      await emitReviewEscalated(
        {
          pr: finding.pr,
          reason: `Finding severity '${finding.severity}' meets escalation threshold '${escalationThreshold}'`,
          originalScore: 0,
          triggeringFinding: finding.message,
        },
        streamId,
        eventStore,
      );
    }
  }
}
