// The TypeScript resolver for the census of fold-external event readers.
//
// `src/events/partition/reader-census.ts` decides what a fold-external read of an event means for
// the governance and telemetry partition. It must not decide what TypeScript code means. Whether
// `{ type: X }` names an event type is a question about bindings, so the compiler answers it.
//
// This module is not in `src/`, because `typescript` is a devDependency and the shipped artifact
// resolves only `dependencies`.
//
// Most readers fold a stream unfiltered and compare `.type` later. Thus the scanner reads five
// forms: a query filter, a `.type` comparison, a switch case, a membership test, and a family prefix.
// A query with no type filter is an unscoped read, because it depends on every type. The AST
// helpers here are local, not shared with the evidence scanner, so a change for one census does
// not change the other.

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
    false,
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
 * The table is flat, not scope-accurate. An over-broad table can only make a read more resolvable.
 * A same-named shadow that resolves to a different type shows up as a reader to examine, which is
 * the fail-loud direction.
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

/**
 * The string an expression evaluates to, or `undefined` when undecidable. It resolves a literal
 * and an identifier bound to a resolvable value. It also resolves `TABLE.MEMBER` on a known or
 * local constant table, under any import alias.
 */
function resolveString(
  node: ts.Expression,
  ctx: ResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): string | undefined {
  const expr = unwrap(node);

  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }

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

/**
 * The list of strings a collection expression denotes, or `undefined` when the collection is a
 * runtime value.
 *
 * `undefined` and `[]` are different answers. An unresolvable receiver counts as an unresolved
 * read, and a receiver that holds no literal reads nothing. It handles an array literal, a
 * `new Set([…])`, and either of those through a `const` binding.
 */
function resolveStringList(
  node: ts.Expression,
  ctx: ResolutionContext,
  seen: ReadonlySet<string> = new Set(),
): readonly (string | undefined)[] | undefined {
  const expr = unwrap(node);

  if (ts.isArrayLiteralExpression(expr)) {
    return expr.elements.map((element) => resolveString(element, ctx, seen));
  }

  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === 'Set') {
    const first = expr.arguments?.[0];
    return first === undefined ? [] : resolveStringList(first, ctx, seen);
  }

  if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
    const bound = ctx.bindings.get(expr.text);
    if (bound !== undefined) {
      return resolveStringList(bound, ctx, new Set([...seen, expr.text]));
    }
  }

  return undefined;
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
 * True for an expression that holds an event-type discriminant: `something.type`,
 * `something['type']`, or a bare `type` or `eventType` binding.
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
 * The scan does not inspect `.append`. An append is a write, and a census that counted it reports
 * every emitter as a reader of its own event.
 *
 * A `.query` call with no filter bag, or with a readable filter bag that has no `type`, is an
 * unscoped read. A membership test reads every literal of its receiver. An unresolvable receiver
 * gives one unresolved site, because the census cannot decode a set built at runtime. A prefix
 * filter keeps its prefix, and the census expands it against the catalog.
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
    const filters = node.arguments[1];
    if (filters === undefined) {
      sites.push({ line, kind: 'unscoped-query', discriminant: undefined });
      return;
    }
    const object = asObjectLiteral(filters, ctx);
    const typeProperty = object === undefined ? undefined : ownProperty(object, 'type');
    if (object !== undefined && typeProperty === undefined) {
      sites.push({ line, kind: 'unscoped-query', discriminant: undefined });
      return;
    }
    sites.push({
      line,
      kind: 'query-discriminant',
      discriminant: typeProperty === undefined ? undefined : resolveString(typeProperty, ctx),
    });
  };

  const visitMembership = (node: ts.CallExpression, receiver: ts.Expression): void => {
    const argument = node.arguments[0];
    if (argument === undefined || !isEventTypeReference(argument)) return;
    const line = lineOf(sourceFile, node);
    const members = resolveStringList(receiver, ctx);
    if (members === undefined) {
      sites.push({ line, kind: 'membership-test', discriminant: undefined });
      return;
    }
    for (const member of members) {
      sites.push({ line, kind: 'membership-test', discriminant: member });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (method === 'query' || method === 'queryByType') visitQuery(node, method);
      if (method === 'has' || method === 'includes') {
        visitMembership(node, node.expression.expression);
      }
      if (method === 'startsWith' && isEventTypeReference(node.expression.expression)) {
        const argument = node.arguments[0];
        const prefix = argument === undefined ? undefined : resolveString(argument, ctx);
        sites.push({
          line: lineOf(sourceFile, node),
          kind: 'prefix-filter',
          discriminant: prefix === undefined || prefix === '' ? undefined : prefix,
        });
      }
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
