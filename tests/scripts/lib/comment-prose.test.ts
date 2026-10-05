import { describe, it, expect } from 'vitest';
import {
  extractComments,
  extractCommentProse,
  isQuotedMention,
  sentenceBefore,
  stripMarkers,
  CommentExtractionError,
} from '../../../tools/audit/lib/comment-prose.mjs';

describe('extractComments', () => {
  it('ExtractComments_LineComment_ReportsOneBasedLineAndColumn', () => {
    const source = ['const a = 1;', '  // the retry budget is fixed', 'const b = 2;'].join('\n');

    const [comment] = extractComments(source, 'a.ts');

    expect(comment?.line).toBe(2);
    expect(comment?.column).toBe(3);
    expect(comment?.text).toBe('the retry budget is fixed');
    expect(comment?.kind).toBe('line');
  });

  it('ExtractComments_MultiLineBlock_ReportsStartLine', () => {
    const source = ['const a = 1;', '', '/*', ' * wrapped', ' * rationale', ' */', 'const b = 2;'].join('\n');

    const [comment] = extractComments(source, 'a.ts');

    // The position is where the comment STARTS, not where it ends: a finding is
    // reported at the line a reader would jump to.
    expect(comment?.line).toBe(3);
    expect(comment?.endLine).toBe(6);
    expect(comment?.kind).toBe('block');
    expect(comment?.text).toBe('wrapped rationale');
  });

  it('ExtractComments_CommentInsideTemplateLiteral_NotEmitted', () => {
    // The case a scanner gets wrong: after a substitution it loses the literal
    // and re-reads the tail as source, inventing a comment that is really text.
    const source = 'const t = `${value}\n// not a comment`;\n';

    const comments = extractComments(source, 'a.ts');

    expect(comments).toHaveLength(0);
  });

  it('ExtractComments_CommentInsideTemplateSubstitution_IsEmitted', () => {
    // The other half of the same rule: a substitution IS code, so a comment
    // inside one is real and must not be swallowed with the literal.
    const source = 'const t = `${/* inside code */ value}`;\n';

    const comments = extractComments(source, 'a.ts');

    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe('inside code');
  });

  it('ExtractComments_OccurrenceInStringLiteral_NotEmitted', () => {
    const source = 'const s = "// not a comment";\nconst r = /\\/\\/ nor this/;\n';

    expect(extractComments(source, 'a.ts')).toHaveLength(0);
  });

  it('ExtractComments_RecoveredParse_Throws', () => {
    // Refusing is what lets a caller separate indeterminate from clean. A
    // partial tree loses literal spans, and a lost span turns code into prose.
    const source = 'function broken( {\n';

    expect(() => extractComments(source, 'broken.ts')).toThrow(CommentExtractionError);
  });

  it('ExtractComments_RecoveredParse_NamesTheFile', () => {
    expect(() => extractComments('const x = ;\n', 'offender.ts')).toThrow(/offender\.ts/);
  });

  it('ExtractComments_TsxSource_ParsesAsJsx', () => {
    // Without the right ScriptKind this parses as a type assertion and reports
    // syntax errors the file does not have.
    const source = 'const el = <div>text</div>;\n// after jsx\n';

    const comments = extractComments(source, 'component.tsx');

    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe('after jsx');
  });

  it('ExtractComments_SeveralComments_ReturnedInSourceOrder', () => {
    const source = ['// first', 'const a = 1;', '/* second */', '// third'].join('\n');

    expect(extractComments(source, 'a.ts').map((c) => c.text)).toEqual(['first', 'second', 'third']);
  });

  it('ExtractComments_CleanFileWithNoComments_ReturnsEmpty', () => {
    expect(extractComments('export const a = 1;\n', 'a.ts')).toEqual([]);
  });

  it('ExtractComments_UnterminatedBlockAtEof_ReportsIndeterminate', () => {
    // An unterminated block is a syntax error, so this is indeterminate rather
    // than a file with one long comment. Guessing at the intended end is what
    // would let a truncated file report clean.
    const source = 'const a = 1;\n/* never closed\n';

    expect(() => extractComments(source, 'a.ts')).toThrow(CommentExtractionError);
  });

  it('ExtractComments_RawText_PreservesMarkers', () => {
    const [comment] = extractComments('// keep the slashes\n', 'a.ts');

    expect(comment?.raw).toBe('// keep the slashes');
    expect(comment?.text).toBe('keep the slashes');
  });
});

describe('stripMarkers', () => {
  it('StripMarkers_WrappedSentence_JoinsIntoOneLine', () => {
    // Joining matters because a qualifier must still govern a phrase that
    // landed on the next line.
    const comment = ['/**', ' * the bytes are fsync\'d before', ' * the rename', ' */'].join('\n');

    expect(stripMarkers(comment)).toBe("the bytes are fsync'd before the rename");
  });

  it('StripMarkers_LineComment_DropsEverySlash', () => {
    expect(stripMarkers('/// three slashes')).toBe('three slashes');
  });

  it('StripMarkers_CollapsesRuns_OfWhitespace', () => {
    expect(stripMarkers('//   padded     text   ')).toBe('padded text');
  });
});

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

  /** A token scanner cannot resume a template literal after `${…}`, so the tail looked like a comment. */
  it('CommentProse_TemplateSubstitutionTailIsNotProse', () => {
    const source = 'const probe = `${self}\\n// invented prose here`;';

    expect(extractCommentProse(source)).not.toContain('invented prose here');
  });

  /** A `${…}` substitution is code, so a comment inside it is a real comment. */
  it('CommentProse_CommentInsideATemplateSubstitutionIsProse', () => {
    const source = 'const probe = `${/* real note */ value}`;';

    expect(extractCommentProse(source)).toContain('real note');
  });

  it('CommentProse_JoinsWrappedLinesIntoOneSentence', () => {
    const source = ['/**', ' * a sentence that wraps', ' * across two lines.', ' */'].join('\n');

    expect(extractCommentProse(source)).toContain('a sentence that wraps across two lines.');
  });

  it('CommentProse_RecoveredParse_ThrowsRatherThanGuessing', () => {
    expect(() => extractCommentProse('function broken( {')).toThrow(/did not parse cleanly/);
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

  /** A bare `'` is usually an apostrophe. A parser that reads it as a quote silences the rest of the sentence. */
  it('QuotedMention_ApostropheIsNotAQuote', () => {
    const prose = "The detector's answer about parity is unchanged.";

    expect(isQuotedMention(prose, prose.indexOf('parity'))).toBe(false);
  });

  it('QuotedMention_ClosedQuoteEarlierInTheSentenceDoesNotCarryOver', () => {
    const prose = 'A "quoted aside" then a bare parity claim.';

    expect(isQuotedMention(prose, prose.indexOf('parity'))).toBe(false);
  });
});
