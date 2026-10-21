// Finds test code whose verdict depends on how fast the runner is (#2029).
//
// Two shapes are found. A synchronous spawn blocks the vitest worker's event
// loop, so a slow host can expire the worker's 60 s RPC timer. An assertion on
// elapsed wall-clock time measures the runner, not the code. Both scans parse
// the source with the TypeScript compiler, so text inside a string, a template
// or a comment is never a finding.
import { posix } from 'node:path';

import ts from 'typescript';

/** One finding: the 1-based line and what was found there. */
export interface RunnerDependence {
  readonly line: number;
  readonly detail: string;
  /** For a sync spawn: the `timeout` option, when it is a number the source states. */
  readonly timeoutMs?: number;
}

/** The synchronous spawn APIs of `node:child_process`. */
export const CHILD_PROCESS_SYNC_APIS: ReadonlySet<string> = new Set(['execFileSync', 'execSync', 'spawnSync']);

/**
 * The exported synchronous spawn wrappers of a source tree, by module key.
 * A module key is the repository-relative path of a module without its extension.
 * {@link deriveSyncSpawnWrappers} derives the map from the source, so a new exported wrapper needs no edit here.
 */
export type SyncSpawnWrappers = ReadonlyMap<string, ReadonlySet<string>>;

/** One module that the derivation reads: its repository-relative path, with forward slashes, and its text. */
export interface SourceModule {
  readonly path: string;
  readonly source: string;
}

/** The module key of `node:child_process`, for both of its specifiers. */
const CHILD_PROCESS_KEY = 'node:child_process';
const CHILD_PROCESS_SPECIFIERS: ReadonlySet<string> = new Set(['node:child_process', 'child_process']);
const SPAWN_HELPER_SPECIFIER = /(^|\/)test-helpers\/spawn(\.[cm]?[jt]s)?$/;
const UPPER_BOUND_MATCHERS: ReadonlySet<string> = new Set(['toBeLessThan', 'toBeLessThanOrEqual']);
const DURATION_PROPERTY = /^(duration|elapsed)(ms|_ms|millis|seconds)?$|(duration|elapsed)(ms|_ms)$/i;

/** The extension of a source module, with the `.d` of a declaration file. */
const SOURCE_EXTENSION = /(\.d)?\.[cm]?[jt]sx?$/;

/** Parses one file as TypeScript, or as JavaScript for a `.js`-family name. */
function parse(source: string, fileName: string): ts.SourceFile {
  const kind = /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
}

/** Visits every node below `root`, depth first. */
function walk(root: ts.Node, visit: (node: ts.Node) => void): void {
  const step = (node: ts.Node): void => {
    visit(node);
    ts.forEachChild(node, step);
  };
  step(root);
}

/** The 1-based line of a node. */
function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/** The string text of a module specifier node, when it is a plain literal. */
function specifierText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
}

/** The module key of a repository-relative path: the path without its extension. */
function moduleKeyOf(path: string): string {
  return path.replace(SOURCE_EXTENSION, '');
}

/**
 * The key of the module that `specifier` names from the file `fromFile`.
 * A relative specifier resolves against the directory of the file. A package other than `node:child_process` has no key.
 */
function resolveModuleKey(specifier: string | undefined, fromFile: string): string | undefined {
  if (specifier === undefined) return undefined;
  if (CHILD_PROCESS_SPECIFIERS.has(specifier)) return CHILD_PROCESS_KEY;
  if (!specifier.startsWith('.')) return undefined;
  return moduleKeyOf(posix.normalize(posix.join(posix.dirname(fromFile), specifier)));
}

/** Whether the export `name` of the module `key` runs a synchronous spawn. A directory key also reads its `index` module. */
function isSyncApi(key: string, name: string, wrappers: SyncSpawnWrappers): boolean {
  if (key === CHILD_PROCESS_KEY) return CHILD_PROCESS_SYNC_APIS.has(name);
  return (wrappers.get(key) ?? wrappers.get(`${key}/index`))?.has(name) === true;
}

