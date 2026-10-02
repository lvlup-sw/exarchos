/**
 * The TypeScript-parser lexer behind the effect ledger and its sibling censuses. The ledger decides
 * which specifiers are effects and who owns them. Which characters are code and what a specifier
 * is are grammar questions, so the compiler answers them.
 *
 * This module is not under `src/`, because `typescript` is a devDependency. A shipped module that
 * imports it makes the compiler a runtime dependency, and the ledger classifies that import as an
 * unvetted network dependency.
 *
 * One parse gives three answers: the imports, the masked source and the comment-masked source. A
 * specifier in a comment, a string or a template is not an import node, so the parse excludes it.
 * The superseded hand-written walks stay in `superseded-source-lexer.ts` for the kill fixture.
 */

import ts from 'typescript';
import type { ImportRef, LexedModule } from '../../src/architecture/effect-ledger.js';

/**
 * Narrows `parseDiagnostics`, which is off the public `ts.SourceFile` surface. It is the only way to
 * tell a clean parse from a recovered one. A predicate over `unknown` avoids an `as` cast.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parses one module and refuses a recovered parse. `ts.createSourceFile` never throws: on broken
 * input it returns a partial tree with missing nodes. A module whose imports vanished reads as
 * effect-free, so a recovered parse is fatal here.
 */
function parseOrThrow(source: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.TS,
  );
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  const diagnostics: readonly ts.Diagnostic[] = isDiagnosticArray(raw) ? raw : [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `module-lexer: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to report ` +
        `a lexical answer derived from a recovered parse, which would silently ` +
        `under-report imports and read as an effect-free module.`,
    );
  }
  return sourceFile;
}

/** A half-open `[start, end)` source range that is NOT code. */
interface LiteralSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * Every non-code span that the mask blanks, except comments. Comments are trivia, not nodes, so
 * {@link blankNonCode} finds them after the literal spans are known. A `/` outside a literal span is
 * then unambiguous. A template expression gives only its text parts, because a `${…}` substitution
 * is code, nested templates included.
 */
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
      push(node.head);
      for (const span of node.templateSpans) push(span.literal);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Blanks every comment, and every literal span when `literals` is `'blank'`. Newlines and length
 * stay, so offsets match the original source. With the literal spans known, a `/` outside them can
 * only start a comment. A regex is a literal span, and `//` is never division. With
 * `literals: 'keep'`, literal spans pass through verbatim. Both masks share the comment logic.
 */
function blankNonCode(
  source: string,
  spans: readonly LiteralSpan[],
  literals: 'blank' | 'keep',
): string {
  const out: string[] = [];
  const n = source.length;
  let index = 0;
  let spanCursor = 0;

  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) out.push(source[k] === '\n' ? '\n' : ' ');
  };

  while (index < n) {
    while (spanCursor < spans.length && (spans[spanCursor]?.end ?? 0) <= index) spanCursor += 1;
    const span = spans[spanCursor];
    if (span !== undefined && span.start <= index) {
      if (literals === 'keep') out.push(source.slice(index, Math.min(span.end, n)));
      else blankRange(index, span.end);
      index = span.end;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '/') {
      let end = index;
      while (end < n && source[end] !== '\n') end += 1;
      blankRange(index, end);
      index = end;
      continue;
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      let end = index + 2;
      while (end < n && !(source[end] === '*' && source[end + 1] === '/')) end += 1;
      const stop = Math.min(end + 2, n);
      blankRange(index, stop);
      index = stop;
      continue;
    }
    out.push(source[index] ?? '');
    index += 1;
  }
  return out.join('');
}

/**
 * Every module specifier that the parsed program imports or re-exports, tagged with whether the
 * form is erased at emit. The forms are `import x from 'p'`, `import type`, `import 'p'`,
 * `export … from 'p'`, `export type … from 'p'`, `import('p')`, `require('p')`,
 * `import p = require('p')` and the `import('p').T` type query.
 *
 * The type query is tagged type-only. The effect ledger skips `typeOnly` imports, because an erased
 * import does nothing. `layer-boundaries-seam.ts` keeps it, because a type query is an edge.
 */
function collectImports(sourceFile: ts.SourceFile): ImportRef[] {
  const imports: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({
          specifier: node.moduleSpecifier.text,
          typeOnly: node.importClause?.isTypeOnly === true,
        });
      }
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      imports.push({
        specifier: node.moduleReference.expression.text,
        typeOnly: node.isTypeOnly,
      });
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) {
        imports.push({ specifier: argument.literal.text, typeOnly: true });
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const first = node.arguments[0];
      if (
        (isDynamicImport || isRequire) &&
        first !== undefined &&
        (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))
      ) {
        imports.push({ specifier: first.text, typeOnly: false });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return imports;
}

/**
 * Everything that {@link lexModule} answers: the {@link LexedModule} surface plus
 * `commentMaskedSource`. A consumer never names this type. Each consumer declares the minimal port
 * that it needs (`ModuleLexer`, `CommentLexer`), and `lexModule` satisfies each one structurally.
 */
export interface LexedSource extends LexedModule {
  /**
   * `source` with every comment blanked to spaces, with newlines and offsets kept. String, template
   * and regex literals stay verbatim. `vcs-ownership.ts` matches argv literals such as
   * `['worktree', 'add']`, so it needs the literals and must not see the comments.
   */
  readonly commentMaskedSource: string;
}

/** The widest shape {@link lexModule} answers. See {@link LexedSource}. */
export type SourceLexer = (source: string, fileName?: string) => LexedSource;

/**
 * The lexer-port implementation: one parse, three answers. All three come from the same
 * `ts.SourceFile`, so the imports, the masked source and the comment-masked source cannot disagree
 * about a file.
 */
export const lexModule: SourceLexer = (
  source: string,
  fileName = 'module.ts',
): LexedSource => {
  const sourceFile = parseOrThrow(source, fileName);
  const spans = collectLiteralSpans(sourceFile);
  return {
    imports: collectImports(sourceFile),
    maskedSource: blankNonCode(source, spans, 'blank'),
    commentMaskedSource: blankNonCode(source, spans, 'keep'),
  };
};
