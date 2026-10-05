/**
 * @fileoverview Tests for the Simplified Technical English checks: the prose splitter, the word count,
 * each check, and the line budgets as `analyzeFile` applies them.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { loadPolicy } from '../../../tools/audit/lib/comment-policy.mjs';
import { analyzeFile } from '../../../tools/audit/lib/comment-analysis.mjs';
import { parseCommentFile } from '../../../tools/audit/lib/comment-parse.mjs';
import {
  countWords,
  proseParagraphs,
  splitSentences,
  steFindings,
  textLines,
  PROSE_RULE,
} from '../../../tools/audit/lib/comment-ste.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const policy = loadPolicy(path.join(REPO_ROOT, '.exarchos/comment-policy.json'));
const checks = policy.prose!.steChecks;

/** The ids of the STE checks that a comment breaks. */
function broken(raw: string): string[] {
  return steFindings(raw, checks).map((finding) => finding.checkId);
}

/** The prose findings of every block in a file, as `[line, checkId]` pairs. */
function proseFindings(code: string, relPath = 'src/a.ts'): [number, string][] {
  const { blocks, syntax } = parseCommentFile(relPath, code, REPO_ROOT);
  const { analyzed } = analyzeFile({ relPath, blocks, policy, entries: undefined, ...(syntax === undefined ? {} : { syntax }) });
  return analyzed.flatMap((item) =>
    item.findings.filter((f) => f.rule === PROSE_RULE).map((f): [number, string] => [item.block.line, f.checkId]),
  );
}

/** A sentence of `n` plain words. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

describe('word count and sentences', () => {
  /** STE rules 8.5 to 8.7 count code, parentheses, quoted text and hyphenated words as one word each. */
  it('CountWords_CodeParenthesesQuotesAndHyphens_CountAsOneWordEach', () => {
    const [paragraph] = proseParagraphs('/** Run `npm run lint -- --fix` (it is slow) on the "long quoted label" file-by-file. */');

    expect(paragraph?.sentences.map(countWords)).toEqual([7]);
  });

  it('ProseParagraphs_HyphenAtALineBreak_JoinsOneWord', () => {
    expect(proseParagraphs('/**\n * The both-\n * scope install runs.\n */')[0]?.sentences).toEqual(['The both-scope install runs.']);
  });

  it('SplitSentences_PeriodAfterAnAbbreviationOrInitial_DoesNotEndTheSentence', () => {
    expect(splitSentences('Use a tool, e.g. ESLint. Then stop.')).toEqual(['Use a tool, e.g. ESLint.', 'Then stop.']);
    expect(splitSentences('Option A. is the default.')).toEqual(['Option A. is the default.']);
  });

  it('ProseParagraphs_TagsListsAndBlankLines_StartParagraphs', () => {
    const raw = ['/**', ' * First paragraph.', ' *', ' * Lead-in:', ' * - one item', ' * - two item', ' * @param {string} id The id.', ' */'].join('\n');

    expect(proseParagraphs(raw).map((p) => p.sentences.join(' | '))).toEqual(['First paragraph.', 'Lead-in:', 'one item', 'two item', 'The id.']);
  });

  it('ProseParagraphs_BulletsLettersFlagRowsAndDedents_StartParagraphs', () => {
    const raw = [
      '/**',
      ' * \u2022 first bullet',
      ' * (a) lettered item',
      ' * --base <ref>   The base branch.',
      ' * --files <path>   Only these files.',
      ' *',
      ' * term \u2014 a definition that',
      ' *     wraps onto a deeper line',
      ' * next term',
      ' */',
    ].join('\n');

    expect(proseParagraphs(raw).map((p) => p.masked)).toEqual([
      'first bullet',
      'lettered item',
      '--base <ref> The base branch.',
      '--files <path> Only these files.',
      'term \u2014 a definition that wraps onto a deeper line',
      'next term',
    ]);
  });

  it('ProseParagraphs_RuleLinesAndClosingEmphasis_EndTheText', () => {
    expect(proseParagraphs('/**\n * \u2500\u2500 Setup \u2500\u2500\n * The value is **PRESENT.** Then it runs.\n */').map((p) => p.sentences)).toEqual([
      ['The value is **PRESENT.**', 'Then it runs.'],
    ]);
  });

  it('ProseParagraphs_CodeExamplesHeadingsTablesAndUnknownTags_AreSkipped', () => {
    const raw = ['/**', ' * Prose.', ' * ```ts', ' * const a = 1; // should', ' * ```', ' * # Title', ' * | a | b |', ' * @example', ' *   run(); // could', ' * @see other; thing', ' */'].join('\n');

    expect(proseParagraphs(raw).map((p) => p.masked)).toEqual(['Prose.']);
  });
});

