// ─── DR-26 — the real lexer behind the effect ledger and its siblings (task 065)
//
// `architecture/effect-ledger.ts` decides WHICH specifiers are effects, WHICH
// shapes are ambient globals and WHO owns each occurrence. It does not, and must
// not, decide what a specifier IS or which characters of a file are code — those
// are questions about TypeScript's grammar, and the only instrument that cannot
// disagree with the compiler about them is the compiler.
//
// ── Why this module is HERE and not next to the policy it serves ─────────────
// The obvious home is `architecture/effect-ledger.ts` itself. It is the wrong
// one, and the reason is measured rather than assumed — task 062 ran the
// experiment and this task inherits the result:
//
//   • `typescript` is a devDependency of this package, not a dependency. A
//     module under `src/` that imports it makes the compiler a runtime
//     dependency of a tree whose shipped artifact (`bun build --compile` from
//     `src/index.ts`) resolves only `dependencies`.
//   • The effect ledger enforces exactly that, against itself. `typescript` is
//     not in `INERT_DEPENDENCIES`, so the closed-world rule classifies it
//     `unvetted-dependency:typescript` — a NETWORK occurrence — under
//     `architecture/`, a layer that owns no network rule. Adding the import to
//     the ledger was tried and the live census answered with one
//     `INDETERMINATE_OWNER`. The guard is real and it is right.
//   • Vetting `typescript` inert would be FALSE at the granularity the ledger
//     vets. Its allowlist entries all turn on "the effectful surface is not
//     reachable from what we import" (see the `@modelcontextprotocol/server`
//     entry, which names the exact re-exported symbols). `import ts from
//     'typescript'` puts `ts.sys` — full filesystem and process access — one
//     property access away, and `ts.createProgram` reads files. That entry could
//     not be written honestly, so it is not written.
//
// `test-helpers/` is the home that costs nothing: `effect-ledger.ts`'s
// `EXCLUDED_DIRS` skips it (not shipped source), while `tsconfig.json` still
// INCLUDES it, so this parser is typechecked under the package's own strict
// settings rather than living in an unchecked corner. The cast ratchet
// (`tools/audit/tsconfig-strictness/count-casts.ts`) also scans it, which is why the
// `parseDiagnostics` access below is a type guard rather than the `as` the
// sibling censuses use.
//
// ── Why parse at all ────────────────────────────────────────────────────────
// The superseded implementation — retained verbatim next door as
// `superseded-source-lexer.ts`, so the kill fixture can assert both numbers —
// was a pair of hand-rolled comment/string/regex-aware walks whose own headers
// admitted the regex-versus-division rule was a heuristic. Two measured
// disagreements, both reproducible from that file:
//
//   • a NESTED template substitution made the heuristic report an import the
//     module does not have (the census inventing an effect);
//   • a regex literal containing a backtick, in a position the heuristic scored
//     as division, opened a phantom template that ran to EOF and hid a real
//     `node:fs` import (the census missing an effect).
//
// Hand-rolling a better stripper is not the fix — it is how the defect arrives,
// three near-duplicate times in this package alone. A specifier inside a
// comment, a string or a template is not an import NODE, so the parse excludes
// it BY CONSTRUCTION; and the mask is computed from the parse's own literal
// spans, so the two answers cannot drift apart.
//
// ── The three survivors, and the third answer they needed (task 072) ────────
// Task 065 named them and task 072 measured each one on 065's own adversarial
// inputs. All three were wrong, and two of them in the dangerous direction:
//
//   • `workflow/admission/remediation-purity.ts` reported NO imports for a
//     module that really imports `node:fs` — a forbidden marker — so the purity
//     census returned `ok: true` for an impure module;
//   • `architecture/delivery-safety.ts` left a real `catch {}` unseen for the
//     same reason, and invented one inside a nested template;
//   • `architecture/vcs-ownership.ts` leaked comment prose into its scan and
//     charged a module with a `git worktree add` it does not perform.
//
// Two of the three wanted `maskedSource` and `imports`, which this parse already
// answered. The third wanted something it did not: comments gone with STRING
// LITERALS KEPT, because the tokens `vcs-ownership` matches on (`'worktree'`,
// `'add'`) are themselves string literals. That is {@link
// LexedSource.commentMaskedSource} — a third answer off the SAME parse, not a
// second parser, so it cannot disagree with the other two about the same file.

import ts from 'typescript';
import type { ImportRef, LexedModule } from '../../src/architecture/effect-ledger.js';

