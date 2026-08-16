import { describe, expect, it } from 'vitest';

import {
  extractCommentProse,
  isQuotedMention,
  sentenceBefore,
} from './comment-prose.js';

describe('extractCommentProse', () => {
  it('CommentProse_KeepsCommentsAndDropsCode', () => {
    const source = [
      '// a leading note',
      "const title = 'a leading note in a string';",
      '/* a block note */',
      'const re = /a leading note/;',
    ].join('\n');

    const prose = extractCommentProse(source);
    expect(prose).toContain('a leading note');
    expect(prose).toContain('a block note');
    expect(prose).not.toContain('in a string');
  });

  it('CommentProse_TemplateSubstitutionTailIsNotProse', () => {
    // The defect this module was rewritten for. A hand-driven `ts.createScanner`
    // cannot resume a template literal after `${…}`, so the tail below re-entered
    // the token stream as a comment and the extractor INVENTED prose the file
    // does not contain — a sweep then reported an offender that was a string.
    const source = 'const probe = `${self}\\n// invented prose here`;';

    expect(extractCommentProse(source)).not.toContain('invented prose here');
  });

  it('CommentProse_CommentInsideATemplateSubstitutionIsProse', () => {
    // The complement: a `${…}` substitution IS code, so a comment inside one is
    // a real comment. Blanking the template whole would lose it.
    const source = 'const probe = `${/* real note */ value}`;';

    expect(extractCommentProse(source)).toContain('real note');
  });

  it('CommentProse_JoinsWrappedLinesIntoOneSentence', () => {
    const source = ['/**', ' * a sentence that wraps', ' * across two lines.', ' */'].join(
      '\n',
    );

    expect(extractCommentProse(source)).toContain('a sentence that wraps across two lines.');
  });

  it('CommentProse_RecoveredParse_ThrowsRatherThanGuessing', () => {
    expect(() => extractCommentProse('function broken( {')).toThrow(
      /did not parse cleanly/,
    );
  });
});

describe('sentenceBefore', () => {
  it('SentenceBefore_StopsAtTheEnclosingSentenceBoundary', () => {
    const prose = 'The old wording is retired. The arm receives parity with the CLI.';
    const index = prose.indexOf('parity');

    expect(sentenceBefore(prose, index)).toBe(' The arm receives ');
    expect(sentenceBefore(prose, index)).not.toContain('retired');
  });
});

describe('isQuotedMention', () => {
  it('QuotedMention_DistinguishesUseFromMention', () => {
    const mentioned = 'Words that turn "parity" into a claim.';
    const used = 'Words that turn the arm into parity with the CLI.';

    expect(isQuotedMention(mentioned, mentioned.indexOf('parity'))).toBe(true);
    expect(isQuotedMention(used, used.indexOf('parity'))).toBe(false);
  });

  it('QuotedMention_ApostropheIsNotAQuote', () => {
    // A bare `'` is an apostrophe far more often than a quote in prose; reading
    // it as an opening quote would silence the rest of the sentence.
    const prose = "The detector's answer about parity is unchanged.";

    expect(isQuotedMention(prose, prose.indexOf('parity'))).toBe(false);
  });

  it('QuotedMention_ClosedQuoteEarlierInTheSentenceDoesNotCarryOver', () => {
    const prose = 'A "quoted aside" then a bare parity claim.';

    expect(isQuotedMention(prose, prose.indexOf('parity'))).toBe(false);
  });
});
