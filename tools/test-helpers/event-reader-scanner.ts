// ─── The real resolver behind the fold-external event-reader census ──────────
//
// `src/events/partition/reader-census.ts` decides WHAT a fold-external read of
// an event means for the governance/telemetry partition. It does not, and must
// not, decide what a piece of TypeScript MEANS — whether `{ type: X }` names an
// event type is a question about bindings, and the only instrument that cannot
// disagree with the compiler about bindings is the compiler.
//
// ── Why this module is HERE and not next to the policy it serves ─────────────
// The same reasoning the evidence-emission scanner states for itself:
// `typescript` is a devDependency, so a shipped `src/` module importing it makes
// the compiler a runtime dependency of a tree whose shipped artifact resolves
// only `dependencies`, and the effect ledger enforces exactly that against
// itself.
//
// ── Why three forms and not one ─────────────────────────────────────────────
// A scoped query is the minority spelling. Most correctness-bearing readers in
// this tree fold a stream unfiltered and compare `.type` downstream, inside a
// guard or a saga; several switch on it. A census that only read
// `filters.type` would miss precisely the guard-layer literals that are the
// clearest dependencies in the tree, and would look complete while doing so.
//
//   • `store.query(id, { type: X })` / `store.queryByType(X, …)`;
//   • `event.type === 'x'`, `e.type !== 'x'`, and the bare `type` / `eventType`
//     identifiers the same comparison is written with elsewhere;
//   • `case 'x':` on a switch whose discriminant is one of those shapes.
//
// A query call carrying no type filter is reported as an UNSCOPED read rather
// than as nothing: it depends on the whole type universe, and calling that
// "reads no event" is the under-report the census refuses.
//
// The AST helpers below are deliberately local rather than shared with the
// evidence scanner: that port answers "what does this module APPEND", this one
// answers "what does this module READ", and folding them into one traversal
// would make a change made for one census silently change the other's answer.

import ts from 'typescript';
import type {
  EventReaderScanOptions,
  EventReaderScanner,
  EventReaderSite,
} from '../../src/events/partition/reader-census.js';

/**
 * `parseDiagnostics` is off the public `ts.SourceFile` surface but is the only
 * way to tell a CLEAN parse from a RECOVERED one. A narrowing predicate rather
 * than an assertion, because the cast ratchet scans this directory.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * `ts.createSourceFile` never throws: handed broken input it returns a partial
 * tree with nodes silently missing. A reader whose comparison vanished reads as
 * a module that depends on nothing, which is the direction this census must not
 * fail in.
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
      `event-reader-scanner: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to report a reader ` +
        `census derived from a recovered parse, which would under-report readers and read as a ` +
        `module that depends on no event.`,
    );
  }
  return sourceFile;
}

/** Strip `as const`, `satisfies T`, `<T>x`, `x!` and parentheses to the value beneath. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Local name → the name it was imported under, for every named import in the
 * file, so an aliased constant table still resolves against canonical paths.
 */
function collectImportAliases(sourceFile: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      aliases.set(element.name.text, (element.propertyName ?? element.name).text);
    }
  }
  return aliases;
}

/**
 * Every `const NAME = <expression>` in the file, at any nesting depth.
 *
 * Deliberately flat rather than scope-accurate: an over-broad binding table can
 * only make a read MORE resolvable, and a same-named shadow resolving to a
 * different type surfaces as a reader to examine — the fail-loud direction.
 */
function collectConstBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      !bindings.has(node.name.text)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return bindings;
}

interface ResolutionContext {
  readonly aliases: ReadonlyMap<string, string>;
  readonly bindings: ReadonlyMap<string, ts.Expression>;
  readonly knownConstants: ReadonlyMap<string, string>;
}

/** The string an expression evaluates to, or `undefined` when undecidable. */
function resolveString(
  node: ts.Expression,
  ctx: ResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const expr = unwrap(node);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

  // `TABLE.MEMBER` — an exported constant table the census supplied, reached
  // under whatever local name this file imported it as.
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    const local = expr.expression.text;
    const canonical = ctx.aliases.get(local) ?? local;
    const viaKnown = ctx.knownConstants.get(`${canonical}.${expr.name.text}`);
    if (viaKnown !== undefined) return viaKnown;
    const declared = ctx.bindings.get(local);
    if (declared !== undefined && !seen.has(local)) {
      const object = unwrap(declared);
      if (ts.isObjectLiteralExpression(object)) {
        const member = ownProperty(object, expr.name.text);
        if (member !== undefined) {
          return resolveString(member, ctx, new Set([...seen, local]));
        }
      }
    }
    return undefined;
  }

  // A plain identifier bound to a literal (or to another identifier that is).
  if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
    const bound = ctx.bindings.get(expr.text);
    if (bound !== undefined) {
      return resolveString(bound, ctx, new Set([...seen, expr.text]));
    }
  }

  return undefined;
}

