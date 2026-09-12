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
  /**
   * Modules the walk listed and the read could not open.
   *
   * A directory walk followed by per-file reads is time-of-check to
   * time-of-use by construction, and this census runs in a vitest project whose
   * members deliberately create and delete files under the live `src/` to prove
   * that gates reach it (`tests/scripts/check-module-intent.test.ts` writes
   * `src/dr9-root-src-probe.ts` and removes it again). A module that existed at
   * walk time and is gone at read time was never TRACKED, so it is not part of
   * the population this census is about — but it is counted rather than
   * discarded, because "one file vanished under a sibling test" and "the tree
   * is disappearing" are different facts and a silent skip cannot tell them
   * apart.
   */
  readonly vanishedModuleCount: number;
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

/** One census's resolution state: parsed modules and settled answers. */
interface Resolution {
  /** Every module parsed so far, by path: a barrel is read once however many callers import through it. */
  readonly parsed: Map<string, ts.SourceFile>;
  /** Settled answers, keyed `<module>::<name>`. Only a COMPLETE search is recorded here. */
  readonly memo: Map<string, boolean>;
}

function parsedModule(modulePath: string, resolution: Resolution): ts.SourceFile {
  const known = resolution.parsed.get(modulePath);
  if (known !== undefined) return known;
  const sourceFile = parseOrThrow(readFileSync(modulePath, 'utf8'), modulePath);
  resolution.parsed.set(modulePath, sourceFile);
  return sourceFile;
}

/**
 * Whether importing `importedName` from `modulePath` binds the store class.
 * Follows every re-export shape a barrel can take — `export { X } from`,
 * `export * from`, and `import { X }` followed by a local `export { X }` — so
 * a barrel is a door to the same class, not a different name.
 *
 * The search is exhaustive over the re-export graph and cut only by a
 * per-query visited set, so a `false` has walked every node reachable from
 * its start and is a true negative — which is what makes it safe to memoise.
 * A depth bound was the previous cycle guard; its answer depended on how much
 * depth was left when a node was first reached, and memoised, on which module
 * the walk happened to visit first.
 */
function bindsClass(
  sourceDir: string,
  modulePath: string,
  importedName: string,
  resolution: Resolution,
): boolean {
  const key = `${modulePath}::${importedName}`;
  const known = resolution.memo.get(key);
  if (known !== undefined) return known;
  const answer = reachesClass(sourceDir, modulePath, importedName, resolution, new Set());
  resolution.memo.set(key, answer);
  return answer;
}

function reachesClass(
  sourceDir: string,
  modulePath: string,
  name: string,
  resolution: Resolution,
  visited: Set<string>,
): boolean {
  const key = `${modulePath}::${name}`;
  const known = resolution.memo.get(key);
  if (known !== undefined) return known;
  if (visited.has(key)) return false;
  visited.add(key);

  const relative = path.relative(sourceDir, modulePath).split(path.sep).join('/');
  if (relative === CLASS_MODULE) return name === CLASS_NAME;

  const sourceFile = parsedModule(modulePath, resolution);
  const follow = (target: string, upstream: string): boolean =>
    reachesClass(sourceDir, target, upstream, resolution, visited);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined) {
      // `export { X }` / `export { X as Y }` with no source: X is bound in
      // this module, and the binding this census follows is an import.
      if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.name.text !== name) continue;
        const local = (element.propertyName ?? element.name).text;
        const imported = importBindingOf(sourceFile, modulePath, local);
        if (imported !== undefined && follow(imported.target, imported.name)) return true;
      }
      continue;
    }
    if (!ts.isStringLiteral(specifier)) continue;
    const target = resolveSpecifier(modulePath, specifier.text);
    if (target === undefined) continue;
    if (statement.exportClause === undefined) {
      // `export * from '...'` — the name passes through unchanged.
      if (follow(target, name)) return true;
      continue;
    }
    // `export * as ns from '...'` binds a NAMESPACE OBJECT under `ns`, never
    // the class itself, so it is not an answer to this question. It is still a
    // door — `new ns.ContentAddressedStore()` through a named import of `ns` —
    // and `namespaceExportTarget` below is the query that follows it.
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.isTypeOnly || element.name.text !== name) continue;
      if (follow(target, (element.propertyName ?? element.name).text)) return true;
    }
  }
  return false;
}

/**
 * The module whose namespace is exported from `modulePath` under `name`, or
 * `undefined` if that export is not a namespace.
 *
 * `export * as store from './content-addressed-store.js'` re-exports a
 * namespace, so an importer writing `import { store }` and then
 * `new store.ContentAddressedStore(root)` reaches the class without ever
 * binding it by name. Followed through the same pass-through and rename
 * shapes as the class query, and cut by a per-query visited set.
 */