describe('STE checks', () => {
  it('SentenceLength_OverTheLimit_IsReported', () => {
    expect(broken(`/** ${words(25)}. */`)).toEqual([]);
    expect(broken(`/** ${words(26)}. */`)).toEqual(['sentence-length']);
  });

  it('ParagraphLength_OverSixSentences_IsReported', () => {
    expect(broken(`/** ${'One. '.repeat(6)}*/`)).toEqual([]);
    expect(broken(`/** ${'One. '.repeat(7)}*/`)).toEqual(['paragraph-length']);
  });

  /** Code, quoted text and URLs are untouchable, so a pattern inside them is not a finding. */
  it('PatternChecks_InsideCodeQuotesOrUrls_AreNotReported', () => {
    expect(broken('/** Call `a(); b()` with "it should fail" and https://x.test/a;b. */')).toEqual([]);
  });

  it('PatternChecks_InProse_AreReportedOncePerCheck', () => {
    expect(broken('/** It should work; it can\'t fail. It has been fixed, e.g. here. It is being rebuilt. Run it in order to start. */')).toEqual([
      'semicolon',
      'modal',
      'contraction',
      'perfect-tense',
      'progressive-passive',
      'latin-abbreviation',
      'filler',
    ]);
  });

  it('Semicolon_WithoutASpaceAfterIt_IsNotProse', () => {
    expect(broken('/** The loop is for(;;) with no exit. */')).toEqual([]);
  });

  it('Contraction_Possessive_IsNotReported', () => {
    expect(broken("/** The file's owner reads its header. */")).toEqual([]);
  });

  it('Finding_Message_NamesTheMatchAndCitesTheRule', () => {
    const [finding] = steFindings('/** It should work. */', checks);

    expect(finding?.message).toMatch(/^"should"\. .*\(STE 3\.2\)$/);
  });
});

describe('line budgets', () => {
  it('TextLines_DelimitersBlankLinesAndTypeOnlyTags_DoNotCount', () => {
    expect(textLines(['/**', ' * One.', ' *', ' * Two.', ' * @param {string} id', ' * @returns {number} The count.', ' */'].join('\n'))).toBe(3);
  });

  it('DocLines_DescriptionOverTheBudget_IsReported', () => {
    const doc = (n: number) => `/**\n${Array.from({ length: n }, (_, i) => ` * Line ${i}\n`).join('')} */\nexport const a = 1;\n`;

    expect(proseFindings(`export const x = 1;\n${doc(10)}`)).toEqual([]);
    expect(proseFindings(`export const x = 1;\n${doc(11)}`)).toEqual([[2, 'doc-lines']]);
  });

  /** The header blocks share one budget, so each header block reports when the header as a whole is over it. */
  it('HeaderLines_HeaderOverTheBudget_ReportsEveryHeaderBlock', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `// Line ${i}`).join('\n');

    expect(proseFindings(`${lines(8)}\n\n/** Eight. */\n\nexport const a = 1;\n`)).toEqual([]);
    expect(proseFindings(`${lines(8)}\n\n${lines(8)}\n\nexport const a = 1;\n`)).toEqual([
      [1, 'header-lines'],
      [10, 'header-lines'],
    ]);
  });

  it('ProseChecks_BlockInsideAFunction_AreNotReported', () => {
    expect(proseFindings('export const x = 1;\nexport function f() {\n  // It should work; really.\n  return 1;\n}\n')).toEqual([]);
  });

  it('ProseChecks_ExemptPath_AreNotReported', () => {
    expect(proseFindings('/** It should work. */\nexport const a = 1;\n', 'tools/audit/__fixtures__/comment-hygiene/offenders.ts')).toEqual([]);
  });
});