/** Removes parentheses, `await`, type assertions and non-null marks around an expression. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current) || ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
    else return current;
  }
}

/** The module a dynamic `import()`, `require()` or `vi.importActual()` names, if any. */
function dynamicModuleOf(node: ts.Expression): string | undefined {
  const call = unwrap(node);
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
  const isImportActual =
    ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'vi' && callee.name.text === 'importActual';
  return isImport || isRequire || isImportActual ? specifierText(call.arguments[0]) : undefined;
}

/** One name that an import binds: the key of its module and the name that the module exports. */
interface ImportedName {
  readonly from: string;
  readonly name: string;
}

/** The import bindings of one file: the names it imports, its namespaces, and its local names of `isolatedSync`. */
interface ImportBindings {
  readonly named: Map<string, ImportedName>;
  readonly namespaces: Map<string, string>;
  readonly isolators: Set<string>;
}

/** Collects the static and dynamic import bindings of a file. A type-only import binds nothing. */
function importBindingsOf(file: ts.SourceFile): ImportBindings {
  const bindings: ImportBindings = { named: new Map(), namespaces: new Map(), isolators: new Set() };
  walk(file, (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      const specifier = specifierText(node.moduleSpecifier);
      const from = resolveModuleKey(specifier, file.fileName);
      const named = clause.namedBindings;
      if (from === CHILD_PROCESS_KEY && clause.name !== undefined) bindings.namespaces.set(clause.name.text, from);
      else if (from !== undefined && clause.name !== undefined) bindings.named.set(clause.name.text, { from, name: 'default' });
      if (from !== undefined && named !== undefined && ts.isNamespaceImport(named)) {
        bindings.namespaces.set(named.name.text, from);
      }
      if (named === undefined || !ts.isNamedImports(named)) return;
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (from !== undefined) bindings.named.set(element.name.text, { from, name: imported });
        if (specifier !== undefined && SPAWN_HELPER_SPECIFIER.test(specifier) && imported === 'isolatedSync') {
          bindings.isolators.add(element.name.text);
        }
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const from = resolveModuleKey(dynamicModuleOf(node.initializer), file.fileName);
      if (from === undefined) return;
      if (ts.isIdentifier(node.name)) {
        bindings.namespaces.set(node.name.text, from);
        return;
      }
      if (!ts.isObjectBindingPattern(node.name)) return;
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(element.name)) continue;
        bindings.named.set(element.name.text, { from, name: key.text });
      }
    }
  });
  return bindings;
}

/**
 * The sync API that a call invokes, with the key of its module, or undefined when the call is not a sync spawn.
 * `localSync` holds the module-level functions of the same file that the derivation already found to spawn.
 */
function syncApiCalled(
  call: ts.CallExpression,
  bindings: ImportBindings,
  wrappers: SyncSpawnWrappers,
  localSync?: ReadonlySet<string>,
): ImportedName | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    if (localSync?.has(callee.text) === true) return { from: call.getSourceFile().fileName, name: callee.text };
    const imported = bindings.named.get(callee.text);
    if (imported === undefined || !isSyncApi(imported.from, imported.name, wrappers)) return undefined;
    return imported.name === 'default' ? { from: imported.from, name: callee.text } : imported;
  }
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  const receiver = unwrap(callee.expression);
  const from = ts.isIdentifier(receiver)
    ? bindings.namespaces.get(receiver.text)
    : resolveModuleKey(dynamicModuleOf(receiver), call.getSourceFile().fileName);
  return from !== undefined && isSyncApi(from, name, wrappers) ? { from, name } : undefined;
}

/** Whether a call loads a real module: `import()`, `require()`, `vi.importActual()` or the `importOriginal` of a factory. */
function loadsAModule(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === 'require' || callee.text === 'importOriginal';
  return ts.isPropertyAccessExpression(callee) && (callee.name.text === 'importActual' || callee.name.text === 'importOriginal');
}

