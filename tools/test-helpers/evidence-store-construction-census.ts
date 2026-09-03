// ─── Every value-level use of the evidence ContentAddressedStore class ─────
//
// A `ContentAddressedStore` reference carries a digest and no root. That means
// a producer and a reader that construct the store over two different roots
// are, from the reference's point of view, indistinguishable from a producer
// whose blob was never written at all — exactly the split the gate-evidence
// producers used to disagree on before this pass gave them one shared
// constructor (`evidenceArtifactStore`, in `src/workflow/admission/
// evidence-artifact.ts`).
//
// This walks a source tree with the TypeScript parser and reports every module
// that binds the class as a VALUE and uses that binding — a `new`, a subclass,
// a class handed somewhere as an argument — so a second door to a store
// introduced later is named rather than silently re-splitting the root.
//
// Why a parser and not a line pattern: a pattern over lines cannot see an
// aliased import (`import { ContentAddressedStore as Store }` followed by
// `new Store(`), a constructor split across lines, or the difference between
// code and the same text inside a string. The binding is resolved through the
// import graph — the class module itself and any barrel that re-exports it —
// so what is reported is what the compiler would bind, not what the text
// looks like. Type-only imports and type positions are not uses: they cannot
// construct anything.
//
// `typescript` is a devDependency; this module lives under tools/ and is
// imported by tests only, never by shipped src/.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The module that declares the class, `sourceDir`-relative, forward-slashed. */
const CLASS_MODULE = 'storage/artifacts/content-addressed-store.ts';
const CLASS_NAME = 'ContentAddressedStore';
/** How many re-export hops a binding may be followed through before giving up. */
const MAX_REEXPORT_DEPTH = 4;

export type EvidenceStoreUseKind =
  /** `new <binding>(...)` — a direct construction. */
  | 'construct'
  /** Any other value use of the binding: `extends`, an argument, a call. */
  | 'reference';

export interface EvidenceStoreConstructionSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly kind: EvidenceStoreUseKind;
}

export interface EvidenceStoreConstructionCensus {
  readonly scannedModuleCount: number;
  readonly sites: readonly EvidenceStoreConstructionSite[];
  readonly unowned: readonly EvidenceStoreConstructionSite[];
}

function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parse one module, refusing a RECOVERED parse. `ts.createSourceFile` never
 * throws; handed broken input it returns a partial tree with nodes silently
 * missing, and a construction that vanished from the tree reads as a module
 * that constructs nothing — the direction this census must not fail in.
 */
function parseOrThrow(source: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  const diagnostics: readonly ts.Diagnostic[] = isDiagnosticArray(raw) ? raw : [];
  const first = diagnostics[0];
  if (first !== undefined) {
    const detail = ts.flattenDiagnosticMessageText(first.messageText, ' ');
    throw new Error(
      `evidence-store-construction-census: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} syntax error(s); first: ${detail}). Refusing to report a census ` +
        `derived from a recovered parse, which would under-report constructions.`,
    );
  }
  return sourceFile;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
}

/**
 * Turn a relative module specifier into the `.ts` file it names, or
 * `undefined` for a bare (package) specifier or a target that does not exist.
 * NodeNext specifiers name `.js`; the source on disk is `.ts`.
 */
