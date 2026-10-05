// @ts-check
/**
 * @fileoverview Simplified Technical English checks for the prose of file headers and descriptions.
 *
 * The rules come from the vendored `simple-english` skill in pragmatic mode. The policy names each
 * check, its rule number and its limit. This module splits a comment into paragraphs and sentences,
 * and counts words as STE rules 8.5 to 8.7 say. Code, inline tags, URLs and quoted text count as one
 * word, and no check reads inside them. Text in parentheses counts as one word.
 */

import { isTypeAnnotation } from './comment-baseline.mjs';

/** The roster name of the prose rule. */
export const PROSE_RULE = 'comment-prose';

/** Every STE check, in report order. */
export const STE_CHECKS = Object.freeze([
  'sentence-length',
  'paragraph-length',
  'semicolon',
  'modal',
  'contraction',
  'perfect-tense',
  'progressive-passive',
  'latin-abbreviation',
  'filler',
]);

/** Every line budget, in report order. */
export const BUDGET_CHECKS = Object.freeze(['header-lines', 'doc-lines']);

const PLACEHOLDER = '\uE000';
const MASKS = [/``[^`]*``|`[^`\n]*`/g, /\{@\w+[^}]*\}/g, /\bhttps?:\/\/[^\s<>\]]+/g, /"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g];
const PROSE_TAGS = new Set(['fileoverview', 'file', 'overview', 'description', 'desc', 'summary', 'remarks', 'deprecated']);
const TYPED_TAGS = new Set(['returns', 'return', 'throws', 'exception', 'yields', 'yield']);
const NAMED_TAGS = new Set(['param', 'arg', 'argument', 'property', 'prop', 'template']);
const LIST_ITEM = /^(?:[-*+\u2022\u2192\u25B8\u2023\u25E6]|\d{1,3}[.)]|\(\w{1,3}\)|[a-z][.)]|[A-Z]\d{1,3}[.:)])\s+/;
const FLAG_ROW = /^--?[A-Za-z][\w-]*(?:[ =]\S+)?\s{2,}\S/;
const RULE_LINE = /^(?:[\u2500\u2501\u2550\-=~_*#+]{3,}|(?:[\u2500\u2501\u2550]{2,}|[\u2500\u2501\u2550\-=~_*#]{3,})\s+\S.*\s+(?:[\u2500\u2501\u2550]{2,}|[\u2500\u2501\u2550\-=~_*#]{3,}))$/;
const SENTENCE_END = /[.!?]+["'\u2019\u201D)\]*_]*(?=\s|$)/g;
const ABBREVIATION_END = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|viz|al|approx|[A-Za-z])\.$/;
const WORD = /[\p{L}\p{N}\uE000]/u;

/**
 * One paragraph of comment prose: the masked text and its sentences.
 *
 * @typedef {object} ProseParagraph
 * @property {string} masked The text with code, inline tags, URLs and quoted text replaced by a placeholder.
 * @property {string[]} sentences The sentences, with parentheses also collapsed to a placeholder.
 */

/**
 * The lines of a comment block with the comment markers removed.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function commentLines(raw) {
  return indentedLines(raw).map((line) => line.text);
}

/**
 * The lines of a comment block with the markers removed, each with its indent after the marker.
 *
 * @param {string} raw
 * @returns {{ text: string, indent: number }[]}
 */
function indentedLines(raw) {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => {
      const match = /^\s*(?:\/\/+|\*+)?(\s*)(.*)$/.exec(line);
      return { text: (match?.[2] ?? '').trim(), indent: match?.[1]?.length ?? 0 };
    });
}

/**
 * The prose that follows a JSDoc tag, or `undefined` when the tag carries no prose.
 *
 * @param {string} line A line that starts with `@`.
 * @returns {string | undefined}
 */
function tagProse(line) {
  const match = /^@([\w-]+)\s*(.*)$/.exec(line);
  if (match === null) return undefined;
  const name = match[1] ?? '';
  let rest = match[2] ?? '';
  if (!PROSE_TAGS.has(name) && !TYPED_TAGS.has(name) && !NAMED_TAGS.has(name)) return undefined;
  if (rest.startsWith('{')) {
    let depth = 0;
    let end = 0;
    for (; end < rest.length; end += 1) {
      if (rest[end] === '{') depth += 1;
      if (rest[end] === '}') depth -= 1;
      if (depth === 0) break;
    }
    rest = rest.slice(end + 1).trim();
  }
  if (NAMED_TAGS.has(name)) rest = rest.replace(/^(?:\[[^\]]*\]|[\w$.]+)\s*/, '');
  return rest.replace(/^-\s*/, '');
}

