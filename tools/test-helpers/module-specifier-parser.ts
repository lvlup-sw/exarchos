// ─── DR-26 — the real specifier parser behind the SDK seam census (task 062) ─
//
// `architecture/sdk-generation-seam.ts` decides WHICH specifiers belong to
// WHICH SDK generation. It does not, and must not, decide what a specifier IS —
// that is a question about TypeScript's grammar, and the only instrument that
// cannot disagree with the compiler about it is the compiler.
//
// ── Why this module is HERE and not next to the rule it serves ──────────────
// The obvious home is `architecture/sdk-generation-seam.ts` itself. It is the
// wrong one, and the reason is measured rather than assumed:
//
//   • `typescript` is a devDependency of this package, not a dependency. A
//     module under `src/` that imports it makes the compiler a runtime
//     dependency of a tree whose shipped artifact (`bun build --compile` from
//     `src/index.ts`) resolves only `dependencies`.
//   • The effect ledger already enforces exactly that. `typescript` is not in
//     `architecture/effect-ledger.ts`'s `INERT_DEPENDENCIES` allowlist, so the
//     closed-world rule classifies it `unvetted-dependency:typescript` — a
//     NETWORK occurrence — under `architecture/`, which owns no network rule.
//     Adding the import to the seam module was tried and the live census
//     answered with one `INDETERMINATE_OWNER` diagnostic. The guard is real and
//     it is right.
//   • Vetting `typescript` as inert would be false at the granularity the
//     ledger vets. Its allowlist entries turn on "the effectful surface is not
//     reachable from what we import" (see the `@modelcontextprotocol/server`
//     entry). `import ts from 'typescript'` puts `ts.sys` — full filesystem and
//     process access — one property access away, and `ts.createProgram` reads
//     files. That entry could not be written honestly.
//
// `test-helpers/` is the home that costs nothing: `effect-ledger.ts`'s
// `EXCLUDED_DIRS` skips it (not shipped source), while `tsconfig.json` still
// INCLUDES it, so this parser is typechecked under the package's own strict
// settings rather than living in an unchecked `__tests__` corner. The cast
// ratchet (`tools/audit/tsconfig-strictness/count-casts.ts`) also scans it, which is
// why the `parseDiagnostics` access below is written as a type guard rather than
// as the `as` the sibling censuses use.
//
// ── Why parse at all ────────────────────────────────────────────────────────
// The superseded scanner matched
//   /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g
// against raw source with no comment or literal exclusion, so an SDK specifier
// written inside a template literal counted as an import. That is the sixth
// appearance of one defect class in this program (see the spec's
// measure-the-wrong-property table) and the first that was load-bearing: the
// lint's own fixture file contributed TEN phantom sites to DR-26's
// `bypassSiteCount`, flooring task 053's migration denominator above zero.
//
// Hand-rolling a comment/literal stripper is not the fix — it is how the defect
// arrives. Task 061 measured TypeScript's OWN `ts.createScanner`, driven without
// parser context, desyncing on template-literal substitutions. A specifier
// inside a comment, a string or a template literal is not an import node, so the
// parse excludes it BY CONSTRUCTION rather than by filtering.

import ts from 'typescript';
import type {
  ParsedSpecifier,
  SpecifierParser,
} from '../../src/architecture/sdk-generation-seam.js';

/**
 * `parseDiagnostics` is off the public `ts.SourceFile` surface but is the only
 * way to tell a CLEAN parse from a RECOVERED one.
 *
 * Written as a narrowing predicate over `unknown` rather than the `as` cast that
 * `tools/audit/tsconfig-strictness/count-casts.ts` and
 * `tools/audit/gates/check-measured-premises.mjs` use for the same access. Those two live
 * in `scripts/`, which the cast ratchet does not scan; this file is scanned, and
 * the wave's remaining budget is five sites for every task combined.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * `ts.createSourceFile` never throws: handed broken input it returns a partial
 * tree with nodes silently missing. For a MIGRATION denominator an under-count
 * is the dangerous direction — it reads as "sites were migrated" and passes the
 * gate clean — so a recovered parse is fatal here rather than quietly averaged
 * in. Same judgement, same reason, as the two sibling censuses.
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
      `module-specifier-parser: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to ` +
        `report specifiers derived from a recovered parse, which would silently ` +
        `under-report and read as migration progress.`,
    );
  }
  return sourceFile;
}

/**
 * Every MODULE SPECIFIER the parsed program actually imports or re-exports,
 * with the 1-based line of the specifier literal.
 *
 * Covers every form the tree uses or could use, so the parse cannot under-report
 * where the superseded text match could not miss:
 *
 *   `import x from 'p'` · `import type { T } from 'p'` · `import 'p'` ·
 *   `export { x } from 'p'` · `export * from 'p'` · `await import('p')` ·
 *   `require('p')` · `import p = require('p')`
 *
 * Type-only imports are INCLUDED deliberately. This parser feeds a lint about
 * which module may *name* which SDK generation, not one about runtime effects:
 * `import type { Transport } from '@modelcontextprotocol/sdk/…'` is exactly the
 * cross-generation coupling DR-26 exists to see, and it is erased at emit. (The
 * effect ledger, whose question IS runtime effect, tags type-only separately for
 * the opposite reason.)
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
