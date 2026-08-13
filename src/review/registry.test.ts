import { describe, it, expect } from 'vitest';
import { createReviewAdapterRegistry, detectKind } from './registry.js';

describe('createReviewAdapterRegistry', () => {
  it('CreateReviewAdapterRegistry_ReturnsAllFiveAdapters', () => {
    const registry = createReviewAdapterRegistry();
    const adapters = registry.list();
    expect(adapters).toHaveLength(5);
    const kinds = adapters.map((a) => a.kind).sort();
    expect(kinds).toEqual(['coderabbit', 'github-copilot', 'human', 'sentry', 'unknown']);
  });

  it('CreateReviewAdapterRegistry_ForReviewerCoderabbit_ReturnsCoderabbitAdapter', () => {
    const registry = createReviewAdapterRegistry();
    const adapter = registry.forReviewer('coderabbit');
    expect(adapter?.kind).toBe('coderabbit');
  });

  it('CreateReviewAdapterRegistry_ForReviewerSentry_ReturnsSentryAdapter', () => {
    const registry = createReviewAdapterRegistry();
    const adapter = registry.forReviewer('sentry');
    expect(adapter?.kind).toBe('sentry');
  });

  it('CreateReviewAdapterRegistry_ForReviewerHuman_ReturnsHumanAdapter', () => {
    const registry = createReviewAdapterRegistry();
    expect(registry.forReviewer('human')?.kind).toBe('human');
  });

  it('CreateReviewAdapterRegistry_ForReviewerGithubCopilot_ReturnsCopilotAdapter', () => {
    const registry = createReviewAdapterRegistry();
    expect(registry.forReviewer('github-copilot')?.kind).toBe('github-copilot');
  });

  it('CreateReviewAdapterRegistry_ForReviewerUnknown_ReturnsUnknownAdapter', () => {
    const registry = createReviewAdapterRegistry();
    expect(registry.forReviewer('unknown')?.kind).toBe('unknown');
  });

  it('CreateReviewAdapterRegistry_ListIsImmutable', () => {
    const registry = createReviewAdapterRegistry();
    const adapters = registry.list();
    expect(() => {
      (adapters as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

describe('detectKind', () => {
  it('DetectKind_CoderabbitAuthor_ReturnsCoderabbit', () => {
    expect(detectKind('coderabbitai[bot]')).toBe('coderabbit');
  });

  it('DetectKind_SentryAuthor_ReturnsSentry', () => {
    expect(detectKind('sentry-io[bot]')).toBe('sentry');
  });

  it('DetectKind_GithubCopilotBotAuthor_ReturnsGithubCopilot', () => {
    expect(detectKind('github-copilot[bot]')).toBe('github-copilot');
  });

  it('DetectKind_CopilotShortBotAuthor_ReturnsGithubCopilot', () => {
    expect(detectKind('copilot[bot]')).toBe('github-copilot');
  });

  it('DetectKind_CopilotDisplayName_ReturnsGithubCopilot', () => {
    expect(detectKind('Copilot')).toBe('github-copilot');
  });

  it('DetectKind_HumanAuthor_ReturnsHuman', () => {
    expect(detectKind('alice')).toBe('human');
    expect(detectKind('reed-salus')).toBe('human');
  });

  it('DetectKind_UnknownBot_ReturnsUnknown', () => {
    expect(detectKind('mystery-bot[bot]')).toBe('unknown');
    expect(detectKind('github-actions[bot]')).toBe('unknown');
  });
});