function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    path.join(base, 'index.ts'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Whether importing `importedName` from `modulePath` binds the store class.
 * Follows `export { X } from '...'` and `export * from '...'` re-exports so a
 * barrel is a door to the same class, not a different name. Bounded and
 * memoised: the import graph is finite, but a cycle of barrels is not.
 */
function bindsClass(
  sourceDir: string,
  modulePath: string,
  importedName: string,
  memo: Map<string, boolean>,
  depth: number,
): boolean {
  const key = `${modulePath}::${importedName}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  memo.set(key, false);

  const relative = path.relative(sourceDir, modulePath).split(path.sep).join('/');
  if (relative === CLASS_MODULE) {
    const answer = importedName === CLASS_NAME;
    memo.set(key, answer);
    return answer;
  }
  if (depth <= 0) return false;

  const sourceFile = parseOrThrow(readFileSync(modulePath, 'utf8'), modulePath);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const target = resolveSpecifier(modulePath, specifier.text);
    if (target === undefined) continue;
    if (statement.exportClause === undefined) {
      // `export * from '...'` — the name passes through unchanged.
      if (bindsClass(sourceDir, target, importedName, memo, depth - 1)) {
        memo.set(key, true);
        return true;
      }
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly || element.name.text !== importedName) continue;
      const upstream = (element.propertyName ?? element.name).text;
      if (bindsClass(sourceDir, target, upstream, memo, depth - 1)) {
        memo.set(key, true);
        return true;
      }
    }
  }
  return false;
}

interface ClassBindings {
  /** Local names that ARE the class (`import { ContentAddressedStore as X }`). */
  readonly direct: ReadonlySet<string>;
  /** Local namespace names through which `<ns>.ContentAddressedStore` is the class. */
  readonly namespaces: ReadonlySet<string>;
}

function collectClassBindings(
  sourceDir: string,
  filePath: string,
  sourceFile: ts.SourceFile,
  memo: Map<string, boolean>,
): ClassBindings {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const target = resolveSpecifier(filePath, statement.moduleSpecifier.text);
    if (target === undefined) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (bindsClass(sourceDir, target, CLASS_NAME, memo, MAX_REEXPORT_DEPTH)) {
        namespaces.add(bindings.name.text);
      }
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (bindsClass(sourceDir, target, imported, memo, MAX_REEXPORT_DEPTH)) {
        direct.add(element.name.text);
      }
    }
  }
  return { direct, namespaces };
}

/** Whether `node` is the class, through a direct binding or a namespace member. */
function isClassExpression(node: ts.Node, bindings: ClassBindings): boolean {
  if (ts.isIdentifier(node)) return bindings.direct.has(node.text);
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.name.text === CLASS_NAME
  ) {
    return bindings.namespaces.has(node.expression.text);
  }
  return false;
}

/**
 * An identifier that is the NAME of something rather than a reference to the
 * binding: a property key, a member name, a declaration name, an import or
 * export specifier. None of these can construct a store.
 */
function isNamePosition(node: ts.Identifier): boolean {
  const parent: ts.Node | undefined = node.parent;
  if (parent === undefined) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isNamespaceImport(parent) || ts.isImportClause(parent)) return true;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

/**
 * Every value-level use of the store class under `sourceDir`, `root`-relative
 * and forward-slashed, plus the subset outside `owners`.
 *
 * A file path in `owners` is matched exactly against the reported `file`
 * field — the same `root`-relative, forward-slashed spelling this function
 * produces — so a caller states the allowlist the way the census reports
 * violations, with nothing to translate between the two.
 */
export function scanEvidenceStoreConstructions(
  root: string,
  options: { readonly sourceDir: string; readonly owners: readonly string[] },
): EvidenceStoreConstructionCensus {
  const modules: string[] = [];
  walk(options.sourceDir, modules);

  const memo = new Map<string, boolean>();
  const owners = new Set(options.owners);
  const sites: EvidenceStoreConstructionSite[] = [];

  for (const modulePath of modules) {
    const source = readFileSync(modulePath, 'utf8');
    // A module that never spells the class name or the class module's
    // directory cannot bind the class through any import chain this census
    // follows: a direct import names the class, and a namespace import names
    // a path whose chain ends in `storage/artifacts`. Skipping the rest keeps
    // a whole-tree parse off the test budget without changing the answer.
    if (!source.includes(CLASS_NAME) && !source.includes('storage/artifacts')) continue;

    const sourceFile = parseOrThrow(source, modulePath);
    const bindings = collectClassBindings(options.sourceDir, modulePath, sourceFile, memo);
    if (bindings.direct.size === 0 && bindings.namespaces.size === 0) continue;

    const relFile = path.relative(root, modulePath).split(path.sep).join('/');
    const lines = source.split('\n');
    const record = (node: ts.Node, kind: EvidenceStoreUseKind): void => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      sites.push({ file: relFile, line: line + 1, text: (lines[line] ?? '').trim(), kind });
    };

    const visit = (node: ts.Node): void => {
      // `class X extends <binding>` is a value use — the subclass is a second
      // constructor for the same store — but the parser files the heritage
      // expression under the type nodes. Look through it before the type
      // guard below; an interface's `extends` and a class's `implements` stay
      // type positions.
      if (ts.isExpressionWithTypeArguments(node)) {
        const clause: ts.Node | undefined = node.parent;
        if (
          clause !== undefined &&
          ts.isHeritageClause(clause) &&
          clause.token === ts.SyntaxKind.ExtendsKeyword &&
          ts.isClassLike(clause.parent)
        ) {
          visit(node.expression);
        }
        return;
      }
      // A type position never constructs anything; the import statements
      // are the bindings themselves, not uses of them.
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
      if (ts.isNewExpression(node) && isClassExpression(node.expression, bindings)) {
        record(node, 'construct');
        // The class expression inside is this same use; do not report it twice.
        node.arguments?.forEach(visit);
        return;
      }
      if (ts.isPropertyAccessExpression(node) && isClassExpression(node, bindings)) {
        record(node, 'reference');
        return;
      }
      if (ts.isIdentifier(node) && bindings.direct.has(node.text) && !isNamePosition(node)) {
        record(node, 'reference');
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const unowned = sites.filter((site) => !owners.has(site.file));
  return { scannedModuleCount: modules.length, sites, unowned };
}
