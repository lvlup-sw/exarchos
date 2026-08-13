import { describe, it, expect } from 'vitest';
import { githubCopilotAdapter } from './github-copilot.js';
import type { PrComment as VcsPrComment } from '../../vcs/provider.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const COPILOT_AUTHORS = [
  'github-copilot[bot]',
  'Copilot',
  'copilot[bot]',
] as const;

function makeComment(overrides: Partial<VcsPrComment> = {}): VcsPrComment {
  return {
    id: 42,
    author: 'github-copilot[bot]',
    body: 'Consider extracting this into a helper function for clarity.',
    createdAt: '2026-04-19T00:00:00Z',
    path: 'src/foo.ts',
    line: 17,
    ...overrides,
  };
}

describe('githubCopilotAdapter', () => {
  it('GithubCopilotAdapter_KindIsGithubCopilot', () => {
    expect(githubCopilotAdapter.kind).toBe('github-copilot');
  });

  describe('GithubCopilotAdapter_KnownCopilotAuthor_ReturnsActionItem', () => {
    for (const author of COPILOT_AUTHORS) {
      it(`recognizes author "${author}"`, () => {
        const comment = makeComment({ author });
        const item = githubCopilotAdapter.parse(comment);
        expect(item).not.toBeNull();
        expect(item?.reviewer).toBe('github-copilot');
        expect(item?.type).toBe('comment-reply');
        expect(item?.threadId).toBe(String(comment.id));
        expect(item?.raw).toBe(comment);
      });
    }
  });

  it('GithubCopilotAdapter_AnyComment_DefaultsToMedium', () => {
    // Copilot comments don't carry a severity tier — adapter normalizes to MEDIUM.
    const item = githubCopilotAdapter.parse(makeComment());
    expect(item).not.toBeNull();
    expect(item?.normalizedSeverity).toBe('MEDIUM');
    // Legacy severity field must remain 'major' for backwards compatibility.
    expect(item?.severity).toBe('major');
  });

  it('GithubCopilotAdapter_NonCopilotAuthor_ReturnsNull', () => {
    const item = githubCopilotAdapter.parse(makeComment({ author: 'someone-else' }));
    expect(item).toBeNull();
  });

  it('GithubCopilotAdapter_PopulatesFileAndLine', () => {
    const item = githubCopilotAdapter.parse(makeComment({ path: 'lib/bar.ts', line: 99 }));
    expect(item?.file).toBe('lib/bar.ts');
    expect(item?.line).toBe(99);
  });

  it('GithubCopilotAdapter_LongBody_TruncatesDescriptionTo100Chars', () => {
    const longBody = 'x'.repeat(250);
    const item = githubCopilotAdapter.parse(makeComment({ body: longBody }));
    expect(item?.description).toHaveLength(100);
    expect(item?.description).toBe('x'.repeat(100));
  });

  it('GithubCopilotAdapter_ShortBody_DescriptionUntruncated', () => {
    const body = 'short note';
    const item = githubCopilotAdapter.parse(makeComment({ body }));
    expect(item?.description).toBe(body);
  });

  it('GithubCopilotAdapter_PrIsZero', () => {
    // Adapter does not know the PR number; caller is expected to fill it.
    const item = githubCopilotAdapter.parse(makeComment());
    expect(item?.pr).toBe(0);
  });

  it('GithubCopilotAdapter_MissingFileAndLine_ReturnsUndefined', () => {
    const item = githubCopilotAdapter.parse(
      makeComment({ path: undefined, line: undefined }),
    );
    expect(item?.file).toBeUndefined();
    expect(item?.line).toBeUndefined();
  });

  it('GithubCopilotAdapter_MalformedInput_DoesNotThrow', () => {
    const malformed = makeComment({ body: null as unknown as string });
    expect(() => githubCopilotAdapter.parse(malformed)).not.toThrow();
    expect(githubCopilotAdapter.parse(malformed)).toBeNull();
  });
});