/** Whether a `vi.mock` factory replaces the whole module. No factory is an automock. A factory with a parameter or a module load keeps real parts. */
function replacesTheWholeModule(factory: ts.Expression | undefined): boolean {
  if (factory === undefined) return true;
  const value = unwrap(factory);
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return false;
  return value.parameters.length === 0 && !contains(value.body, loadsAModule);
}

/**
 * Whether a hoisted `vi.mock` replaces the whole of `node:child_process` in the file, and no `vi.unmock` undoes it.
 * Each wrapper in the module graph of the file then calls the mock, so a call of a wrapper starts no process.
 * A direct call of a sync API of `node:child_process` is still a finding.
 */
function mocksChildProcessWholly(file: ts.SourceFile): boolean {
  let mocked = false;
  let unmocked = false;
  walk(file, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    const callee = node.expression;
    if (!ts.isIdentifier(callee.expression) || callee.expression.text !== 'vi') return;
    if (!CHILD_PROCESS_SPECIFIERS.has(specifierText(node.arguments[0]) ?? '')) return;
    if (callee.name.text === 'unmock' || callee.name.text === 'doUnmock') unmocked = true;
    if (callee.name.text === 'mock' && replacesTheWholeModule(node.arguments[1])) mocked = true;
  });
  return mocked && !unmocked;
}

/** Whether the call is the whole body of an arrow passed first to `isolatedSync`. */
function isIsolated(call: ts.CallExpression, bindings: ImportBindings): boolean {
  const arrow = call.parent;
  if (!ts.isArrowFunction(arrow) || arrow.body !== call) return false;
  const outer = arrow.parent;
  return (
    ts.isCallExpression(outer) &&
    outer.arguments[0] === arrow &&
    ts.isIdentifier(outer.expression) &&
    bindings.isolators.has(outer.expression.text)
  );
}

/**
 * Every call in `source` that runs a synchronous spawn API: `execFileSync`,
 * `execSync` or `spawnSync` from `node:child_process`, or an exported wrapper in
 * `wrappers`. `fileName` is the repository-relative path of the file, so that a
 * relative import resolves to a module key. Aliased, namespaced and dynamically
 * imported bindings count. A call that is the whole body of an arrow passed to
 * `isolatedSync` does not. A call of a wrapper in a file that mocks the whole of
 * `node:child_process` does not.
 */
export function findSyncSpawnCalls(source: string, fileName: string, wrappers: SyncSpawnWrappers): RunnerDependence[] {
  const file = parse(source, fileName);
  const bindings = importBindingsOf(file);
  const constants = numericConstantsOf(file);
  const wrappersReachTheMock = mocksChildProcessWholly(file);
  const findings: RunnerDependence[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = syncApiCalled(node, bindings, wrappers);
    if (api === undefined || isIsolated(node, bindings)) return;
    if (wrappersReachTheMock && api.from !== CHILD_PROCESS_KEY) return;
    const timeoutMs = statedTimeout(node, constants);
    findings.push({ line: lineOf(file, node), detail: api.name, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  });
  return findings;
}

/** Whether a function is `async`. Its caller gets a promise, so it is not a synchronous wrapper. */
function isAsync(fn: ts.Node): boolean {
  return ts.canHaveModifiers(fn) && (ts.getModifiers(fn)?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ?? false);
}

/** Whether a nested function runs where the source states it: it is a synchronous argument or the callee of a call. */
function runsInPlace(fn: ts.Node): boolean {
  if (isAsync(fn)) return false;
  let child: ts.Node = fn;
  let parent = fn.parent;
  while (ts.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (!ts.isCallExpression(parent) && !ts.isNewExpression(parent)) return false;
  return parent.expression === child || (parent.arguments?.some((argument) => argument === child) ?? false);
}

/**
 * The calls that a function body runs when the function runs. A nested function counts only when it runs in place,
 * as a callback argument does. A function that the body returns or stores runs later, so its calls do not count.
 */
function callsRunBy(body: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const step = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isFunctionLike(node) && !runsInPlace(node)) return;
    ts.forEachChild(node, step);
  };
  step(body);
  return calls;
}

