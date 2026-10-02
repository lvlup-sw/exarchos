import type { ActionItem, ProviderAdapter } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const DESCRIPTION_MAX_LENGTH = 100;

/**
 * The catch-all adapter for reviewers that are not bots.
 *
 * It does not infer severity from prose, because words like "CRITICAL" or "nit" are too unreliable
 * to drive fixer dispatch. Each accepted comment gets {@link Severity} `MEDIUM`. It returns `null`
 * for a bot author, so a dedicated adapter can claim the comment. A bot login ends with `[bot]`, or
 * is the literal `Copilot`. A parse error returns `null`, so one bad comment does not stop the
 * batch.
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
      return null;
    }
  },
};

function isBotAuthor(author: string): boolean {
  return author.endsWith('[bot]') || author === 'Copilot';
}
