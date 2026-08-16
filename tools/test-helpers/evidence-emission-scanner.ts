// ─── The real append-site resolver behind the evidence-ownership census ──────
//
// `orchestrate/gate-ownership-census.ts` decides WHO may produce admission
// evidence. It does not, and must not, decide what a piece of TypeScript MEANS —
// whether `type: X.Y` names the evidence discriminant is a question about
// bindings, and the only instrument that cannot disagree with the compiler about
// bindings is the compiler.
//
// ── Why this module is HERE and not next to the policy it serves ─────────────
// Identical reasoning to `test-helpers/module-lexer.ts`, and the same measured
// result: `typescript` is a devDependency, so a shipped `src/` module importing
// it makes the compiler a runtime dependency of a tree whose shipped artifact
// resolves only `dependencies` — and the effect ledger enforces exactly that
// against itself. `test-helpers/` is skipped by the ledger's own scan while
// still inside `tsconfig.json`'s `include`, so this parser is typechecked under
// the package's strict settings.
//
// ── Why resolve rather than match ───────────────────────────────────────────
// The superseded detector matched a RAW STRING LITERAL — `type:
// 'admission.evidence-recorded'` — inside a balanced `.append(...)`. Every other
// admission consumer in this package writes the discriminant as
// `ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED`, so an alternate emitter written the
// way the codebase writes emitters resolved to the same event and produced no
// diagnostic at all. A detector that only catches the spelling it already knew is
// worth nothing; this one answers the question the census is actually asking.
//
// Four forms reduce to one answer here:
//   • `type: 'admission.evidence-recorded'`         — a literal;
//   • `type: ADMISSION_EVENT_TYPES.EVIDENCE_RECORDED` — an exported constant;
//   • `import { ADMISSION_EVENT_TYPES as T }` + `type: T.EVIDENCE_RECORDED`;
//   • `const event = { type: … }` hoisted above `store.append(id, event)`.
// A `type:` that reduces to none of these is reported UNRESOLVED rather than
// silently treated as "not evidence" — under-reporting is the dangerous
// direction for an ownership census.

import ts from 'typescript';
import type {
  EvidenceAppendSite,
  EvidenceEmissionScanner,
  EvidenceScanOptions,
} from '../orchestrate/gate-ownership-census.js';

/**
 * `parseDiagnostics` is off the public `ts.SourceFile` surface but is the only
 * way to tell a CLEAN parse from a RECOVERED one. A narrowing predicate rather
 * than an `as`, because the cast ratchet scans this directory.
 */
function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse.
 *
 * `ts.createSourceFile` never throws: handed broken input it returns a partial
 * tree with nodes silently missing. An emitter whose append call vanished reads
 * as a clean module and passes the census, so a recovered parse is fatal here
 * rather than quietly averaged in.
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
 * Local name → the name it was imported under, for every named import in the
 * file. `import { A as B }` records `B → A`, so an aliased constant table still
 * resolves against the canonical dotted paths the census supplies.
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
 * only make an append site MORE resolvable, and a same-named shadow that
 * resolved to a different discriminant would surface as an emitter to examine —
 * the fail-loud direction. A scope-accurate table would need the checker, which
 * this port is explicitly not.
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
    // A table declared in this same file (`const T = { X: 'v' } as const`).
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

  // A plain identifier bound to a literal (or to another identifier that is).
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
 * The initializer of `name` on an object literal, following one spread level.
 *
 * The spread half was documented but never implemented, so
 * `store.append(id, { ...baseEvent, data })` read as a module that appends
 * nothing — an ordinary spelling, and an emitter invisible to the census.
 *
 * Precedence is source order, the way JS evaluates it: the LAST writer of
 * `name` wins, own property or spread alike. Returning on the first own hit
 * read `{ type: 'old', ...{ type: 'new' } }` as `'old'` — a confident wrong
 * answer, which for this census is worse than no answer.
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
      // ONE level: a spread of a spread is not followed.
      const spreadObject = ctx === undefined ? undefined : asEventObject(property.expression, ctx);
      if (spreadObject === undefined) {
        // An unreadable spread sits AFTER whatever is held, so it may or may
        // not overwrite it — and there is no way to tell from here. Poison the
        // candidate rather than let a superseded value win: `discriminant:
        // undefined` is the unresolved marker, and under-reporting a rogue
        // emitter is the direction this census refuses to fail in.
        candidate = undefined;
        continue;
      }
      // A spread that does not mention `name` leaves the standing value alone.
      const inner = lastOwnProperty(spreadObject, name);
      if (inner !== undefined) candidate = inner;
    }
  }
  return candidate;
}

/**
 * The object literal an `.append(...)` argument denotes: written inline, or
 * hoisted into a `const` above the call — the shape the census's own runner
 * would take if a rogue emitter were factored the way production code is.
 */
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
 * Every `.append(...)` call site with its event discriminant resolved.
 *
 * Only `.append` is inspected, so a `.query(streamId, { type: … })` READ filter
 * is excluded by construction rather than by a second regex; and only the `type`
 * property counts, so a metadata surface keyed `event:` is likewise not an
 * emission.
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
      // An `.append(…)` whose event argument cannot be read is UNRESOLVED, not
      // absent. Skipping it dropped the site entirely, so
      // `store.append(id, buildEvent(record))` — a call that certainly appends —
      // read as a module that appends nothing. Under-reporting is the dangerous
      // direction for this census, which is the line the module header draws;
      // the loop was not holding it. `discriminant: undefined` IS the unresolved
      // marker the consumer already understands.
      //
      // Only the event argument (the second) can carry a `type`; the stream id
      // is a string. Reporting one site per call keeps a single append from
      // appearing twice.
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
