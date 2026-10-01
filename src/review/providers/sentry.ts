/**
 * Parses comments from the `sentry-io[bot]` GitHub App into ActionItem values for the fixer-dispatch pipeline.
 * The adapter reads the CRITICAL, HIGH, MEDIUM or LOW tag in the body. CRITICAL and HIGH both map to HIGH, because the pipeline has no fourth tier.
 * With no tag, the item gets MEDIUM, so the agent still gets a reply task at a non-blocking severity.
 */

import type { ActionItem, ProviderAdapter, Severity } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const SENTRY_AUTHOR = 'sentry-io[bot]';

/**
 * The severity tags in match order. `detectSeverity` matches a tag only as a whole word, so `HIGHLIGHT` does not match `HIGH`.
 */
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

/**
 * Returns null for a comment from another author, and for a bad body, so one bad comment does not stop the batch.
 * It does not set `unknownTier` when no tag matches. Many Sentry comments have no tier, and the flag is for providers with a strict tier vocabulary.
 */
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
      return null;
    }
  },
};
