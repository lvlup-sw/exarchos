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

/** One dependency that a caller passes in place of a default spawn: the index of the argument, and its property for a property of it. */
export interface SpawnOverride {
  readonly argument: number;
  readonly property?: string;
}

/**
 * When a call of a wrapper spawns. `always` means on each call.
 * A list of overrides means on each call that does not pass each of them, because the wrapper spawns only through default dependencies.
 */
export type SpawnCondition = 'always' | readonly SpawnOverride[];

/**
 * The exported synchronous spawn wrappers of a source tree, by module key, each with the condition of its spawn.
 * A module key is the repository-relative path of a module without its extension.
 * {@link deriveSyncSpawnWrappers} derives the map from the source, so a new exported wrapper needs no edit here.
 */
export type SyncSpawnWrappers = ReadonlyMap<string, ReadonlyMap<string, SpawnCondition>>;

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

/**
 * The condition of the spawn of the export `name` of the module `key`, or undefined when it does not spawn.
 * A directory key also reads its `index` module.
 */
function wrapperCondition(key: string, name: string, wrappers: SyncSpawnWrappers): SpawnCondition | undefined {
  if (key === CHILD_PROCESS_KEY) return CHILD_PROCESS_SYNC_APIS.has(name) ? 'always' : undefined;
  return (wrappers.get(key) ?? wrappers.get(`${key}/index`))?.get(name);
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
 * What a sync-spawn check of one file reads.
 * Only the derivation sets `localSync` and `owner`. The derivation also follows a call of a local function into its body.
 * A test scan does not, because each call in that body is a finding of its own.
 */
interface SpawnScope {
  readonly bindings: ImportBindings;
  readonly wrappers: SyncSpawnWrappers;
  /** The module-level functions of the file that the derivation already found to spawn, each with its condition. */
  readonly localSync?: ReadonlyMap<string, SpawnCondition>;
  /** The module-level function that the derivation reads. Its parameters are the arguments that an override names. */
  readonly owner?: ts.SignatureDeclaration;
  /** The values already followed, so that a binding that refers to itself ends the search. */
  readonly seen: Set<ts.Node>;
}

/** One spawn that a call or a value can run: the sync API and its condition. The condition names the arguments of the owner. */
interface SpawnHit {
  readonly api: ImportedName;
  readonly condition: SpawnCondition;
}

/** Whether two overrides name the same argument and the same property. */
function sameOverride(a: SpawnOverride, b: SpawnOverride): boolean {
  return a.argument === b.argument && a.property === b.property;
}

/**
 * The condition of two spawn paths together. A call spawns when either path spawns.
 * A path with more than one override can stop when the caller passes any one of them.
 * The union asks the caller for each of them, so the result never misses a spawn.
 */
function combine(a: SpawnCondition, b: SpawnCondition): SpawnCondition {
  if (a === 'always' || b === 'always') return 'always';
  return [...a, ...b.filter((override) => !a.some((known) => sameOverride(override, known)))];
}

/** Whether two conditions are equal, so that the repeated search knows when it found nothing new. */
function sameCondition(a: SpawnCondition | undefined, b: SpawnCondition | undefined): boolean {
  if (a === undefined || b === undefined || a === 'always' || b === 'always') return a === b;
  return a.length === b.length && a.every((override) => b.some((known) => sameOverride(override, known)));
}

/** Two hits as one: the first API, and the condition of both. */
function joinHits(a: SpawnHit | undefined, b: SpawnHit | undefined): SpawnHit | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { api: a.api, condition: combine(a.condition, b.condition) };
}

/** A hit that runs only when the caller does not pass `guard`, because it is the default of that dependency. */
function guardedHit(hit: SpawnHit | undefined, guard: SpawnOverride | undefined): SpawnHit | undefined {
  if (hit === undefined || guard === undefined) return hit;
  return { api: hit.api, condition: combine(hit.condition === 'always' ? [] : hit.condition, [guard]) };
}

/** What a declaration binds to a name. */
interface Binding {
  /** The value of the declaration, or the default of a parameter or a destructured name. */
  readonly value?: ts.Expression | ts.FunctionDeclaration;
  /** The argument of the owner that the name reads: the index, and the property for a destructured name. */
  readonly argument?: SpawnOverride;
  /** Marks a declaration with no value, such as a parameter with no default. */
  readonly opaque?: boolean;
  /**
   * The function that a module-level name declares. The scan reads what it returns.
   * The derivation reads the spawns of that function by its name, so the binding gives no `value` for it.
   */
  readonly declaration?: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
  /** The value that a destructured name with no default reads, and the property path to the name. */
  readonly source?: { readonly initializer: ts.Expression; readonly path: readonly string[] };
}

