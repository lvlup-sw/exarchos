// The real specifier parser behind the SDK generation seam census.
//
// `src/architecture/sdk-generation-seam.ts` decides which specifiers belong to which SDK
// generation. This module decides what a specifier is, with the TypeScript parser. A specifier in
// a comment, a string or a template literal is not an import node, so the parse excludes it by
// construction. A regex over raw source counts such text as an import.
//
// The module lives outside `src/`, because `typescript` is a devDependency. An import under `src/`
// makes the compiler a runtime dependency of the shipped binary. The effect ledger also classifies
// `typescript` as an unvetted dependency, and `ts.sys` gives full filesystem access, so it cannot
// be vetted as inert. The effect ledger skips `test-helpers` directories.

import ts from 'typescript';
import type {
  ParsedSpecifier,
  SpecifierParser,
} from '../../src/architecture/sdk-generation-seam.js';

/**
 * `parseDiagnostics` is not on the public `ts.SourceFile` type, but only it tells a clean parse
 * from a recovered one. This narrowing predicate reads it with no `as` cast.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parses one module and throws on a recovered parse. `ts.createSourceFile` does not throw on
 * broken input. It returns a partial tree with missing nodes. An under-count then reads as
 * migration progress, so a recovered parse is fatal.
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
      `module-specifier-parser: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to ` +
        `report specifiers derived from a recovered parse, which would silently ` +
        `under-report and read as migration progress.`,
    );
  }
  return sourceFile;
}

/**
 * Every module specifier that the parsed program imports or re-exports, with the 1-based line of
 * the specifier literal. The forms are `import ... from 'p'`, `import 'p'`, `export ... from 'p'`,
 * `import('p')`, `require('p')` and `import p = require('p')`.
 *
 * Type-only imports are included. The lint asks which module names which SDK generation. A
 * type-only import of `@modelcontextprotocol/sdk` is such a coupling, although emit erases it.
 */
export const parseModuleSpecifiers: SpecifierParser = (
  source: string,
  fileName = 'source.ts',
): readonly ParsedSpecifier[] => {
  const sourceFile = parseOrThrow(source, fileName);
  const specifiers: ParsedSpecifier[] = [];

  const record = (literal: ts.Node, text: string): void => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(
      literal.getStart(sourceFile),
    );
    specifiers.push({ specifier: text, line: line + 1 });
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record(node.moduleSpecifier, node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      record(node.moduleReference.expression, node.moduleReference.expression.text);
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
        record(first, first.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);

  return specifiers;
};
