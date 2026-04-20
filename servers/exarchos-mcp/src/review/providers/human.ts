import type { ActionItem, ProviderAdapter } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const DESCRIPTION_MAX_LENGTH = 100;

/**
 * Catch-all adapter for non-bot reviewers.
 *
 * The human adapter intentionally does NOT infer severity from prose — natural
 * language signals like "CRITICAL" or "nit" are too unreliable to drive fixer
 * dispatch. Every accepted comment defaults to {@link Severity} `MEDIUM`.
 *
 * Bot authors are rejected (returns `null`) so dedicated adapters can claim
 * them. This includes:
 *   - any author whose login ends with `[bot]` (GitHub bot convention)
 *   - the literal `Copilot` (GitHub Copilot reviews surface without a [bot] suffix)
 */
export const humanAdapter: ProviderAdapter = {
  kind: 'human',
  parse(comment: VcsPrComment): ActionItem | null {
    try {
      if (typeof comment.author !== 'string') {
        return null;
      }
      if (isBotAuthor(comment.author)) {
        return null;
      }
      if (typeof comment.body !== 'string') {
        return null;
      }
      return {
        type: 'comment-reply',
        pr: 0,
        description: comment.body.slice(0, DESCRIPTION_MAX_LENGTH),
        severity: 'major',
        reviewer: 'human',
        threadId: String(comment.id),
        raw: comment,
        file: comment.path,
        line: comment.line,
        normalizedSeverity: 'MEDIUM',
      };
    } catch {
      // Defensive: bad body must not kill the whole batch (#1159).
      return null;
    }
  },
};

function isBotAuthor(author: string): boolean {
  return author.endsWith('[bot]') || author === 'Copilot';
}
