/**
 * Fallback adapter for a PR comment from a bot author that `detectKind` does
 * not recognize. It returns an `ActionItem` with `reviewer: 'unknown'` and
 * `normalizedSeverity: 'MEDIUM'`, or null when the body is not a string.
 */

import type { ProviderAdapter, ActionItem } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const DESCRIPTION_MAX_LENGTH = 100;

function summarize(body: string): string {
  return body.slice(0, DESCRIPTION_MAX_LENGTH);
}

/** Returns null for a comment that throws, so one bad body does not stop the batch. */
export const unknownAdapter: ProviderAdapter = {
  kind: 'unknown',
  parse(comment: VcsPrComment): ActionItem | null {
    try {
      if (typeof comment.body !== 'string') {
        return null;
      }
      return {
        type: 'comment-reply',
        pr: 0,
        description: summarize(comment.body),
        severity: 'major',
        file: comment.path,
        line: comment.line,
        reviewer: 'unknown',
        threadId: String(comment.id),
        raw: comment,
        normalizedSeverity: 'MEDIUM',
      };
    } catch {
      return null;
    }
  },
};