/** The declared element of `name` in a binding name, with the property path from the root and the default of the element. */
function elementOf(
  declared: ts.BindingName,
  initializer: ts.Expression | undefined,
  name: string,
  path: readonly string[] = [],
): { readonly value: ts.Expression | undefined; readonly path: readonly string[] } | undefined {
  if (ts.isIdentifier(declared)) return declared.text === name ? { value: initializer, path } : undefined;
  for (const element of declared.elements) {
    if (ts.isOmittedExpression(element)) continue;
    const key = element.propertyName ?? element.name;
    const step = ts.isObjectBindingPattern(declared) && ts.isIdentifier(key) ? key.text : '[]';
    const found = elementOf(element.name, element.initializer, name, [...path, step]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The argument of the owner that an element path reads from the argument `index`, or undefined for a deeper or array path. */
function argumentAt(index: number, path: readonly string[]): SpawnOverride | undefined {
  const [property, ...rest] = path;
  if (property === undefined) return { argument: index };
  return rest.length === 0 && property !== '[]' ? { argument: index, property } : undefined;
}

/** The binding of `name` in one scope, or undefined when the scope does not declare it. */
function bindingInScope(scope: ts.Node, name: string, owner: ts.SignatureDeclaration | undefined): Binding | undefined {
  if (ts.isFunctionLike(scope)) {
    for (const [index, parameter] of scope.parameters.entries()) {
      const found = elementOf(parameter.name, parameter.initializer, name);
      if (found === undefined) continue;
      const argument = scope === owner ? argumentAt(index, found.path) : undefined;
      return { ...(found.value === undefined ? { opaque: true } : { value: found.value }), ...(argument === undefined ? {} : { argument }) };
    }
    return undefined;
  }
  const isStatementList =
    ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope);
  if (!isStatementList) return undefined;
  for (const statement of scope.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return ts.isSourceFile(scope) ? { declaration: statement } : { value: statement };
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const found = elementOf(declaration.name, declaration.initializer, name);
      if (found === undefined) continue;
      const source = found.path.length === 0 || declaration.initializer === undefined ? undefined : ownerArgumentOf(declaration.initializer, owner);
      const argument = source?.property === undefined && source !== undefined ? argumentAt(source.argument, found.path) : undefined;
      const value = found.path.length === 0 ? declaration.initializer : found.value;
      const fn = value === undefined ? undefined : functionValueOf(value);
      if (fn !== undefined && ts.isSourceFile(scope)) return { declaration: fn };
      const destructured =
        value === undefined && declaration.initializer !== undefined ? { source: { initializer: declaration.initializer, path: found.path } } : {};
      return { ...(value === undefined ? { opaque: true } : { value }), ...(argument === undefined ? {} : { argument }), ...destructured };
    }
  }
  return undefined;
}

/** The function that a bound value is, when it is an arrow or a function expression. */
function functionValueOf(value: ts.Expression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  const inner = unwrap(value);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner) ? inner : undefined;
}

/**
 * The binding of the nearest declaration of `name` around `at`.
 * The search goes out through the enclosing functions and blocks to the module level, so an inner name hides an outer one.
 */
function bindingOf(name: string, at: ts.Node, owner: ts.SignatureDeclaration | undefined): Binding {
  for (let scope: ts.Node | undefined = at.parent; scope !== undefined; scope = scope.parent) {
    const found = bindingInScope(scope, name, owner);
    if (found !== undefined) return found;
  }
  return {};
}

/** Removes a fallback to an empty object, as in `options ?? {}`, around an expression. */
function withoutEmptyFallback(node: ts.Expression): ts.Expression {
  const value = unwrap(node);
  if (!ts.isBinaryExpression(value)) return value;
  const operator = value.operatorToken.kind;
  const isFallback = operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken;
  const right = unwrap(value.right);
  return isFallback && ts.isObjectLiteralExpression(right) && right.properties.length === 0 ? unwrap(value.left) : value;
}

/**
 * The argument of the owner that an expression reads, as an override.
 * The expression is a parameter, a destructured name of one, or a property of one such as `deps.run` or `options?.run`.
 * Any other expression gives undefined.
 */
