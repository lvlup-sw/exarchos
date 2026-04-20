import { describe, it, expect } from 'vitest';
import { unknownAdapter } from './unknown.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

function makeComment(overrides: Partial<VcsPrComment> = {}): VcsPrComment {
  return {
    id: 1,
    author: 'mystery-bot[bot]',
    body: 'arbitrary content',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('unknownAdapter', () => {
  it('UnknownAdapter_AnyAuthor_AlwaysParses', () => {
    const item = unknownAdapter.parse(makeComment({ author: 'never-seen-bot[bot]' }));
    expect(item).not.toBeNull();
    expect(item?.reviewer).toBe('unknown');
  });

  it('UnknownAdapter_AnyComment_DefaultsToMedium', () => {
    const item = unknownAdapter.parse(makeComment({ body: 'CRITICAL!! HIGH!! Major!!' }));
    expect(item?.normalizedSeverity).toBe('MEDIUM');
  });

  it('UnknownAdapter_PopulatesFileAndLine', () => {
    const item = unknownAdapter.parse(makeComment({ path: 'src/a.ts', line: 42 }));
    expect(item?.file).toBe('src/a.ts');
    expect(item?.line).toBe(42);
  });

  it('UnknownAdapter_PopulatesThreadIdAndRaw', () => {
    const comment = makeComment({ id: 999 });
    const item = unknownAdapter.parse(comment);
    expect(item?.threadId).toBe('999');
    expect(item?.raw).toBe(comment);
  });
});