/** The last own-property initializer for `name`, ignoring spreads. */
function ownProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      found = property.initializer;
    } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      found = property.name;
    }
  }
  return found;
}

/** The object literal an argument denotes, inline or hoisted into a `const`. */
function asObjectLiteral(
  node: ts.Expression,
  ctx: ResolutionContext,
): ts.ObjectLiteralExpression | undefined {
  const expr = unwrap(node);
  if (ts.isObjectLiteralExpression(expr)) return expr;
  if (ts.isIdentifier(expr)) {
    const bound = ctx.bindings.get(expr.text);
    if (bound !== undefined) {
      const inner = unwrap(bound);
      if (ts.isObjectLiteralExpression(inner)) return inner;
    }
  }
  return undefined;
}

/**
 * Whether an expression is the kind of thing an event-type discriminant is read
 * from: `something.type`, or a bare `type` / `eventType` binding — the last
 * spelling being live in this tree's own event tool surface.
 */
function isEventTypeReference(node: ts.Expression): boolean {
  const expr = unwrap(node);
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text === 'type';
  if (ts.isElementAccessExpression(expr)) {
    const argument = unwrap(expr.argumentExpression);
    return ts.isStringLiteral(argument) && argument.text === 'type';
  }
  if (ts.isIdentifier(expr)) return expr.text === 'type' || expr.text === 'eventType';
  return false;
}

const COMPARISON_TOKENS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * Every fold-external read of an event type in one module.
 *
 * `.append` is deliberately NOT inspected: an append is a write, and a census
 * that counted it would report every emitter as a dependency on its own event.
 */
export const scanEventReaders: EventReaderScanner = (
  source: string,
  options: EventReaderScanOptions,
): readonly EventReaderSite[] => {
  const fileName = options.fileName ?? 'module.ts';
  const sourceFile = parseOrThrow(source, fileName);
  const ctx: ResolutionContext = {
    aliases: collectImportAliases(sourceFile),
    bindings: collectConstBindings(sourceFile),
    knownConstants: options.knownConstants,
  };

  const sites: EventReaderSite[] = [];

  const visitQuery = (node: ts.CallExpression, method: string): void => {
    const line = lineOf(sourceFile, node);
    if (method === 'queryByType') {
      const first = node.arguments[0];
      sites.push({
        line,
        kind: 'query-discriminant',
        discriminant: first === undefined ? undefined : resolveString(first, ctx),
      });
      return;
    }
    // `.query(streamId, filters?)` — the filter bag is the second argument.
    const filters = node.arguments[1];
    if (filters === undefined) {
      sites.push({ line, kind: 'unscoped-query', discriminant: undefined });
      return;
    }
    const object = asObjectLiteral(filters, ctx);
    const typeProperty = object === undefined ? undefined : ownProperty(object, 'type');
    if (object !== undefined && typeProperty === undefined) {
      // A readable filter bag that narrows by anything except type still reads
      // the whole type universe.
      sites.push({ line, kind: 'unscoped-query', discriminant: undefined });
      return;
    }
    sites.push({
      line,
      kind: 'query-discriminant',
      discriminant: typeProperty === undefined ? undefined : resolveString(typeProperty, ctx),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'query' || method === 'queryByType') visitQuery(node, method);
    }

    if (ts.isBinaryExpression(node) && COMPARISON_TOKENS.has(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      const right = unwrap(node.right);
      const subject = isEventTypeReference(left) ? right : isEventTypeReference(right) ? left : undefined;
      if (subject !== undefined) {
        sites.push({
          line: lineOf(sourceFile, node),
          kind: 'type-comparison',
          discriminant: resolveString(subject, ctx),
        });
      }
    }

    if (ts.isSwitchStatement(node) && isEventTypeReference(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue;
        sites.push({
          line: lineOf(sourceFile, clause),
          kind: 'switch-case',
          discriminant: resolveString(clause.expression, ctx),
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return sites;
};