/**
 * Replace code, inline tags, URLs and quoted text with a placeholder. A URL keeps its trailing punctuation.
 *
 * @param {string} text
 * @returns {string}
 */
export function maskSpans(text) {
  let masked = text;
  for (const pattern of MASKS) {
    masked = masked.replace(pattern, (span) => {
      const tail = span.startsWith('http') ? (/[.,;:!?)]+$/.exec(span)?.[0] ?? '') : '';
      return PLACEHOLDER + tail;
    });
  }
  return masked;
}

/**
 * Replace each balanced parenthetical with a placeholder, innermost first. STE rule 8.5 counts it as one word.
 *
 * @param {string} text
 * @returns {string}
 */
function collapseParentheses(text) {
  let current = text;
  for (;;) {
    const next = current.replace(/\([^()]*\)/g, PLACEHOLDER);
    if (next === current) return current;
    current = next;
  }
}

/**
 * The number of words in a sentence. A token counts when it holds a letter, a digit or a placeholder.
 *
 * @param {string} sentence
 * @returns {number}
 */
export function countWords(sentence) {
  return sentence.split(/\s+/).filter((token) => WORD.test(token)).length;
}

/**
 * Split masked text into sentences. A period after a known abbreviation or a single letter does not end one.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  /** @type {string[]} */
  const sentences = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const upToPeriod = text.slice(Math.max(start, match.index - 8), match.index + 1);
    if (match[0].startsWith('.') && ABBREVIATION_END.test(upToPeriod) && end < text.length) continue;
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  sentences.push(text.slice(start).trim());
  return sentences.filter((sentence) => countWords(sentence) > 0);
}

/**
 * The paragraphs of a comment block.
 *
 * A blank line, a JSDoc tag, a list item, a flag row and a dedent each start a paragraph. A dedent
 * ends a hanging-indent entry. Fenced code, `@example` sections, headings, rule lines, table rows
 * and tags that carry no prose are skipped. A word that a line break splits at a hyphen is one word.
 *
 * @param {string} raw
 * @returns {ProseParagraph[]}
 */
export function proseParagraphs(raw) {
  /** @type {string[][]} */
  const groups = [];
  /** @type {string[]} */
  let current = [];
  let skip = /** @type {'none' | 'fence' | 'example' | 'tag'} */ ('none');
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
  };
  let previousIndent = Infinity;
  for (const { text: line, indent } of indentedLines(raw)) {
    if (line.length > 0 && indent < previousIndent && current.length > 0 && previousIndent !== Infinity) flush();
    if (line.length > 0) previousIndent = indent;
    if (skip === 'fence') {
      if (line.startsWith('```')) skip = 'none';
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      skip = 'fence';
      continue;
    }
    if (line.startsWith('@')) {
      flush();
      const prose = tagProse(line);
      skip = line.startsWith('@example') ? 'example' : prose === undefined ? 'tag' : 'none';
      if (prose !== undefined && prose.length > 0) current.push(prose);
      continue;
    }
    if (skip === 'example') continue;
    if (line.length === 0) {
      flush();
      if (skip === 'tag') skip = 'none';
      continue;
    }
    if (skip === 'tag') continue;
    if (/^#{1,6}\s/.test(line) || line.startsWith('|') || RULE_LINE.test(line)) {
      flush();
      continue;
    }
    if (LIST_ITEM.test(line) || FLAG_ROW.test(line)) {
      flush();
      current.push(line.replace(LIST_ITEM, ''));
      continue;
    }
    current.push(line);
  }
  flush();
  return groups.map((lines) => {
    const joined = lines.reduce((text, line) => (/[A-Za-z]-$/.test(text) ? `${text}${line}` : `${text} ${line}`), '');
    const masked = maskSpans(joined.replace(/\s+/g, ' ').trim());
    return { masked, sentences: splitSentences(collapseParentheses(masked)) };
  });
}

