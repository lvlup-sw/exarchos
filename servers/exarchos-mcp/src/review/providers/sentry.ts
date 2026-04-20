// ─── Sentry Provider Adapter ─────────────────────────────────────────────────
//
// Parses comments authored by the `sentry-io[bot]` GitHub App into ActionItem
// values consumed by the fixer-dispatch pipeline. Sentry surfaces issue
// severity via tag headers (CRITICAL/HIGH/MEDIUM/LOW) embedded in comment
// bodies; this adapter scans for those tokens and normalizes them onto the
// shared Severity type so downstream routing can be reviewer-agnostic.
//
// CRITICAL and HIGH both map to HIGH (Sentry treats CRITICAL as the most
// severe band but HIGH is also actionable; collapsing them avoids a fourth
// tier that the rest of the pipeline does not understand). When no tag is
// found, the adapter defaults to MEDIUM rather than dropping the comment, so
// agents still receive a reply task but at a non-blocking severity.

import type { ActionItem, ProviderAdapter, Severity } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const SENTRY_AUTHOR = 'sentry-io[bot]';

// Standalone-token match: severity tags only count when they appear as a
// whole word (markdown headers like `## HIGH`, prose like `Severity: HIGH`).
// Anchored with \b on both sides so substrings like `HIGHLIGHT` or
// `MEDIUMLY` cannot accidentally trigger a match.
const SEVERITY_PATTERNS: ReadonlyArray<{ tag: string; severity: Severity }> = [
  { tag: 'CRITICAL', severity: 'HIGH' },
  { tag: 'HIGH', severity: 'HIGH' },
  { tag: 'MEDIUM', severity: 'MEDIUM' },
  { tag: 'LOW', severity: 'LOW' },
];

function detectSeverity(body: string): { severity: Severity; matched: boolean } {
  for (const { tag, severity } of SEVERITY_PATTERNS) {
    const re = new RegExp(`\\b${tag}\\b`);
    if (re.test(body)) {
      return { severity, matched: true };
    }
  }
  return { severity: 'MEDIUM', matched: false };
}

function rawTierMarker(body: string): string {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.slice(0, 80);
}

export const sentryAdapter: ProviderAdapter = {
  kind: 'sentry',
  parse(comment: VcsPrComment): ActionItem | null {
    if (comment.author !== SENTRY_AUTHOR) {
      return null;
    }

    try {
      const { severity: normalizedSeverity, matched } = detectSeverity(comment.body);
      const description = comment.body.slice(0, 100);

      return {
        type: 'comment-reply',
        pr: 0,
        description,
        severity: 'major',
        reviewer: 'sentry',
        threadId: String(comment.id),
        raw: comment,
        file: comment.path,
        line: comment.line,
        normalizedSeverity,
        ...(matched ? {} : { unknownTier: true, rawTier: rawTierMarker(comment.body) }),
      };
    } catch {
      // Defensive: bad body must not kill the whole batch (#1159).
      return null;
    }
  },
};