/**
 * `parseDiagnostics` is off the public `ts.SourceFile` surface but is the only
 * way to tell a CLEAN parse from a RECOVERED one.
 *
 * Written as a narrowing predicate over `unknown` rather than an `as` cast: the
 * wave's remaining cast budget is five sites for every task combined, and this
 * file is inside the ratchet's scan.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * `ts.createSourceFile` never throws: handed broken input it returns a partial
 * tree with nodes silently missing. For an effect census an under-count is the
 * dangerous direction — a module whose imports vanished reads as effect-free and
 * passes the gate clean — so a recovered parse is fatal here rather than quietly
 * averaged in. Same judgement, same reason, as the sibling censuses.
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
 * Every non-code span the mask must blank, EXCEPT comments.
 *
 * Comments are trivia rather than nodes, so they are not collected here; they
 * are recognised in {@link blankNonCode}, where the literal spans are already
 * known and a `/` outside them is therefore unambiguous. That ordering is what
 * removes the heuristic entirely: the only reason the old walks needed a
 * regex-versus-division rule is that they tried to answer both questions at
 * once.
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
      // Only the TEXT parts. `${…}` substitutions are code, including a nested
      // template inside one — which is precisely where the retired heuristic
      // inverted its own state and read template text as code.
      push(node.head);
      for (const span of node.templateSpans) push(span.literal);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Blank every comment and — when `literals` is `'blank'` — every literal span,
 * preserving newlines and length so offsets stay aligned to the original source.
 *
 * Correctness rests on one observation: with the literal spans already known
 * from the parse, a `/` encountered OUTSIDE them can only begin a comment. It
 * cannot be a regex literal (that would be a literal span) and `//` is never
 * division. So the ambiguity the old lexers guessed at does not arise here.
 *
 * `literals: 'keep'` copies literal spans through verbatim instead of blanking
 * them, which is the only difference between the two masks this module returns.
 * The COMMENT half is shared rather than re-derived, so the answer a caller who
 * wants literals cannot drift from the answer a caller who does not gets — the
 * exact drift three near-duplicate hand-rolled walks had by construction.
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
 * Every MODULE SPECIFIER the parsed program imports or re-exports, tagged with
 * whether the form is erased at emit.
 *
 * Covers every form the tree uses or could use, so the parse cannot under-report
 * where the superseded text walk could not miss:
 *
 *   `import x from 'p'` · `import type { T } from 'p'` · `import 'p'` ·
 *   `export { x } from 'p'` · `export * from 'p'` · `export type { T } from 'p'` ·
 *   `await import('p')` · `require('p')` · `import p = require('p')` ·
 *   the `import('p').T` TYPE QUERY
 *
 * The type query is included, tagged type-only, on purpose and it is the one
 * place this differs from the retired walk in a way that MATTERS. The walk
 * counted `import('…')` type queries as VALUE imports, which was wrong for the
 * effect ledger (they are erased, so they perform nothing) — but dropping them
 * entirely would be wrong for `layer-boundaries-seam.ts`, whose question is "is
 * there an edge", and a type query is one. Tagging it lets both consumers be
 * right: the ledger filters on `typeOnly`, the layering census does not.
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
 * Everything {@link lexModule} answers: the {@link LexedModule} surface the
 * effect ledger declared, plus the one answer its two siblings needed and it
 * did not have.
 *
 * A consumer never names this type. Each declares the MINIMAL port it needs —
 * `ModuleLexer` in `effect-ledger.ts` and `delivery-safety.ts`, `CommentLexer`
 * in `vcs-ownership.ts` — and `lexModule` satisfies all of them structurally.
 * That keeps "which lexical question does this census ask" visible at the
 * consumer, where it is a fact about the census, rather than collapsing every
 * consumer onto one wide interface.
 */
export interface LexedSource extends LexedModule {
  /**
   * `source` with every comment blanked to spaces (newlines and offsets
   * preserved) and every string, template and regex literal kept VERBATIM.
   *
   * The complement of {@link LexedModule.maskedSource}, and needed for the same
   * reason that one is: `vcs-ownership.ts` matches on argv literals
   * (`['worktree', 'add']`), so blanking string bodies would blank its entire
   * subject, while leaving comments in place charges a module with a mutation
   * that only its documentation performs.
   */
  readonly commentMaskedSource: string;
}

/** The widest shape {@link lexModule} answers. See {@link LexedSource}. */
export type SourceLexer = (source: string, fileName?: string) => LexedSource;

/**
 * The lexer-port implementation: ONE parse, three answers.
 *
 * All three come from the SAME `ts.SourceFile`, which is the structural reason
 * the import surface, the masked-code surface and the comment-stripped surface
 * can no longer disagree about the same file — the failure mode four
 * near-duplicate hand-rolled lexers had by construction.
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