function ownerArgumentOf(node: ts.Expression, owner: ts.SignatureDeclaration | undefined): SpawnOverride | undefined {
  if (owner === undefined) return undefined;
  const value = withoutEmptyFallback(node);
  if (ts.isIdentifier(value)) return bindingOf(value.text, value, owner).argument;
  if (!ts.isPropertyAccessExpression(value)) return undefined;
  const receiver = withoutEmptyFallback(value.expression);
  if (!ts.isIdentifier(receiver)) return undefined;
  const whole = bindingOf(receiver.text, receiver, owner).argument;
  return whole === undefined || whole.property !== undefined ? undefined : { argument: whole.argument, property: value.name.text };
}

/** How many steps {@link objectLiteralOf} follows before it stops, so that a binding that refers to itself ends the search. */
const MAX_LITERAL_STEPS = 8;

/** The object literal that the property `key` of a literal holds, directly or through a local binding. */
function propertyLiteralOf(
  literal: ts.ObjectLiteralExpression,
  key: string,
  scope: SpawnScope,
  steps: number,
): ts.ObjectLiteralExpression | undefined {
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === key) return objectLiteralOf(property.name, scope, steps);
    if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === key) return objectLiteralOf(property.initializer, scope, steps);
  }
  return undefined;
}

/** The object literal that a local function returns: the body of an arrow, or the value of the one `return` of a block. */
function returnedLiteralOf(
  fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.Expression,
  scope: SpawnScope,
  steps: number,
): ts.ObjectLiteralExpression | undefined {
  if (!ts.isFunctionDeclaration(fn) && !ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) return undefined;
  if (fn.body === undefined) return undefined;
  if (!ts.isBlock(fn.body)) return objectLiteralOf(fn.body, scope, steps);
  const returns: ts.ReturnStatement[] = [];
  const step = (node: ts.Node): void => {
    if (ts.isReturnStatement(node)) returns.push(node);
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, step);
  };
  ts.forEachChild(fn.body, step);
  const [only] = returns;
  return returns.length === 1 && only?.expression !== undefined ? objectLiteralOf(only.expression, scope, steps) : undefined;
}

/**
 * The object literal that an argument is. It is a literal, a local binding of one, a name destructured from one, or a property of one.
 * It can also be the literal that a local helper returns, as in `const { deps } = makeDeps()` or `makeDeps().deps`.
 */
function objectLiteralOf(node: ts.Expression, scope: SpawnScope, steps = MAX_LITERAL_STEPS): ts.ObjectLiteralExpression | undefined {
  if (steps === 0) return undefined;
  const value = unwrap(node);
  if (ts.isObjectLiteralExpression(value)) return value;
  if (ts.isPropertyAccessExpression(value)) {
    const owner = objectLiteralOf(value.expression, scope, steps - 1);
    return owner === undefined ? undefined : propertyLiteralOf(owner, value.name.text, scope, steps - 1);
  }
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression);
    if (!ts.isIdentifier(callee)) return undefined;
    const helper = bindingOf(callee.text, callee, scope.owner);
    const fn = helper.declaration ?? helper.value;
    return fn === undefined ? undefined : returnedLiteralOf(fn, scope, steps - 1);
  }
  if (!ts.isIdentifier(value)) return undefined;
  const binding = bindingOf(value.text, value, scope.owner);
  if (binding.value !== undefined && !ts.isFunctionDeclaration(binding.value)) return objectLiteralOf(binding.value, scope, steps - 1);
  if (binding.source === undefined) return undefined;
  let literal = objectLiteralOf(binding.source.initializer, scope, steps - 1);
  for (const key of binding.source.path) literal = literal === undefined ? undefined : propertyLiteralOf(literal, key, scope, steps - 1);
  return literal;
}

/** The text of a property name that is an identifier or a string literal. */
function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : undefined;
}

/**
 * Whether a caller passes a dependency with `node`. The result is `passed`, or `fires` when the default runs or can run.
 * It is the argument of the owner when the owner passes its own argument on.
 * A value that can be undefined, or that spawns itself, does not pass.
 */
function dependencyPassage(node: ts.Expression, scope: SpawnScope): 'passed' | 'fires' | SpawnOverride {
  const value = unwrap(node);
  const fromOwner = ownerArgumentOf(value, scope.owner);
  if (fromOwner !== undefined) return fromOwner;
  if (ts.isIdentifier(value)) {
    if (value.text === 'undefined') return 'fires';
    const binding = bindingOf(value.text, value, scope.owner);
    if (binding.opaque === true && scope.bindings.named.get(value.text) === undefined) return 'fires';
  } else if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value) && !ts.isCallExpression(value) && !ts.isNewExpression(value)) {
    return 'fires';
  }
  return valueHit(value, undefined, { ...scope, seen: new Set() }) === undefined ? 'passed' : 'fires';
}

