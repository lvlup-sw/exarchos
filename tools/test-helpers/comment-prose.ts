// ─── Comment prose, separated from code, for the sweeps that read prose ─────
//
// A "is this framing still cited anywhere" sweep is a claim about what the tree
// SAYS, and a claim about prose has two failure modes that a grep over raw file
// text cannot tell apart:
//
//   • an occurrence in CODE — an identifier, a string literal, a regex source,
//     a `describe(...)` title — which is not prose at all; and
//   • an occurrence in prose that NAMES the framing in order to say it is
//     retired, which is the opposite of citing it.
//
// `governing-catalog.test.ts` had both. Its own header says "the retired INV-2
// parity framing must have no citation left", its sweep's failure message
// repeats the phrase, and its fixture had to be written as `'INV-2' + ' parity'`
// so the file would not look like an offender to its own detector. The detector
// matched the SPELLING; nothing in it addressed the meaning.
//
// This module supplies the first half — the comment text, and only the comment
// text — so "is this code or prose" is answered by the grammar rather than by
// another regex. The second half (a mention is not a citation) belongs with the
// sweep that defines the framing.
//
// It PARSES, for the reason `module-lexer.ts` records and this module measured
// again on its first draft. Driving `ts.createScanner` token by token cannot
// resume a template literal after a `${…}` substitution, so the tail of
// `` `${x}\n// text` `` re-entered the token stream as a COMMENT: the extractor
// invented prose that the file does not contain, and the sweep reported an
// offender that was a string all along. With the literal spans known from a
// parse, a `/` outside them can only begin a comment — the ambiguity does not
// arise rather than being guessed at.

import ts from 'typescript';

/**
 * `parseDiagnostics` is off the public `ts.SourceFile` surface but is the only
 * way to tell a CLEAN parse from a RECOVERED one. A narrowing predicate rather
 * than an `as`, because the cast ratchet scans this directory.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse — a partial tree silently loses
 * literal spans, and a lost span turns code back into "prose".
 */
function parseOrThrow(source: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  const diagnostics: readonly ts.Diagnostic[] = isDiagnosticArray(raw) ? raw : [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `comment-prose: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}).`,
    );
  }
  return sourceFile;
}

/** A half-open `[start, end)` source range that is a literal, not code. */
interface LiteralSpan {
  readonly start: number;
  readonly end: number;
}

function collectLiteralSpans(sourceFile: ts.SourceFile): LiteralSpan[] {
  const spans: LiteralSpan[] = [];
  const push = (node: ts.Node): void => {
    spans.push({ start: node.getStart(sourceFile), end: node.end });
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isJsxText(node)
    ) {
      push(node);
    } else if (ts.isTemplateExpression(node)) {
      // Only the TEXT parts; a `${…}` substitution is code and may contain
      // comments of its own.
      push(node.head);
      for (const span of node.templateSpans) push(span.literal);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return spans.sort((a, b) => a.start - b.start);
}

/** Every comment token in `source`, in source order, markers included. */
function collectComments(source: string, spans: readonly LiteralSpan[]): string[] {
  const comments: string[] = [];
  const n = source.length;
  let index = 0;
  let cursor = 0;
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
      comments.push(source.slice(index, end));
      index = end;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      let end = index + 2;
      while (end < n && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      const stop = Math.min(end + 2, n);
      comments.push(source.slice(index, stop));
      index = stop;
      continue;
    }
    index += 1;
  }
  return comments;
}

/**
 * Every comment in `source`, with its line/block markers removed and lines
 * joined into flowing prose.
 *
 * Markers are stripped and lines joined so that a sentence wrapped across
 * several comment lines reads as one sentence — a qualifier ("the retired …")
 * must still govern a phrase that landed on the next line.
 */
export function extractCommentProse(source: string, fileName = 'module.ts'): string {
  const sourceFile = parseOrThrow(source, fileName);
  return collectComments(source, collectLiteralSpans(sourceFile))
    .map(stripMarkers)
    .join('\n');
}

function stripMarkers(comment: string): string {
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
 * The sentence `index` falls in, up to `index`.
 *
 * Sentence scope is what makes a qualifier legible: "the retired X framing" and
 * "X, per the contract" differ by a word several tokens back, and a fixed
 * character window would either miss a wrapped qualifier or borrow one from an
 * unrelated neighbouring claim.
 */
export function sentenceBefore(prose: string, index: number): string {
  const start = sentenceStart(prose, index);
  return prose.slice(start, index);
}

function sentenceStart(prose: string, index: number): number {
  return (
    Math.max(
      prose.lastIndexOf('.', index - 1),
      prose.lastIndexOf('!', index - 1),
      prose.lastIndexOf('?', index - 1),
      prose.lastIndexOf('\n', index - 1),
    ) + 1
  );
}

/**
 * Whether the phrase at `index` sits inside a quotation — i.e. is MENTIONED
 * rather than used.
 *
 * The use–mention distinction is the other half of "a phrase is not a claim".
 * Prose that writes `"INV-2 parity"` in quotes is naming the words, which is
 * what any document defining, quoting or retiring a framing has to do; prose
 * that writes them bare is asserting them. Without this rule the only way to
 * discuss a retired framing is to avoid spelling it — which is the workaround
 * this whole repair exists to delete.
 *
 * Counted per sentence over the unambiguous marks only. A bare `'` is left out
 * on purpose: in English prose it is far more often an apostrophe than a quote,
 * and mis-reading `detector's` as an open quote would silence the rest of the
 * sentence.
 */
export function isQuotedMention(prose: string, index: number): boolean {
  const before = prose.slice(sentenceStart(prose, index), index);
  return countOf(before, '"') % 2 === 1 || countOf(before, '`') % 2 === 1;
}

function countOf(text: string, mark: string): number {
  let count = 0;
  for (const ch of text) if (ch === mark) count += 1;
  return count;
}
