// ─── GitHub Copilot Provider Adapter ────────────────────────────────────────
//
// Parses GitHub Copilot review comments into ActionItem values for the
// fixer-dispatch pipeline (issue #1159).
//
// Copilot review comments do not carry an explicit severity tier — they are
// advisory suggestions. This adapter normalizes everything from Copilot to
// MEDIUM and uses the legacy `severity: 'major'` value for backwards
// compatibility with the existing assess-stack pipeline.
//
// Author recognition
// ──────────────────
// Copilot can post under a few different login forms depending on the
// repository's GitHub App / integration configuration. The most common
// observed variants are:
//   - 'github-copilot[bot]'  (full bot login as it appears on GitHub PRs)
//   - 'copilot[bot]'         (shorter bot login seen on some installations)
//   - 'Copilot'              (display name; appears in some API surfaces)
// We accept all three. If new Copilot author strings surface in the wild,
// add them to COPILOT_AUTHORS below and extend the test parameterization.
// ────────────────────────────────────────────────────────────────────────────

import type { ProviderAdapter, ActionItem } from '../types.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

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

export const githubCopilotAdapter: ProviderAdapter = {
  kind: 'github-copilot',
  parse(comment: VcsPrComment): ActionItem | null {
    if (!isCopilotAuthor(comment.author)) {
      return null;
    }

    try {
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
      // Defensive: bad body must not kill the whole batch (#1159).
      return null;
    }
  },
};