/** Whether a call passes one override of its callee: `passed`, `fires`, or the argument of the owner that passes it on. */
function overridePassage(call: ts.CallExpression, override: SpawnOverride, scope: SpawnScope): 'passed' | 'fires' | SpawnOverride {
  const spreadAt = call.arguments.findIndex((argument) => ts.isSpreadElement(argument));
  if (spreadAt >= 0 && spreadAt <= override.argument) return 'fires';
  const argument = call.arguments[override.argument];
  if (argument === undefined) return 'fires';
  if (override.property === undefined) return dependencyPassage(argument, scope);
  const whole = ownerArgumentOf(argument, scope.owner);
  if (whole !== undefined) return whole.property === undefined ? { argument: whole.argument, property: override.property } : 'fires';
  const literal = objectLiteralOf(argument, scope);
  if (literal === undefined) return 'fires';
  let passage: 'passed' | 'fires' | SpawnOverride = 'fires';
  for (const property of literal.properties) {
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === override.property) {
      passage = dependencyPassage(property.name, scope);
    } else if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === override.property) {
      passage = dependencyPassage(property.initializer, scope);
    } else if (ts.isMethodDeclaration(property) && propertyNameText(property.name) === override.property) {
      passage = 'passed';
    } else if (ts.isSpreadAssignment(property)) {
      const spread = ownerArgumentOf(property.expression, scope.owner);
      if (spread !== undefined && spread.property === undefined) passage = { argument: spread.argument, property: override.property };
    }
  }
  return passage;
}

/**
 * The condition of a spawn of a callee at one call, in terms of the arguments of the owner.
 * A call that passes each override of the callee runs no spawn. An override that the call passes on from the owner
 * becomes an override of the owner. With no call, as for a dependency value, each spawn counts.
 */
function conditionAtCall(callee: SpawnCondition, call: ts.CallExpression | undefined, scope: SpawnScope): SpawnCondition | undefined {
  if (callee === 'always' || call === undefined) return 'always';
  const passedOn: SpawnOverride[] = [];
  for (const override of callee) {
    const passage = overridePassage(call, override, scope);
    if (passage === 'fires') return 'always';
    if (passage !== 'passed') passedOn.push(passage);
  }
  return passedOn.length === 0 ? undefined : passedOn;
}

/** A hit for `api` at one call, or undefined when the call passes each override of the callee. */
function hitAtCall(api: ImportedName, callee: SpawnCondition, call: ts.CallExpression | undefined, scope: SpawnScope): SpawnHit | undefined {
  const condition = conditionAtCall(callee, call, scope);
  return condition === undefined ? undefined : { api, condition };
}

/**
 * The spawn that a value runs when `call` calls it, or undefined when no form of the value spawns.
 * A value is a sync API, a wrapper, a module-level function that spawns, or a local binding of one of them.
 * Each arm of `??`, `||` and `? :` counts. In `deps.run ?? defaultRun`, the right arm runs only when the caller
 * does not pass `run`, so its spawn has that override.
 */
function valueHit(node: ts.Expression | ts.FunctionDeclaration, call: ts.CallExpression | undefined, scope: SpawnScope): SpawnHit | undefined {
  if (scope.seen.has(node)) return undefined;
  scope.seen.add(node);
  if (ts.isFunctionDeclaration(node)) return functionHit(node, scope);
  const value = unwrap(node);
  if (ts.isIdentifier(value)) return nameHit(value, call, scope);
  if (ts.isPropertyAccessExpression(value)) return memberHit(value, call, scope);
  if (ts.isConditionalExpression(value)) return joinHits(valueHit(value.whenTrue, call, scope), valueHit(value.whenFalse, call, scope));
  if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) return functionHit(value, scope);
  if (!ts.isBinaryExpression(value)) return undefined;
  const operator = value.operatorToken.kind;
  if (operator !== ts.SyntaxKind.QuestionQuestionToken && operator !== ts.SyntaxKind.BarBarToken) return undefined;
  const fallback = guardedHit(valueHit(value.right, call, scope), ownerArgumentOf(value.left, scope.owner));
  return joinHits(valueHit(value.left, call, scope), fallback);
}

