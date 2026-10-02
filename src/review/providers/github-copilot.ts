/**
 * Parses GitHub Copilot review comments into ActionItem values for the fixer-dispatch pipeline.
 * Copilot comments carry no severity tier, so every item gets `normalizedSeverity: 'MEDIUM'`.
 * The item also gets the legacy `severity: 'major'` for the assess-stack pipeline.
 */

import type { ProviderAdapter, ActionItem } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

/**
 * The Copilot logins: the full bot login, a shorter bot login on some installations, and the display name in some API responses.
 * Add a new Copilot author string here, and add it to the test cases.
 */
const COPILOT_AUTHORS: ReadonlySet<string> = new Set([
  'github-copilot[bot]',
  'Copilot',
  'copilot[bot]',
]);

const DESCRIPTION_MAX_LENGTH = 100;

function isCopilotAuthor(author: string): boolean {
  return COPILOT_AUTHORS.has(author);
}

function truncate(body: string, max: number): string {
  return body.length > max ? body.slice(0, max) : body;
}

/** Returns null for a comment from another author. It also returns null for a bad body, so one bad comment does not stop the batch. */
export const githubCopilotAdapter: ProviderAdapter = {
  kind: 'github-copilot',
  parse(comment: VcsPrComment): ActionItem | null {
    try {
      if (typeof comment.author !== 'string' || !isCopilotAuthor(comment.author)) {
        return null;
      }
      if (typeof comment.body !== 'string') {
        return null;
      }
      return {
        type: 'comment-reply',
        pr: 0,
        description: truncate(comment.body, DESCRIPTION_MAX_LENGTH),
        severity: 'major',
        reviewer: 'github-copilot',
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
