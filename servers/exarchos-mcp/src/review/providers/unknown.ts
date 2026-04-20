// ─── Unknown Reviewer Adapter ───────────────────────────────────────────────
//
// Catch-all fallback adapter for PR comments whose author isn't claimed by
// any of the typed adapters (CodeRabbit, Sentry, GitHub-Copilot, Human).
// Always returns an ActionItem with reviewer='unknown' and
// normalizedSeverity='MEDIUM'. The registry consults the unknown adapter
// last; an upstream caller should emit a `provider.unknown_tier` style
// event when this adapter handles a comment, surfacing the unfamiliar
// author so it can be classified later.
// ────────────────────────────────────────────────────────────────────────────

import type { ProviderAdapter, ActionItem } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

const DESCRIPTION_MAX_LENGTH = 100;

function summarize(body: string): string {
  return body.slice(0, DESCRIPTION_MAX_LENGTH);
}

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
      // Defensive: bad body must not kill the whole batch (#1159).
      return null;
    }
  },
};
