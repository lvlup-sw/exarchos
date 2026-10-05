// Resolves the event discriminant of each `.append(...)` call for the evidence-ownership census.
// `src/verbs/gates/gate-ownership-census.ts` decides who can produce admission evidence.
// This module reads the TypeScript with the compiler parser to decide which event each call appends.
//
// The module is under `tools/` because `typescript` is a devDependency. A shipped `src/` module that
// imports it makes the compiler a runtime dependency. `tests/tsconfig.json` includes this directory.
//
// Four forms of `type:` resolve to one answer. They are a string literal, an exported constant
// (`ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`), that constant through an import alias, and an event
// object in a variable above `store.append(id, event)`. A `type:` that does not resolve is reported
// as unresolved, not as "not evidence", because under-reporting is the dangerous direction.

import ts from 'typescript';
import type {
  EvidenceAppendSite,
  EvidenceEmissionScanner,
  EvidenceScanOptions,
} from '../../src/verbs/gates/gate-ownership-census.js';

/**
 * Narrows `parseDiagnostics`, which is not on the public `ts.SourceFile` type.
 * It is a predicate, not an `as` cast, because the cast ratchet scans this directory.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parses one module and throws on a recovered parse.
 * On broken input, `ts.createSourceFile` returns a partial tree, and a missing append call then passes the census.
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
      `evidence-emission-scanner: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to report ` +
        `an ownership answer derived from a recovered parse, which would silently ` +
        `under-report emitters and read as a module that appends nothing.`,
    );
  }
  return sourceFile;
}

/** Strip `as const`, `satisfies T`, `<T>x` and parentheses to the value beneath. */
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
 * Maps the local name of each named import to its imported name.
 * `import { A as B }` records `B → A`, so an aliased constant table resolves against the dotted paths of the census.
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
 * Maps each variable name in the file, at any depth, to its first initializer.
 * The table is flat, not scope-accurate. A flat table can only make a site more resolvable,
 * and a shadowed name with a different discriminant shows as an emitter to examine.
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
 * Returns the string an expression evaluates to, or `undefined` when it cannot decide.
 * It reads literals, identifiers bound to literals, and `TABLE.MEMBER` of a known or same-file constant table.
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
        const member = findProperty(object, expr.name.text, ctx);
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

/**
 * The last own-property initializer for `name`, ignoring spreads.
 */
function lastOwnProperty(
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
 * Returns the initializer of `name` on an object literal, and follows one level of spread.
 * The last writer of `name` in source order wins, as in JavaScript.
 * A spread that cannot be read clears the candidate, because it can overwrite the earlier value.
 */
function findProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  ctx?: ResolutionContext,
): ts.Expression | undefined {
  let candidate: ts.Expression | undefined;
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name
    ) {
      candidate = property.initializer;
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      candidate = property.name;
      continue;
    }
    if (ts.isSpreadAssignment(property)) {
      const spreadObject = ctx === undefined ? undefined : asEventObject(property.expression, ctx);
      if (spreadObject === undefined) {
        candidate = undefined;
        continue;
      }
      const inner = lastOwnProperty(spreadObject, name);
      if (inner !== undefined) candidate = inner;
    }
  }
  return candidate;
}

/** Returns the object literal that an `.append(...)` argument denotes: inline, or in a variable above the call. */
function asEventObject(
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
 * Returns each `.append(...)` call site with its event discriminant resolved.
 * Only `.append` and only the `type` property count, so a `.query` filter or an `event:` key is not an emission.
 * The event argument is the second argument, or the first when the call has one argument.
 * An event argument that cannot be read gives `discriminant: undefined`, the unresolved marker.
 */
export const scanEvidenceEmission: EvidenceEmissionScanner = (
  source: string,
  options: EvidenceScanOptions,
): readonly EvidenceAppendSite[] => {
  const fileName = options.fileName ?? 'module.ts';
  const sourceFile = parseOrThrow(source, fileName);
  const ctx: ResolutionContext = {
    aliases: collectImportAliases(sourceFile),
    bindings: collectConstBindings(sourceFile),
    knownConstants: options.knownConstants,
  };

  const sites: EvidenceAppendSite[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'append'
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const eventArgument = node.arguments[1] ?? node.arguments[0];
      if (eventArgument !== undefined) {
        const object = asEventObject(eventArgument, ctx);
        const typeProperty =
          object === undefined ? undefined : findProperty(object, 'type', ctx);
        sites.push({
          line,
          discriminant: typeProperty === undefined ? undefined : resolveString(typeProperty, ctx),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return sites;
};