/** Whether a statement carries the modifier `kind`, such as `export` or `default`. */
function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false);
}

/** The module-level facts of one source module that the derivation reads. */
interface ModuleFacts {
  readonly key: string;
  readonly bindings: ImportBindings;
  /** The calls that each module-level function runs, by its local name. */
  readonly functions: ReadonlyMap<string, readonly ts.CallExpression[]>;
  /** Each exported name and the local name that it exports. */
  readonly exports: ReadonlyMap<string, string>;
  /** Each exported name that the module re-exports from another module. */
  readonly reexports: ReadonlyMap<string, ImportedName>;
  /** The keys of the modules whose every export the module re-exports. */
  readonly starExports: readonly string[];
}

/**
 * Reads the module-level functions, the exports and the re-exports of one module.
 * A function is a function declaration, or a variable whose value is an arrow or a function expression.
 * An `async` function is not read, because its caller awaits a promise and does not call a synchronous API.
 */
function moduleFactsOf(module: SourceModule): ModuleFacts {
  const file = parse(module.source, module.path);
  const functions = new Map<string, readonly ts.CallExpression[]>();
  const exports = new Map<string, string>();
  const reexports = new Map<string, ImportedName>();
  const starExports: string[] = [];
  for (const statement of file.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined && !isAsync(statement)) {
      const local = statement.name?.text ?? 'default';
      functions.set(local, callsRunBy(statement.body));
      if (exported) exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : local, local);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const value = unwrap(declaration.initializer);
        if ((!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) || isAsync(value)) continue;
        functions.set(declaration.name.text, callsRunBy(value.body));
        if (exported) exports.set(declaration.name.text, declaration.name.text);
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const from = resolveModuleKey(specifierText(statement.moduleSpecifier), module.path);
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (from !== undefined) starExports.push(from);
        continue;
      }
      if (!ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        if (element.isTypeOnly) continue;
        const local = (element.propertyName ?? element.name).text;
        if (from === undefined) exports.set(element.name.text, local);
        else reexports.set(element.name.text, { from, name: local });
      }
    } else if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      exports.set('default', statement.expression.text);
    }
  }
  return { key: moduleKeyOf(module.path), bindings: importBindingsOf(file), functions, exports, reexports, starExports };
}

/**
 * The exported synchronous spawn wrappers of `modules`, by module key.
 * A module-level function is a wrapper when its body runs a call of a sync spawn.
 * That call is a sync API of `node:child_process`, a wrapper that the module imports, or another wrapper of the module.
 * An export of such a function, a re-export of a wrapper and an `export *` of a module with wrappers each count.
 * The search repeats until it finds no new wrapper, so a wrapper of a wrapper counts too.
 */
export function deriveSyncSpawnWrappers(modules: readonly SourceModule[]): Map<string, Set<string>> {
  const facts = modules.map(moduleFactsOf);
  const localSync = facts.map(() => new Set<string>());
  const wrappers = new Map<string, Set<string>>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [index, module] of facts.entries()) {
      const sync = localSync[index] ?? new Set<string>();
      for (const [local, calls] of module.functions) {
        if (sync.has(local)) continue;
        if (!calls.some((call) => syncApiCalled(call, module.bindings, wrappers, sync) !== undefined)) continue;
        sync.add(local);
        grew = true;
      }
      const exported = new Set(wrappers.get(module.key));
      for (const [name, local] of module.exports) {
        const imported = module.bindings.named.get(local);
        if (sync.has(local) || (imported !== undefined && isSyncApi(imported.from, imported.name, wrappers))) {
          exported.add(name);
        }
      }
      for (const [name, target] of module.reexports) {
        if (isSyncApi(target.from, target.name, wrappers)) exported.add(name);
      }
      for (const from of module.starExports) {
        for (const name of wrappers.get(from) ?? []) if (name !== 'default') exported.add(name);
      }
      if (exported.size > (wrappers.get(module.key)?.size ?? 0)) {
        wrappers.set(module.key, exported);
        grew = true;
      }
    }
  }
  return wrappers;
}

