// ─── CodeRabbit Provider Adapter ────────────────────────────────────────────
//
// Parses raw CodeRabbit (`coderabbitai[bot]`) PR comments into ActionItem
// values. Tier markers in the comment body are mapped to normalizedSeverity:
//
//   _:warning: Potential issue_           → HIGH
//   "Critical" / "Major" heading          → HIGH
//   _:hammer_and_wrench: Refactor         → MEDIUM
//   _:bulb: Verification agent_           → LOW
//   "Nitpick" / "Minor"                   → LOW
//   (none of the above)                   → MEDIUM (with unknownTier marker)
//
// Comments authored by anyone other than `coderabbitai[bot]` return null so a
// future registry can dispatch them to a different adapter.
// ────────────────────────────────────────────────────────────────────────────

import type { ActionItem, ProviderAdapter, Severity } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const CODERABBIT_AUTHOR = 'coderabbitai[bot]';

// ─── Tier Markers ───────────────────────────────────────────────────────────
//
// Markers must appear as italic underscored phrases that CodeRabbit emits at
// the top of each finding section. We also recognize plain heading words for
// the heading-position aliases ("Critical"/"Major"/"Nitpick"/"Minor") which
// CodeRabbit uses in summary/walkthrough sections.

// "Critical"/"Major" must be in heading position: at the start of the body
// or at the start of a line, optionally preceded by markdown heading or
// emphasis markers (`#`, `*`). Case-insensitive to match CodeRabbit's
// varying capitalization. Mid-sentence occurrences must NOT match — the
// leading anchor + bounded prefix character class enforces that.
//
// Note: `_` is intentionally omitted from the trailing word-boundary side
// because `_` is a JS word character; `_Critical_` has no \b after the
// word, which would block the match. CodeRabbit emits headings as `##
// Critical` or `**Critical**`, not as `_Critical_`, so this is fine.
const HIGH_TIER_PATTERNS: readonly RegExp[] = [
  /_:warning: Potential issue_/,
  /(^|\n)[ \t]*[#*]*\s*(Critical|Major)\b/i,
];

const MEDIUM_TIER_PATTERNS: readonly RegExp[] = [
  /_:hammer_and_wrench: Refactor suggestion_/,
];

const LOW_TIER_PATTERNS: readonly RegExp[] = [
  /_:bulb: Verification agent_/,
  /\b(Nitpick|Minor)\b/i,
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

// ─── Adapter ────────────────────────────────────────────────────────────────

export const coderabbitAdapter: ProviderAdapter = {
  kind: 'coderabbit',

  parse(comment: VcsPrComment): ActionItem | null {
    if (comment.author !== CODERABBIT_AUTHOR) {
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
      ...(unknownTier ? { unknownTier: true } : {}),
    };
  },
};
