// @ts-check
/**
 * @fileoverview Comment blocks from shell, YAML and PowerShell files, for the content rule.
 *
 * ESLint cannot read these languages, so the comment gate uses this module. The blocks have the
 * same shape and the same grouping as JavaScript blocks, so the baseline treats them the same way.
 * The shell scanner knows quotes, `${…}` expansions and heredoc bodies. YAML comments come from
 * the `yaml` syntax tree, and the shell scanner also reads the body of each `run: |` block.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const { Parser } = createRequire(import.meta.url)('yaml');

/** @typedef {{ start: number, end: number, kind: 'line' | 'block' }} Span */

/** The file extensions that this module reads, by language. */
export const SOURCE_EXTENSIONS = Object.freeze({
  shell: Object.freeze(['.sh', '.bash']),
  yaml: Object.freeze(['.yml', '.yaml']),
  powershell: Object.freeze(['.ps1', '.psm1']),
});

const SOURCE_DIRECTIVE_RE = /^\s*(?:!|shellcheck\s|yaml-language-server:|prettier-ignore|eslint\b|requires\s|renovate:)/i;

/**
 * Whether `#` at `index` starts a shell word, so that it starts a comment.
 *
 * @param {string} text
 * @param {number} index
 * @returns {boolean}
 */
function isWordStart(text, index) {
  return index === 0 || /[\s;|&()<>]/.test(text.charAt(index - 1));
}

/**
 * The offset after the heredoc bodies that start at `index`, or `index` when a delimiter never closes.
 *
 * @param {string} text
 * @param {number} index
 * @param {readonly { delimiter: string, stripTabs: boolean }[]} heredocs
 * @returns {number}
 */
function skipHeredocBodies(text, index, heredocs) {
  let cursor = index;
  for (const { delimiter, stripTabs } of heredocs) {
    let closed = false;
    while (cursor < text.length) {
      const newline = text.indexOf('\n', cursor);
      const lineEnd = newline === -1 ? text.length : newline;
      const line = text.slice(cursor, lineEnd);
      cursor = newline === -1 ? text.length : newline + 1;
      if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
        closed = true;
        break;
      }
    }
    if (!closed) return index;
  }
  return cursor;
}

/**
 * Parse a heredoc operator at `index`, where `text` has `<<`.
 *
 * @param {string} text
 * @param {number} index
 * @returns {{ next: number, heredoc?: { delimiter: string, stripTabs: boolean } }}
 */
function parseHeredoc(text, index) {
  let j = index + 2;
  const stripTabs = text.charAt(j) === '-';
  if (stripTabs) j += 1;
  while (text.charAt(j) === ' ' || text.charAt(j) === '\t') j += 1;
  const quote = text.charAt(j);
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, j + 1);
    if (close === -1) return { next: j };
    return { next: close + 1, heredoc: { delimiter: text.slice(j + 1, close), stripTabs } };
  }
  if (text.charAt(j) === '\\') j += 1;
  const word = /^[A-Za-z_][\w.-]*/.exec(text.slice(j));
  if (word === null) return { next: j };
  return { next: j + word[0].length, heredoc: { delimiter: word[0], stripTabs } };
}

/**
 * The `#` comments in shell source, as spans from `#` to the end of the line.
 *
 * @param {string} text
 * @returns {Span[]}
 */
export function shellCommentSpans(text) {
  /** @type {Span[]} */
  const spans = [];
  /** @type {{ delimiter: string, stripTabs: boolean }[]} */
  let heredocs = [];
  /** @type {string | null} */
  let quote = null;
  let braceDepth = 0;
  const firstNewline = text.indexOf('\n');
  let i = text.startsWith('#!') ? (firstNewline === -1 ? text.length : firstNewline) : 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
    } else if (quote !== null) {
      if (ch === '\\') i += 2;
      else {
        if (ch === (quote === "$'" ? "'" : quote)) quote = null;
        i += 1;
      }
    } else if (ch === '\\') {
      i += 2;
    } else if (ch === '\n') {
      i += 1;
      if (heredocs.length > 0) i = skipHeredocBodies(text, i, heredocs);
      heredocs = [];
    } else if (braceDepth > 0) {
      if (ch === '{') braceDepth += 1;
      else if (ch === '}') braceDepth -= 1;
      i += 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      i += 1;
    } else if (ch === '$') {
      const next = text.charAt(i + 1);
      if (next === "'") quote = "$'";
      else if (next === '{') braceDepth = 1;
      i += next === "'" || next === '{' || next === '#' ? 2 : 1;
    } else if (ch === '<' && text.charAt(i + 1) === '<' && text.charAt(i + 2) !== '<') {
      const parsed = parseHeredoc(text, i);
      if (parsed.heredoc !== undefined) heredocs.push(parsed.heredoc);
      i = parsed.next;
    } else if (ch === '#' && isWordStart(text, i)) {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      spans.push({ start: i, end, kind: 'line' });
      i = end;
    } else {
      i += 1;
    }
  }
  return spans;
}

/**
 * The comments in YAML source: YAML comments, plus shell comments inside `run: |` blocks.
 *
 * @param {string} text
 * @returns {Span[]}
 */