/** The value of each `const NAME = <number>` in the file. */
function numericConstantsOf(file: ts.SourceFile): Map<string, number> {
  const constants = new Map<string, number>();
  walk(file, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || node.initializer === undefined) return;
    const list = node.parent;
    if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) return;
    const value = unwrap(node.initializer);
    if (ts.isNumericLiteral(value)) constants.set(node.name.text, Number(value.text));
  });
  return constants;
}

/** The `timeout` a spawn call states in an object-literal options argument, as a literal or a file constant. */
function statedTimeout(call: ts.CallExpression, constants: ReadonlyMap<string, number>): number | undefined {
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) continue;
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'timeout') {
        continue;
      }
      const value = unwrap(property.initializer);
      if (ts.isNumericLiteral(value)) return Number(value.text);
      if (ts.isIdentifier(value)) return constants.get(value.text);
    }
  }
  return undefined;
}

/** Whether `node` reads the wall clock: `Date.now()`, `performance.now()`, `process.hrtime()` or a no-argument `new Date().getTime()`. */
function isClockRead(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const name = callee.name.text;
  const receiver = callee.expression;
  if (ts.isIdentifier(receiver)) {
    return (
      (receiver.text === 'Date' && name === 'now') ||
      (receiver.text === 'performance' && name === 'now') ||
      (receiver.text === 'process' && name === 'hrtime')
    );
  }
  if (ts.isPropertyAccessExpression(receiver) && name === 'bigint') {
    return ts.isIdentifier(receiver.expression) && receiver.expression.text === 'process' && receiver.name.text === 'hrtime';
  }
  return (
    (name === 'getTime' || name === 'valueOf') &&
    ts.isNewExpression(receiver) &&
    ts.isIdentifier(receiver.expression) &&
    receiver.expression.text === 'Date' &&
    (receiver.arguments === undefined || receiver.arguments.length === 0)
  );
}

/** Whether any node below `root` (itself included) satisfies `test`. */
function contains(root: ts.Node, test: (node: ts.Node) => boolean): boolean {
  let found = false;
  walk(root, (node) => {
    if (!found && test(node)) found = true;
  });
  return found;
}

/** Whether an expression can carry a quantity of time: no object, `new`, string or template value at its top. */
function isQuantityShaped(node: ts.Expression): boolean {
  const top = unwrap(node);
  return !(
    ts.isObjectLiteralExpression(top) ||
    ts.isNewExpression(top) ||
    ts.isTemplateExpression(top) ||
    ts.isStringLiteralLike(top) ||
    (ts.isCallExpression(top) &&
      ts.isPropertyAccessExpression(top.expression) &&
      ['toISOString', 'toString', 'toFixed', 'toLocaleString', 'toUTCString'].includes(top.expression.name.text))
  );
}

/** The identifiers that `name = value` or a declaration binds, paired with the value. */
function assignmentsIn(file: ts.SourceFile): Array<{ name: string; value: ts.Expression }> {
  const pairs: Array<{ name: string; value: ts.Expression }> = [];
  walk(file, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      pairs.push({ name: node.name.text, value: node.initializer });
    } else if (
      ts.isBinaryExpression(node) &&
      ts.isIdentifier(node.left) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      pairs.push({ name: node.left.text, value: node.right });
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      for (const argument of node.arguments) pairs.push({ name: node.expression.expression.text, value: argument });
    }
  });
  return pairs;
}