/** The spawn that a local function runs when it is called. Only the derivation follows a function, and never an `async` one. */
function functionHit(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, scope: SpawnScope): SpawnHit | undefined {
  if (scope.localSync === undefined || isAsync(fn) || fn.body === undefined) return undefined;
  let hit: SpawnHit | undefined;
  for (const inner of callsRunBy(fn.body)) hit = joinHits(hit, callHit(inner, scope));
  return hit;
}

/** The spawn that a name runs when `call` calls it: a module-level function, an imported sync API, or a local binding of one. */
function nameHit(name: ts.Identifier, call: ts.CallExpression | undefined, scope: SpawnScope): SpawnHit | undefined {
  const local = scope.localSync?.get(name.text);
  if (local !== undefined) return hitAtCall({ from: name.getSourceFile().fileName, name: name.text }, local, call, scope);
  const imported = scope.bindings.named.get(name.text);
  const importedCondition = imported === undefined ? undefined : wrapperCondition(imported.from, imported.name, scope.wrappers);
  if (imported !== undefined && importedCondition !== undefined) {
    const api = imported.name === 'default' ? { from: imported.from, name: name.text } : imported;
    return hitAtCall(api, importedCondition, call, scope);
  }
  const binding = bindingOf(name.text, name, scope.owner);
  if (binding.value === undefined) return undefined;
  return guardedHit(valueHit(binding.value, call, scope), binding.argument);
}

/** The spawn that `receiver.name` runs, when the receiver is a namespace or a dynamic load of a module. */
function memberHit(member: ts.PropertyAccessExpression, call: ts.CallExpression | undefined, scope: SpawnScope): SpawnHit | undefined {
  const name = member.name.text;
  const receiver = unwrap(member.expression);
  const from = ts.isIdentifier(receiver)
    ? scope.bindings.namespaces.get(receiver.text)
    : resolveModuleKey(dynamicModuleOf(receiver), member.getSourceFile().fileName);
  const condition = from === undefined ? undefined : wrapperCondition(from, name, scope.wrappers);
  return from === undefined || condition === undefined ? undefined : hitAtCall({ from, name }, condition, call, scope);
}

/**
 * The spawn that a call runs, with the condition of the spawn, or undefined when the call is not a sync spawn.
 * A callee that is not a name or a member, such as `(deps.run ?? defaultRun)(cmd)`, is read as a value.
 */
function callHit(call: ts.CallExpression, scope: SpawnScope): SpawnHit | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return nameHit(callee, call, scope);
  return ts.isPropertyAccessExpression(callee) ? memberHit(callee, call, scope) : valueHit(callee, call, scope);
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
 * imported bindings count, and so does a local binding of one, such as
 * `const run = deps.run ?? execFileSync`. A call that passes each override of a
 * wrapper does not count, unless a passed value can be undefined or spawns itself.
 * A call that is the whole body of an arrow passed to `isolatedSync` does not
 * count. A call of a wrapper in a file that mocks the whole of
 * `node:child_process` does not count.
 */
