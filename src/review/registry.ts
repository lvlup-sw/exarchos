/**
 * Registry of the provider adapters that parse PR review comments.
 * `createReviewAdapterRegistry` builds a frozen registry. `forReviewer` returns
 * undefined for a kind without an adapter.
 *
 * `detectKind` maps a comment author to a `ReviewerKind`. It is the one place
 * that holds the author-string conventions.
 */

import type {
  ProviderAdapter,
  ReviewAdapterRegistry,
  ReviewerKind,
} from './types.js';
import { coderabbitAdapter } from './providers/coderabbit.js';
import { sentryAdapter } from './providers/sentry.js';
import { githubCopilotAdapter } from './providers/github-copilot.js';
import { humanAdapter } from './providers/human.js';
import { unknownAdapter } from './providers/unknown.js';

const COPILOT_AUTHORS: ReadonlySet<string> = new Set([
  'github-copilot[bot]',
  'copilot[bot]',
  'Copilot',
]);

const KNOWN_BOT_KINDS: ReadonlyMap<string, ReviewerKind> = new Map([
  ['coderabbitai[bot]', 'coderabbit'],
  ['sentry-io[bot]', 'sentry'],
]);

export function detectKind(author: string): ReviewerKind {
  const known = KNOWN_BOT_KINDS.get(author);
  if (known) return known;
  if (COPILOT_AUTHORS.has(author)) return 'github-copilot';
  if (author.endsWith('[bot]')) return 'unknown';
  return 'human';
}

export function createReviewAdapterRegistry(): ReviewAdapterRegistry {
  const adapters: readonly ProviderAdapter[] = Object.freeze([
    coderabbitAdapter,
    sentryAdapter,
    githubCopilotAdapter,
    humanAdapter,
    unknownAdapter,
  ]);

  const byKind = new Map<ReviewerKind, ProviderAdapter>(
    adapters.map((a) => [a.kind, a]),
  );

  return Object.freeze({
    forReviewer(kind: ReviewerKind): ProviderAdapter | undefined {
      return byKind.get(kind);
    },
    list(): readonly ProviderAdapter[] {
      return adapters;
    },
  });
}