function namespaceExportTarget(
  modulePath: string,
  name: string,
  resolution: Resolution,
  visited: Set<string>,
): string | undefined {
  const key = `${modulePath}::${name}`;
  if (visited.has(key)) return undefined;
  visited.add(key);

  const sourceFile = parsedModule(modulePath, resolution);
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    const target = resolveSpecifier(modulePath, specifier.text);
    if (target === undefined) continue;
    const clause = statement.exportClause;
    if (clause === undefined) {
      // `export * from '...'` — the name passes through unchanged.
      const found = namespaceExportTarget(target, name, resolution, visited);
      if (found !== undefined) return found;
      continue;
    }
    if (ts.isNamespaceExport(clause)) {
      if (clause.name.text === name) return target;
      continue;
    }
    if (!ts.isNamedExports(clause)) continue;
    for (const element of clause.elements) {
      if (element.isTypeOnly || element.name.text !== name) continue;
      const upstream = (element.propertyName ?? element.name).text;
      const found = namespaceExportTarget(target, upstream, resolution, visited);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The value import that binds `local` in `sourceFile`: its resolved module and the name taken from it. */
function importBindingOf(
  sourceFile: ts.SourceFile,
  modulePath: string,
  local: string,
): { readonly target: string; readonly name: string } | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (clause === undefined || clause.isTypeOnly) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = clause.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if (element.isTypeOnly || element.name.text !== local) continue;
      const target = resolveSpecifier(modulePath, statement.moduleSpecifier.text);
      return target === undefined ? undefined : { target, name: (element.propertyName ?? element.name).text };
    }
  }
  return undefined;
}

interface ClassBindings {
  /** Local names that ARE the class (`import { ContentAddressedStore as X }`). */
  readonly direct: ReadonlySet<string>;
  /**
   * Local namespace names, each mapped to the module whose namespace it is.
   *
   * The MEMBER is resolved at the use site rather than here: the class can be
   * re-exported from that module under any name, so `<ns>.ContentAddressedStore`
   * is one door among many and `<ns>.Store` is the same door under an alias.
   * Asking per member is also what lets this hold a namespace whose module
   * turns out to export the class under no name at all — it simply answers no.
   */
  readonly namespaces: ReadonlyMap<string, string>;
}

function collectClassBindings(
  sourceDir: string,
  filePath: string,
  sourceFile: ts.SourceFile,
  resolution: Resolution,
): ClassBindings {
  const direct = new Set<string>();
  const namespaces = new Map<string, string>();
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
      namespaces.set(bindings.name.text, target);
      continue;
    }
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const imported = (element.propertyName ?? element.name).text;
      if (bindsClass(sourceDir, target, imported, resolution)) {
        direct.add(element.name.text);
        continue;
      }
      // Not the class under this name — but it may be a namespace the target
      // re-exported, and the class may sit inside it.
      const namespaceModule = namespaceExportTarget(target, imported, resolution, new Set());
      if (namespaceModule !== undefined) namespaces.set(element.name.text, namespaceModule);
    }
  }
  return { direct, namespaces };
}

/** Whether `node` is the class, through a direct binding or a namespace member. */
function isClassExpression(
  node: ts.Node,
  bindings: ClassBindings,
  sourceDir: string,
  resolution: Resolution,
): boolean {
  if (ts.isIdentifier(node)) return bindings.direct.has(node.text);
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const namespaceModule = bindings.namespaces.get(node.expression.text);
    if (namespaceModule === undefined) return false;
    return bindsClass(sourceDir, namespaceModule, node.name.text, resolution);
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

  const resolution: Resolution = { parsed: new Map(), memo: new Map() };
  const owners = new Set(options.owners);
  const sites: EvidenceStoreConstructionSite[] = [];

  // Every module is parsed. A text test on the class name or its directory
  // was tried as a prefilter and is unsound: a barrel that re-exports the
  // class under an alias leaves a caller spelling neither, and the census
  // would have skipped exactly the door it exists to find.
  let vanishedModuleCount = 0;
  for (const modulePath of modules) {
    // ENOENT is tolerated HERE and nowhere else. At this level the path came
    // from the walk, so a missing file means it was removed since; through
    // `collectClassBindings` the path came from an import, and a missing import
    // target is a real finding that must still throw.
    let sourceFile: ts.SourceFile;
    try {
      sourceFile = parsedModule(modulePath, resolution);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        vanishedModuleCount += 1;
        continue;
      }
      throw error;
    }
    const source = sourceFile.text;
    const bindings = collectClassBindings(options.sourceDir, modulePath, sourceFile, resolution);
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
      if (
        ts.isNewExpression(node) &&
        isClassExpression(node.expression, bindings, options.sourceDir, resolution)
      ) {
        record(node, 'construct');
        // The class expression inside is this same use; do not report it twice.
        node.arguments?.forEach(visit);
        return;
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        isClassExpression(node, bindings, options.sourceDir, resolution)
      ) {
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
  return { scannedModuleCount: modules.length - vanishedModuleCount, vanishedModuleCount, sites, unowned };
}