export function findSyncSpawnCalls(source: string, fileName: string, wrappers: SyncSpawnWrappers): RunnerDependence[] {
  const file = parse(source, fileName);
  const bindings = importBindingsOf(file);
  const constants = numericConstantsOf(file);
  const wrappersReachTheMock = mocksChildProcessWholly(file);
  const findings: RunnerDependence[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = callHit(node, { bindings, wrappers, seen: new Set() })?.api;
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

/** One module-level function: its node, whose parameters an override names, and the calls that it runs. */
interface ModuleFunction {
  readonly node: ts.SignatureDeclaration;
  readonly calls: readonly ts.CallExpression[];
}

/** The module-level facts of one source module that the derivation reads. */
interface ModuleFacts {
  readonly key: string;
  readonly bindings: ImportBindings;
  /** Each module-level function, by its local name, with the calls that it runs. */
  readonly functions: ReadonlyMap<string, ModuleFunction>;
  /** The value of each module-level variable that is not a function, by its local name, such as `const run = execFileSync`. */
  readonly aliases: ReadonlyMap<string, ts.Expression>;
  /** Each exported name and the local name that it exports. */
  readonly exports: ReadonlyMap<string, string>;
  /** Each exported name that the module re-exports from another module. */
  readonly reexports: ReadonlyMap<string, ImportedName>;
  /** The keys of the modules whose every export the module re-exports. */
  readonly starExports: readonly string[];
}

/**
 * Reads the module-level functions, the aliases, the exports and the re-exports of one module.
 * A function is a function declaration, or a variable whose value is an arrow or a function expression.
 * An `async` function is not read, because its caller awaits a promise and does not call a synchronous API.
 * An alias is a variable with another value, such as a sync API or a default dependency.
 */
function moduleFactsOf(module: SourceModule): ModuleFacts {
  const file = parse(module.source, module.path);
  const functions = new Map<string, ModuleFunction>();
  const aliases = new Map<string, ts.Expression>();
  const exports = new Map<string, string>();
  const reexports = new Map<string, ImportedName>();
  const starExports: string[] = [];
  for (const statement of file.statements) {
    const exported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.body !== undefined && !isAsync(statement)) {
      const local = statement.name?.text ?? 'default';
      functions.set(local, { node: statement, calls: callsRunBy(statement.body) });
      if (exported) exports.set(hasModifier(statement, ts.SyntaxKind.DefaultKeyword) ? 'default' : local, local);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.initializer === undefined) continue;
        const value = unwrap(declaration.initializer);
        if (exported) exports.set(declaration.name.text, declaration.name.text);
        if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) aliases.set(declaration.name.text, value);
        else if (!isAsync(value)) functions.set(declaration.name.text, { node: value, calls: callsRunBy(value.body) });
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
  return { key: moduleKeyOf(module.path), bindings: importBindingsOf(file), functions, aliases, exports, reexports, starExports };
}

/** The condition of a spawn in one module-level function: the condition of each call that spawns, together. */
function functionCondition(fn: ModuleFunction, scope: Omit<SpawnScope, 'seen' | 'owner'>): SpawnCondition | undefined {
  let condition: SpawnCondition | undefined;
  for (const call of fn.calls) {
    const hit = callHit(call, { ...scope, owner: fn.node, seen: new Set() });
    if (hit !== undefined) condition = condition === undefined ? hit.condition : combine(condition, hit.condition);
  }
  return condition;
}

/** Sets `name` to `condition` in `map` when the condition is new or wider, and tells whether it did. */
function widen(map: Map<string, SpawnCondition>, name: string, condition: SpawnCondition | undefined): boolean {
  if (condition === undefined) return false;
  const known = map.get(name);
  const next = known === undefined ? condition : combine(known, condition);
  if (sameCondition(known, next)) return false;
  map.set(name, next);
  return true;
}

/**
 * The exported synchronous spawn wrappers of `modules`, by module key, each with the condition of its spawn.
 * A module-level function is a wrapper when its body runs a call of a sync spawn.
 * That call is a sync API of `node:child_process`, a wrapper that the module imports, or another wrapper of the module.
 * A local binding of one of them also counts, such as `const run = deps.run ?? defaultRun` or a parameter default.
 * A spawn through such a default dependency has an override: the wrapper spawns only when the caller does not pass it.
 * An export of a wrapper, a re-export of a wrapper and an `export *` of a module with wrappers each count.
 *
 * The search repeats until no condition changes, so a wrapper of a wrapper counts too.
 * A spawn through a class method, through a property of an object, or through a function that a call returns is not found.
 */
export function deriveSyncSpawnWrappers(modules: readonly SourceModule[]): Map<string, Map<string, SpawnCondition>> {
  const facts = modules.map(moduleFactsOf);
  const localSync = facts.map(() => new Map<string, SpawnCondition>());
  const wrappers = new Map<string, Map<string, SpawnCondition>>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [index, module] of facts.entries()) {
      const sync = localSync[index] ?? new Map<string, SpawnCondition>();
      const scope = { bindings: module.bindings, wrappers, localSync: sync };
      for (const [local, fn] of module.functions) {
        if (widen(sync, local, functionCondition(fn, scope))) grew = true;
      }
      for (const [local, value] of module.aliases) {
        if (widen(sync, local, valueHit(value, undefined, { ...scope, seen: new Set() })?.condition)) grew = true;
      }
      const exported = wrappers.get(module.key) ?? new Map<string, SpawnCondition>();
      let exportsGrew = false;
      for (const [name, local] of module.exports) {
        const imported = module.bindings.named.get(local);
        const condition = sync.get(local) ?? (imported === undefined ? undefined : wrapperCondition(imported.from, imported.name, wrappers));
        if (widen(exported, name, condition)) exportsGrew = true;
      }
      for (const [name, target] of module.reexports) {
        if (widen(exported, name, wrapperCondition(target.from, target.name, wrappers))) exportsGrew = true;
      }
      for (const from of module.starExports) {
        for (const [name, condition] of wrappers.get(from) ?? []) {
          if (name !== 'default' && widen(exported, name, condition)) exportsGrew = true;
        }
      }
      if (exportsGrew) {
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