/** Whether `node` references one of `names` as a plain identifier. */
function references(node: ts.Node, names: ReadonlySet<string>): boolean {
  return contains(node, (n) => ts.isIdentifier(n) && names.has(n.text) && !isPropertyName(n));
}

/** Whether an identifier is the name in `a.name`, not a variable. */
function isPropertyName(node: ts.Identifier): boolean {
  return ts.isPropertyAccessExpression(node.parent) && node.parent.name === node;
}

/** The expect call's matcher name, through `.not`, `.resolves` and `.rejects`. */
function matcherOf(expectCall: ts.CallExpression): { name: string; call: ts.CallExpression } | undefined {
  let current: ts.Node = expectCall;
  while (ts.isPropertyAccessExpression(current.parent) && current.parent.expression === current) {
    const access = current.parent;
    if (ts.isCallExpression(access.parent) && access.parent.expression === access) {
      return { name: access.name.text, call: access.parent };
    }
    current = access;
  }
  return undefined;
}

/** Whether a call is `expect(...)` or `expect.soft(...)`. */
function isExpectCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === 'expect';
  return ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === 'expect' && callee.name.text === 'soft';
}

/**
 * Every `expect()` in `source` whose subject is elapsed wall-clock time. Elapsed
 * time is a subtraction whose two sides both read the clock, directly or through
 * a variable set from a clock read, and every number derived from one. A subject
 * named like a duration (`durationMs`, `elapsed`) held under an upper bound also
 * counts. A calendar check such as `expect(expiry).toBeGreaterThan(Date.now())`
 * does not, and neither does a clock read used as a unique id.
 */
export function findElapsedTimeAssertions(source: string, fileName = 'module.test.ts'): RunnerDependence[] {
  const file = parse(source, fileName);
  const assignments = assignmentsIn(file);
  const clocked = new Set<string>();
  for (const { name, value } of assignments) {
    if (isQuantityShaped(value) && contains(value, isClockRead)) clocked.add(name);
  }
  const readsClock = (node: ts.Node): boolean => contains(node, isClockRead) || references(node, clocked);
  const isElapsed = (node: ts.Node): boolean =>
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.MinusToken &&
    readsClock(node.left) &&
    readsClock(node.right);
  const tainted = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, value } of assignments) {
      if (tainted.has(name) || !isQuantityShaped(value)) continue;
      if (contains(value, isElapsed) || references(value, tainted)) {
        tainted.add(name);
        grew = true;
      }
    }
  }
  const findings: RunnerDependence[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node) || !isExpectCall(node)) return;
    const subject = node.arguments[0];
    if (subject === undefined) return;
    if (contains(subject, isElapsed) || references(subject, tainted)) {
      findings.push({ line: lineOf(file, node), detail: 'elapsed time' });
      return;
    }
    const top = unwrap(subject);
    const matcher = matcherOf(node);
    if (
      ts.isPropertyAccessExpression(top) &&
      DURATION_PROPERTY.test(top.name.text) &&
      matcher !== undefined &&
      UPPER_BOUND_MATCHERS.has(matcher.name)
    ) {
      findings.push({ line: lineOf(file, node), detail: `reported duration ${top.name.text}` });
    }
  });
  return findings;
}

/** Whether `source` reads the wall clock anywhere: the elapsed-time guard's denominator. */
export function readsWallClock(source: string, fileName = 'module.ts'): boolean {
  return contains(parse(source, fileName), isClockRead);
}

/** Whether `source` imports `node:child_process` in any form: the spawn guard's denominator. */
export function importsChildProcess(source: string, fileName = 'module.ts'): boolean {
  const file = parse(source, fileName);
  return contains(file, (node) => {
    if (ts.isImportDeclaration(node)) return CHILD_PROCESS_SPECIFIERS.has(specifierText(node.moduleSpecifier) ?? '');
    return ts.isCallExpression(node) && CHILD_PROCESS_SPECIFIERS.has(dynamicModuleOf(node) ?? '');
  });
}
