// @ts-check
/**
 * @fileoverview Comment text, separated from code, with the position of each
 * comment.
 *
 * Two consumers need this: a CI gate that reports `file:line`, and an ESLint
 * rule that reports on a `loc`. Both are non-TypeScript, so the extractor is
 * authored once as `.mjs` and imported directly by each — a TypeScript module
 * inside the server package would have to be reimplemented in the rule, putting
 * the same classification logic in two languages.
 *
 * It PARSES rather than scanning. Driving `ts.createScanner` token by token
 * cannot resume a template literal after a `${…}` substitution, so the tail of
 * `` `${x}\n// text` `` re-enters the token stream as a comment: the extractor
 * invents prose the file does not contain. Measured on a real tree, that
 * desynchronisation under-counted comment lines by a third. With literal spans
 * known from a parse, a `/` outside them can only begin a comment — the
 * ambiguity does not arise rather than being guessed at.
 */

import ts from 'typescript';
import path from 'node:path';

/**
 * A half-open `[start, end)` source range that is a literal, not code.
 * @typedef {{ start: number, end: number }} LiteralSpan
 */

/**
 * One comment, its marker-stripped prose, and where it sits.
 *
 * `line`/`column` are 1-based so they can be printed as `file:line:column`
 * without adjustment at each call site. `text` is the prose; `raw` keeps the
 * markers for a consumer that needs to reproduce the original.
 *
 * @typedef {object} ExtractedComment
 * @property {string} text Marker-stripped prose, lines joined.
 * @property {string} raw The comment exactly as it appears, markers included.
 * @property {'line' | 'block'} kind
 * @property {number} line 1-based line of the comment's first character.
 * @property {number} column 1-based column of the comment's first character.
 * @property {number} endLine 1-based line of the comment's last character.
 * @property {number} start Absolute offset of the comment's first character.
 * @property {number} end Absolute offset one past the comment's last character.
 */

/**
 * Thrown when a file cannot be parsed cleanly.
 *
 * A distinct type so a gate can tell "this file is indeterminate" from "this
 * file is clean". Reporting the two the same way is how a scanner that silently
 * skips unparseable input comes to report a green tree it never read.
 */
export class CommentExtractionError extends Error {
  /**
   * @param {string} message
   * @param {string} fileName
   */
  constructor(message, fileName) {
    super(message);
    this.name = 'CommentExtractionError';
    this.fileName = fileName;
  }
}

/**
 * TypeScript needs the right `ScriptKind` or JSX parses as a type assertion and
 * the file reports syntax errors it does not have.
 *
 * @param {string} fileName
 * @returns {ts.ScriptKind}
 */
function scriptKindFor(fileName) {
  switch (path.extname(fileName)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * A partial tree silently loses literal spans, and a lost span turns code back
 * into "prose" — the exact failure this module parses to avoid. Refusing is
 * what lets a caller distinguish indeterminate from clean.
 *
 * @param {string} source
 * @param {string} fileName
 * @returns {ts.SourceFile}
 */
function parseOrThrow(source, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(fileName),
  );
  const raw = Reflect.get(sourceFile, 'parseDiagnostics');
  const diagnostics = Array.isArray(raw) ? raw : [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new CommentExtractionError(
      `${fileName} did not parse cleanly (${diagnostics.length} syntax error(s); first: ${detail}).`,
      fileName,
    );
  }
  return sourceFile;
}

/**
 * Every span in the file that is literal text rather than code.
 *
 * Template expressions contribute only their TEXT parts: a `${…}` substitution
 * is code and may hold comments of its own that must still be found.
 *
 * @param {ts.SourceFile} sourceFile
 * @returns {LiteralSpan[]}
 */
function collectLiteralSpans(sourceFile) {
  /** @type {LiteralSpan[]} */
  const spans = [];
  /** @param {ts.Node} node */
  const push = (node) => {
    spans.push({ start: node.getStart(sourceFile), end: node.end });
  };
  /** @param {ts.Node} node */
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    ) {
      push(node);
    } else if (ts.isTemplateExpression(node)) {
      push(node.head);
      for (const span of node.templateSpans) push(span.literal);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Strip comment markers and join the lines into flowing prose.
 *
 * Lines are joined so a sentence wrapped across several comment lines reads as
 * one sentence: a qualifier must still govern a phrase that landed on the next
 * line, which is exactly the case a line-at-a-time reader gets wrong.
 *
 * @param {string} comment
 * @returns {string}
 */
export function stripMarkers(comment) {
  return comment
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+)\s?/, '').trimEnd())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every comment in `source`, in source order, each with its position.
 *
 * @param {string} source
 * @param {string} [fileName] Used for the ScriptKind and in error messages.
 * @returns {ExtractedComment[]}
 * @throws {CommentExtractionError} when the file does not parse cleanly.
 */
export function extractComments(source, fileName = 'module.ts') {
  const sourceFile = parseOrThrow(source, fileName);
  const spans = collectLiteralSpans(sourceFile);

  /** @type {ExtractedComment[]} */
  const comments = [];
  const n = source.length;
  let index = 0;
  let cursor = 0;

  /**
   * @param {number} start
   * @param {number} end
   * @param {'line' | 'block'} kind
   */
  const record = (start, end, kind) => {
    const raw = source.slice(start, end);
    const at = sourceFile.getLineAndCharacterOfPosition(start);
    const to = sourceFile.getLineAndCharacterOfPosition(Math.max(start, end - 1));
    comments.push({
      text: stripMarkers(raw),
      raw,
      kind,
      line: at.line + 1,
      column: at.character + 1,
      endLine: to.line + 1,
      start,
      end,
    });
  };

  while (index < n) {
    while (cursor < spans.length && (spans[cursor]?.end ?? 0) <= index) cursor += 1;
    const span = spans[cursor];
    if (span !== undefined && span.start <= index) {
      index = span.end;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      let end = index;
      while (end < n && source[end] !== '\n') end += 1;
      record(index, end, 'line');
      index = end;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      let end = index + 2;
      while (end < n && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      const stop = Math.min(end + 2, n);
      record(index, stop, 'block');
      index = stop;
      continue;
    }
    index += 1;
  }

  return comments;
}