export function yamlCommentSpans(text) {
  /** @type {Span[]} */
  const spans = [];
  /** @type {(token: unknown) => void} */
  const visit = (token) => {
    if (Array.isArray(token)) {
      for (const item of token) visit(item);
      return;
    }
    if (token === null || typeof token !== 'object') return;
    const node = /** @type {Record<string, unknown>} */ (token);
    if (node.type === 'comment' && typeof node.offset === 'number' && typeof node.source === 'string') {
      spans.push({ start: node.offset, end: node.offset + node.source.length, kind: 'line' });
    }
    const key = /** @type {{ source?: unknown } | undefined} */ (node.key);
    const value = /** @type {{ type?: unknown, source?: unknown, props?: unknown } | undefined} */ (node.value);
    if (key?.source === 'run' && value?.type === 'block-scalar' && Array.isArray(value.props) && typeof value.source === 'string') {
      const props = /** @type {{ type: string, offset: number, source: string }[]} */ (value.props);
      const header = props.find((prop) => prop.type === 'block-scalar-header');
      const last = props[props.length - 1];
      if (header?.source.startsWith('|') && last !== undefined) {
        const contentStart = last.offset + last.source.length;
        for (const span of shellCommentSpans(value.source)) {
          spans.push({ start: contentStart + span.start, end: contentStart + span.end, kind: 'line' });
        }
      }
    }
    for (const child of Object.values(node)) if (child !== null && typeof child === 'object') visit(child);
  };
  visit([...new Parser().parse(text)]);
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * The comments in PowerShell source: `#` line comments and `<# #>` block comments.
 *
 * @param {string} text
 * @returns {Span[]}
 */
export function powershellCommentSpans(text) {
  /** @type {Span[]} */
  const spans = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const atLineStart = i === 0 || text.charAt(i - 1) === '\n';
    if (ch === '@' && (text.charAt(i + 1) === "'" || text.charAt(i + 1) === '"') && /[\r\n]/.test(text.charAt(i + 2))) {
      const closer = `\n${text.charAt(i + 1)}@`;
      const close = text.indexOf(closer, i + 2);
      i = close === -1 ? text.length : close + closer.length;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        const c = text.charAt(j);
        if (ch === '"' && c === '`') j += 2;
        else if (c === ch && text.charAt(j + 1) === ch) j += 2;
        else if (c === ch) break;
        else j += 1;
      }
      i = j + 1;
    } else if (ch === '`') {
      i += 2;
    } else if (ch === '<' && text.charAt(i + 1) === '#') {
      const close = text.indexOf('#>', i + 2);
      const end = close === -1 ? text.length : close + 2;
      spans.push({ start: i, end, kind: 'block' });
      i = end;
    } else if (ch === '#' && (atLineStart || /[\s;|&(){}]/.test(text.charAt(i - 1)))) {
      const newline = text.indexOf('\n', i);
      const end = newline === -1 ? text.length : newline;
      spans.push({ start: i, end, kind: 'line' });
      i = end;
    } else {
      i += 1;
    }
  }
  return spans;
}

/**
 * Remove `#`, `<#` and `#>` markers and join the lines into one line of prose.
 *
 * @param {string} raw
 * @returns {string}
 */
export function stripHashMarkers(raw) {
  return raw
    .replace(/^<#/, '')
    .replace(/#>$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*#+\s?/, '').trimEnd())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Group spans into blocks, with the same rule as JavaScript: own-line comments on adjacent lines merge.
 *
 * @param {string} text
 * @param {readonly Span[]} spans
 * @returns {import('./comment-baseline.mjs').CommentBlock[]}
 */
export function groupSourceBlocks(text, spans) {
  /** @type {import('./comment-baseline.mjs').CommentBlock[]} */
  const blocks = [];
  /** @type {number[]} */
  const starts = [0];
  for (let k = 0; k < text.length; k += 1) if (text.charCodeAt(k) === 10) starts.push(k + 1);
  const lineOf = (/** @type {number} */ offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  /** @type {import('./comment-baseline.mjs').CommentBlock | undefined} */
  let open;
  const close = () => {
    if (open !== undefined) blocks.push({ ...open, text: stripHashMarkers(open.raw) });
    open = undefined;
  };
  for (const span of spans) {
    const raw = text.slice(span.start, span.end);
    if (SOURCE_DIRECTIVE_RE.test(raw.replace(/^<?#+/, ''))) {
      close();
      continue;
    }
    const line = lineOf(span.start);
    const endLine = lineOf(Math.max(span.start, span.end - 1));
    const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
    const ownLine = text.slice(lineStart, span.start).trim().length === 0;
    if (span.kind === 'line' && ownLine && open?.kind === 'line' && open.ownLine && open.endLine === line - 1) {
      open = { ...open, end: span.end, endLine, raw: text.slice(open.start, span.end) };
      continue;
    }
    close();
    open = { kind: span.kind, ownLine, start: span.start, end: span.end, line, endLine, raw, text: '' };
    if (span.kind === 'block' || !ownLine) close();
  }
  close();
  return blocks.filter((block) => block.text.length > 0);
}

/**
 * The language of a path, or `undefined` when this module does not read it.
 *
 * @param {string} relPath
 * @returns {'shell' | 'yaml' | 'powershell' | undefined}
 */
export function sourceLanguage(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  if (SOURCE_EXTENSIONS.shell.includes(ext)) return 'shell';
  if (SOURCE_EXTENSIONS.yaml.includes(ext)) return 'yaml';
  if (SOURCE_EXTENSIONS.powershell.includes(ext)) return 'powershell';
  return undefined;
}

/**
 * The comment blocks of a shell, YAML or PowerShell file.
 *
 * @param {string} relPath
 * @param {string} text
 * @returns {import('./comment-baseline.mjs').CommentBlock[]}
 */
export function sourceBlocks(relPath, text) {
  const language = sourceLanguage(relPath);
  if (language === undefined) return [];
  const spans =
    language === 'shell' ? shellCommentSpans(text) : language === 'yaml' ? yamlCommentSpans(text) : powershellCommentSpans(text);
  return groupSourceBlocks(text, spans);
}