/**
 * Shorten a sentence for a message: its first words, then an ellipsis.
 *
 * @param {string} sentence
 * @returns {string}
 */
function excerpt(sentence) {
  const words = sentence.replaceAll(PLACEHOLDER, '…').split(/\s+/);
  return words.length <= 8 ? words.join(' ') : `${words.slice(0, 8).join(' ')} …`;
}

/**
 * One STE check as the policy declares it.
 *
 * @typedef {object} SteCheck
 * @property {string} id
 * @property {string} cite The STE rule, or the skill table that the check comes from.
 * @property {boolean} enabled
 * @property {string} remedy
 * @property {number} [limit] For `sentence-length` and `paragraph-length`.
 * @property {RegExp} [pattern] For the pattern checks.
 * @property {readonly { pattern: RegExp, term: string, use: string }[]} [terms] For `filler`.
 */

/**
 * The first violation of one check in a block's paragraphs, as the detail of a message.
 *
 * @param {SteCheck} check
 * @param {readonly ProseParagraph[]} paragraphs
 * @returns {string | undefined}
 */
function firstViolation(check, paragraphs) {
  if (check.id === 'sentence-length') {
    const long = paragraphs.flatMap((p) => p.sentences).filter((s) => countWords(s) > (check.limit ?? Infinity));
    if (long.length === 0) return undefined;
    const more = long.length > 1 ? ` and ${long.length - 1} more` : '';
    return `A sentence of ${countWords(long[0] ?? '')} words ("${excerpt(long[0] ?? '')}")${more}. The limit is ${check.limit}.`;
  }
  if (check.id === 'paragraph-length') {
    const long = paragraphs.find((p) => p.sentences.length > (check.limit ?? Infinity));
    return long === undefined ? undefined : `A paragraph of ${long.sentences.length} sentences. The limit is ${check.limit}.`;
  }
  if (check.terms !== undefined) {
    for (const paragraph of paragraphs) {
      for (const term of check.terms) {
        term.pattern.lastIndex = 0;
        const match = term.pattern.exec(paragraph.masked);
        if (match !== null) return `"${match[0]}": ${term.use}.`;
      }
    }
    return undefined;
  }
  if (check.pattern === undefined) return undefined;
  for (const paragraph of paragraphs) {
    check.pattern.lastIndex = 0;
    const match = check.pattern.exec(paragraph.masked);
    if (match !== null) return `"${match[0].trim()}".`;
  }
  return undefined;
}

/**
 * The STE findings for one block, one per enabled check that the block breaks.
 *
 * @param {string} raw
 * @param {readonly SteCheck[]} checks
 * @returns {{ checkId: string, message: string }[]}
 */
export function steFindings(raw, checks) {
  const paragraphs = proseParagraphs(raw);
  /** @type {{ checkId: string, message: string }[]} */
  const findings = [];
  for (const check of checks) {
    if (!check.enabled) continue;
    const detail = firstViolation(check, paragraphs);
    if (detail !== undefined) findings.push({ checkId: check.id, message: `${detail} ${check.remedy} (${check.cite})` });
  }
  return findings;
}

/**
 * The lines of text in a block. Delimiters, blank lines and type-only JSDoc tags do not count.
 *
 * A blank line between paragraphs is what STE rule 6.6 asks for, so it does not use the budget. A
 * type-only tag, such as `@param {string} id` with no prose, is type syntax and not text.
 *
 * @param {string} raw
 * @returns {number}
 */
export function textLines(raw) {
  return commentLines(raw).filter((line) => line.length > 0 && !isTypeAnnotation(`* ${line}`)).length;
}
