import { describe, it, expect } from 'vitest';
import { sentryAdapter } from './sentry.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

function makeComment(overrides: Partial<VcsPrComment> = {}): VcsPrComment {
  return {
    id: 12345,
    author: 'sentry-io[bot]',
    body: '',
    createdAt: '2026-04-19T12:00:00Z',
    ...overrides,
  };
}

describe('sentryAdapter', () => {
  it('SentryAdapter_CriticalTag_NormalizesToHigh', () => {
    const comment = makeComment({
      body: '## CRITICAL\n\nNullPointerException in handler.ts',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('HIGH');
  });

  it('SentryAdapter_HighTag_NormalizesToHigh', () => {
    const comment = makeComment({
      body: '## HIGH severity issue detected\n\nMemory leak.',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('HIGH');
  });

  it('SentryAdapter_MediumTag_NormalizesToMedium', () => {
    const comment = makeComment({
      body: '## MEDIUM\n\nSlow query detected.',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('MEDIUM');
  });

  it('SentryAdapter_LowTag_NormalizesToLow', () => {
    const comment = makeComment({
      body: '## LOW\n\nMinor warning.',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('LOW');
  });

  it('SentryAdapter_NoSeverityTag_DefaultsToMedium', () => {
    const comment = makeComment({
      body: 'Sentry detected something but no severity tag is present.',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.normalizedSeverity).toBe('MEDIUM');
  });

  it('SentryAdapter_NonSentryAuthor_ReturnsNull', () => {
    const comment = makeComment({
      author: 'coderabbitai[bot]',
      body: '## CRITICAL bug',
    });
    const result = sentryAdapter.parse(comment);
    expect(result).toBeNull();
  });

  it('SentryAdapter_PopulatesFileAndLine', () => {
    const comment = makeComment({
      id: 999,
      body: '## HIGH\n\nUnhandled exception in fetch().',
      path: 'src/handler.ts',
      line: 42,
    });
    const result = sentryAdapter.parse(comment);
    expect(result).not.toBeNull();
    expect(result?.file).toBe('src/handler.ts');
    expect(result?.line).toBe(42);
    expect(result?.type).toBe('comment-reply');
    expect(result?.reviewer).toBe('sentry');
    expect(result?.threadId).toBe('999');
    expect(result?.severity).toBe('major');
    expect(result?.pr).toBe(0);
    expect(result?.raw).toBe(comment);
    expect(result?.description.length).toBeLessThanOrEqual(100);
  });
});
