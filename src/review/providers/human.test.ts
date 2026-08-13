import { describe, it, expect } from 'vitest';
import { humanAdapter } from './human.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

function makeComment(overrides: Partial<VcsPrComment> = {}): VcsPrComment {
  return {
    id: 42,
    author: 'alice',
    body: 'Please consider extracting this helper into its own module.',
    createdAt: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

describe('humanAdapter', () => {
  it('HumanAdapter_HumanAuthor_ReturnsActionItem', () => {
    const comment = makeComment({
      id: 7,
      author: 'reed',
      body: 'Suggest renaming `foo` to `parsedFoo` for clarity.',
    });

    const item = humanAdapter.parse(comment);

    expect(item).not.toBeNull();
    expect(item?.type).toBe('comment-reply');
    expect(item?.pr).toBe(0);
    expect(item?.reviewer).toBe('human');
    expect(item?.threadId).toBe('7');
    expect(item?.severity).toBe('major');
    expect(item?.raw).toBe(comment);
    expect(item?.description).toBe(
      'Suggest renaming `foo` to `parsedFoo` for clarity.',
    );
  });

  it('HumanAdapter_AnyComment_DefaultsToMedium', () => {
    // Even with prose suggesting urgency ("CRITICAL", "must fix immediately"),
    // the human adapter does not infer severity — always MEDIUM.
    const urgent = humanAdapter.parse(
      makeComment({ body: 'CRITICAL: this must be fixed immediately!' }),
    );
    const calm = humanAdapter.parse(
      makeComment({ body: 'Tiny nit, feel free to ignore.' }),
    );

    expect(urgent?.normalizedSeverity).toBe('MEDIUM');
    expect(calm?.normalizedSeverity).toBe('MEDIUM');
  });

  it('HumanAdapter_BotAuthor_ReturnsNull', () => {
    const botAuthors = [
      'coderabbitai[bot]',
      'sentry-io[bot]',
      'github-actions[bot]',
    ];

    for (const author of botAuthors) {
      const item = humanAdapter.parse(makeComment({ author }));
      expect(item, `bot author ${author} should be rejected`).toBeNull();
    }
  });

  it('HumanAdapter_CopilotAuthor_ReturnsNull', () => {
    const item = humanAdapter.parse(makeComment({ author: 'Copilot' }));
    expect(item).toBeNull();
  });

  it('HumanAdapter_PopulatesFileAndLine', () => {
    const item = humanAdapter.parse(
      makeComment({
        path: 'src/foo.ts',
        line: 123,
      }),
    );

    expect(item?.file).toBe('src/foo.ts');
    expect(item?.line).toBe(123);
  });

  it('HumanAdapter_TruncatesLongBodyTo100Chars', () => {
    const longBody = 'a'.repeat(250);
    const item = humanAdapter.parse(makeComment({ body: longBody }));

    expect(item?.description.length).toBe(100);
    expect(item?.description).toBe('a'.repeat(100));
  });

  it('HumanAdapter_KindIsHuman', () => {
    expect(humanAdapter.kind).toBe('human');
  });

  it('HumanAdapter_MalformedInput_DoesNotThrow', () => {
    const malformed = makeComment({ body: null as unknown as string });
    expect(() => humanAdapter.parse(malformed)).not.toThrow();
    expect(humanAdapter.parse(malformed)).toBeNull();
  });
});
