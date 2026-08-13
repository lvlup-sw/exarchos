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

function detectSeverity(body: string): { severity: Severity } {
  for (const { tag, severity } of SEVERITY_PATTERNS) {
    const re = new RegExp(`\\b${tag}\\b`);
    if (re.test(body)) {
      return { severity };
    }
  }
  return { severity: 'MEDIUM' };
}

export const sentryAdapter: ProviderAdapter = {
  kind: 'sentry',
  parse(comment: VcsPrComment): ActionItem | null {
    try {
      if (typeof comment.author !== 'string' || comment.author !== SENTRY_AUTHOR) {
        return null;
      }
      if (typeof comment.body !== 'string') {
        return null;
      }
      const { severity: normalizedSeverity } = detectSeverity(comment.body);
      const description = comment.body.slice(0, 100);

      // Note: we intentionally do NOT set `unknownTier` when no tier matched.
      // Unlike CodeRabbit, Sentry does not use a strict tier convention on
      // every comment — many bug-prediction comments arrive with no tier
      // marker at all. Treating "no tier" as "unknown tier" would flood the
      // provider.unknown-tier event stream with false positives. The signal
      // is reserved for adapters whose providers DO use a structured tier
      // vocabulary that we want to detect drift in (#1159 PR feedback).
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
      };
    } catch {
      // Defensive: bad body must not kill the whole batch (#1159).
      return null;
    }
  },
};
