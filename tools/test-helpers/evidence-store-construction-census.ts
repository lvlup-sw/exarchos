/**
 * A census of every value-level use of the evidence `ContentAddressedStore` class. A store
 * reference carries a digest and no root. A producer and a reader that build the store over two
 * roots then look the same as a producer that never wrote the blob. The gate-evidence producers
 * share one constructor, `evidenceArtifactStore` in `src/workflow/admission/evidence-artifact.ts`.
 *
 * The census walks a source tree with the TypeScript parser. It reports each module that binds the
 * class as a value and uses the binding: a `new`, a subclass, or the class as an argument. It
 * resolves aliased imports and barrel re-exports, so it reports what the compiler binds. Type-only
 * imports and type positions construct nothing, so they do not count. Tests import this module,
 * and shipped `src/` code does not.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** The module that declares the class, `sourceDir`-relative, forward-slashed. */
const CLASS_MODULE = 'storage/artifacts/content-addressed-store.ts';
const CLASS_NAME = 'ContentAddressedStore';

/**
 * The kind of a use: `construct` for a direct `new <binding>(...)`, and `reference` for any other
 * value use, such as `extends`, an argument or a call.
 */
export type EvidenceStoreUseKind =
  | 'construct'
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
   * Modules that the walk listed and the read did not find. A walk followed by per-file reads is a
   * time-of-check to time-of-use race, and sibling tests create and delete files under the live
   * `src/`. The census counts a vanished module and does not skip it silently. Thus "one file
   * vanished" and "the tree is disappearing" stay different facts.
   */
  readonly vanishedModuleCount: number;
  readonly sites: readonly EvidenceStoreConstructionSite[];
  readonly unowned: readonly EvidenceStoreConstructionSite[];
}

function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

/**
 * Parses one module and refuses a recovered parse. `ts.createSourceFile` never throws: on broken
 * input it returns a partial tree with missing nodes. A lost construction reads as a module that
 * constructs nothing, which is the unsafe direction. The parse sets parent nodes, because
 * `isNamePosition` reads `node.parent`.
 */
function parseOrThrow(source: string, fileName: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
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
 * Turns a relative module specifier into the `.ts` file that it names. It returns `undefined` for a
 * bare package specifier or a missing target. NodeNext specifiers name `.js`, and the source on disk
 * is `.ts`.
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
 * Tells if an import of `importedName` from `modulePath` binds the store class. It follows each
 * barrel re-export shape: `export { X } from`, `export * from`, and `import { X }` with a local
 * `export { X }`. The search covers the whole re-export graph, with a visited set per query to stop
 * cycles. Thus a `false` is a true negative, and the memo can record it.
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

/**
 * The search behind {@link bindsClass}. An `export { X }` with no source follows the import that
 * binds `X` locally. An `export * from` passes the name through. An `export * as ns from` binds a
 * namespace object, not the class, so {@link namespaceExportTarget} follows it instead.
 */
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
      if (follow(target, name)) return true;
      continue;
    }
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
   * Local namespace names, each mapped to the module whose namespace it is. The member resolves at
   * the use site, because the module can re-export the class under any name. A namespace whose
   * module does not export the class gives no match.
   */
  readonly namespaces: ReadonlyMap<string, string>;
}

/**
 * Collects the local names in `sourceFile` that bind the class directly or through a namespace. A
 * named import that is not the class can still be a re-exported namespace that holds the class.
 */
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
 * True for an identifier that names something and does not reference the binding. Such a name is a
 * property key, a member name, a declaration name, or an import or export specifier. None of these
 * can build a store.
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
 * Every value-level use of the store class under `sourceDir`, `root`-relative and forward-slashed,
 * plus the subset outside `owners`. An `owners` path matches the reported `file` field exactly.
 *
 * Every module is parsed, because a barrel alias leaves a caller that spells neither the class name
 * nor its directory. A file from the walk that is missing at read time counts as vanished, but a
 * missing import target still throws. A class `extends` is a value use. An interface `extends` and
 * an `implements` are type positions. A `new` reports one use, not a second use for its class.
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

  let vanishedModuleCount = 0;
  for (const modulePath of modules) {
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
      if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
      if (
        ts.isNewExpression(node) &&
        isClassExpression(node.expression, bindings, options.sourceDir, resolution)
      ) {
        record(node, 'construct');
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
