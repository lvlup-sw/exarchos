import { describe, it, expect } from 'vitest';
import { extractComments, stripMarkers, CommentExtractionError } from '../../../tools/audit/lib/comment-prose.mjs';

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
