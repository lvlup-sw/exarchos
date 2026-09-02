// ─── Review Adapter Registry (Issue #1159) ──────────────────────────────────
//
// Single source of truth for the set of provider adapters that interpret
// PR review comments. The registry is constructed once via the
// createReviewAdapterRegistry() factory and injected into every consumer
// (assess_stack, classify_review_items, etc). There is no lazy fallback or
// late-binding mutation — absence of an adapter is a deterministic
// undefined return from forReviewer(), and the unknown adapter is always
// available as the final fallback.
//
// detectKind() inspects a comment's author string and routes it to the
// appropriate ReviewerKind. It is the sole place author-string conventions
// are encoded; adapters themselves do not branch on author beyond their
// own self-check.
// ────────────────────────────────────────────────────────────────────────────

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
