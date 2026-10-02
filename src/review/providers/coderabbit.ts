/**
 * Parses `coderabbitai[bot]` PR comments into `ActionItem` values. Tier markers
 * in the body set `normalizedSeverity`:
 *
 * - `_:warning: Potential issue_`, or a "Critical" or "Major" heading: HIGH.
 * - `_:hammer_and_wrench: Refactor suggestion_`: MEDIUM.
 * - `_:bulb: Verification agent_`, or a "Nitpick" or "Minor" heading: LOW.
 * - No marker: MEDIUM, with `unknownTier` and `rawTier` set.
 *
 * A comment from a different author returns null.
 */

import type { ActionItem, ProviderAdapter, Severity } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const CODERABBIT_AUTHOR = 'coderabbitai[bot]';

/**
 * HIGH markers. "Critical" or "Major" matches only in heading position: at the
 * start of a line, after optional `#` or `*` markers, in any letter case. A
 * word in the middle of a sentence does not match. `_Critical_` does not match.
 * CodeRabbit writes headings as `## Critical` or `**Critical**`.
 */
const HIGH_TIER_PATTERNS: readonly RegExp[] = [
  /_:warning: Potential issue_/,
  /(^|\n)[ \t]*[#*]*\s*(Critical|Major)\b/i,
];

const MEDIUM_TIER_PATTERNS: readonly RegExp[] = [
  /_:hammer_and_wrench: Refactor suggestion_/,
];

/**
 * LOW markers. "Nitpick" or "Minor" matches only in heading position, so that
 * prose such as "this is a minor concern" does not make the comment LOW.
 */
const LOW_TIER_PATTERNS: readonly RegExp[] = [
  /_:bulb: Verification agent_/,
  /(^|\n)[ \t]*[#*]*\s*(Nitpick|Minor)\b/i,
];

function classifyTier(body: string): Severity | null {
  for (const re of HIGH_TIER_PATTERNS) {
    if (re.test(body)) return 'HIGH';
  }
  for (const re of MEDIUM_TIER_PATTERNS) {
    if (re.test(body)) return 'MEDIUM';
  }
  for (const re of LOW_TIER_PATTERNS) {
    if (re.test(body)) return 'LOW';
  }
  return null;
}

/** Returns the first non-empty line, at most 80 characters, so the payload does not hold the full comment. */
function rawTierMarker(body: string): string {
  const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
  return firstLine.slice(0, 80);
}

/**
 * Returns null when parsing throws, so one bad comment does not stop the batch.
 * The caller then records the comment at the default MEDIUM severity.
 */
export const coderabbitAdapter: ProviderAdapter = {
  kind: 'coderabbit',

  parse(comment: VcsPrComment): ActionItem | null {
    try {
      if (typeof comment.author !== 'string' || comment.author !== CODERABBIT_AUTHOR) {
        return null;
      }
      if (typeof comment.body !== 'string') {
        return null;
      }
      const tier = classifyTier(comment.body);
      const normalizedSeverity: Severity = tier ?? 'MEDIUM';
      const unknownTier = tier === null;

      return {
        type: 'comment-reply',
        pr: 0,
        description: comment.body.slice(0, 100),
        severity: 'major',
        reviewer: 'coderabbit',
        threadId: String(comment.id),
        raw: comment,
        file: comment.path,
        line: comment.line,
        normalizedSeverity,
        ...(unknownTier ? { unknownTier: true, rawTier: rawTierMarker(comment.body) } : {}),
      };
    } catch {
      return null;
    }
  },
};
