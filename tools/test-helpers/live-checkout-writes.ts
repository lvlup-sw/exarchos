// Finds file writes in test code whose target is inside the live checkout.
//
// A target is in the checkout when its path starts at `__dirname`,
// `__filename`, `import.meta`, `process.cwd()`, or a relative path (which Node
// resolves against the working directory). The scan follows a value through
// variables, assignments, object fields, array `map` and `filter`, helper
// functions with their real arguments, and relative imports. A write records
// the `process.env` switch that guards it; a `main` that runs only as the
// entry point is not test code.
//
// It cannot see a write done by a child process (a build, `git`, a shell), a
// path that arrives through a callback argument or a class field, or an fs
// function called under another name. Tests import this module, never `src/`.

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** One write call whose target path is inside the live checkout. */
export interface LiveCheckoutWrite {
  readonly file: string;
  readonly line: number;
  readonly sink: string;
  readonly text: string;
  /** The env variable that must equal a literal for the write to run, when an `if` guards it. */
  readonly gate: string | undefined;
}

/** The result for one module: how many write calls it holds, and which reach the checkout. */
export interface LiveCheckoutWriteScan {
  readonly sinkCallCount: number;
  readonly writes: readonly LiveCheckoutWrite[];
}

/** Reads the module that a relative import names, or returns `undefined`. */
export type ModuleReader = (fromFile: string, specifier: string) => { fileName: string; source: string } | undefined;

/**
 * The fs functions that change the file system, by name, and the positions of
 * their target paths. A copy or a link changes only its destination; a rename
 * changes both ends. `rmrf` and `rmrfAsync` are the repo's removal helpers.
 */
const SINK_TARGETS: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['writeFileSync', [0]],
  ['writeFile', [0]],
  ['appendFileSync', [0]],
  ['appendFile', [0]],
  ['mkdirSync', [0]],
  ['mkdir', [0]],
  ['mkdtempSync', [0]],
  ['mkdtemp', [0]],
  ['rmSync', [0]],
  ['rm', [0]],
  ['rmdirSync', [0]],
  ['rmdir', [0]],
  ['rmrf', [0]],
  ['rmrfAsync', [0]],
  ['unlinkSync', [0]],
  ['unlink', [0]],
  ['truncateSync', [0]],
  ['truncate', [0]],
  ['createWriteStream', [0]],
  ['utimesSync', [0]],
  ['utimes', [0]],
  ['chmodSync', [0]],
  ['chmod', [0]],
  ['copyFileSync', [1]],
  ['copyFile', [1]],
  ['cpSync', [1]],
  ['cp', [1]],
  ['symlinkSync', [1]],
  ['symlink', [1]],
  ['linkSync', [1]],
  ['link', [1]],
  ['renameSync', [0, 1]],
  ['rename', [0, 1]],
]);

/** `open` and `openSync` change a file only when their flags ask to write. */
const OPEN_SINKS = new Set(['open', 'openSync']);
const WRITE_FLAGS = /[wa+]/;

/** Path functions whose result is inside the checkout when their first argument is. */
const FIRST_ARG_PATH_FUNCTIONS = new Set([
  'join',
  'resolve',
  'normalize',
  'dirname',
  'toNamespacedPath',
  'fileURLToPath',
  'realpathSync',
  'pathToFileURL',
]);

/** Array methods that return values built by their callback. */
const ARRAY_MAPPERS = new Set(['map', 'flatMap']);

/** Array methods that return elements of their receiver. */
const ARRAY_PASSTHROUGH = new Set(['filter', 'slice', 'sort', 'reverse', 'concat', 'toSorted', 'toReversed', 'flat', 'find', 'at']);

/** How deep a chain of helper calls is followed with its real arguments. */
const CALL_DEPTH_LIMIT = 6;

/** The bound on nested field lookups, which also stops a cycle of aliases. */
const SHAPE_DEPTH_LIMIT = 12;

type FunctionNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

interface Binding {
  readonly kind: 'variable' | 'parameter' | 'import' | 'function' | 'loop';
  readonly name: string;
  readonly module: ModuleContext;
  readonly init?: ts.Expression;
  readonly assignments: ts.Expression[];
  readonly fn?: FunctionNode;
  readonly index?: number;
  readonly importedName?: string;
  readonly specifier?: string;
}

interface ModuleContext {
  readonly fileName: string;
  readonly sourceFile: ts.SourceFile;
  readonly scopes: Map<ts.Node, Map<string, Binding>>;
  readonly callsByFunction: Map<FunctionNode, ts.CallExpression[]>;
  readonly exports: Map<string, ts.Node>;
  /** A top-level `main` that runs only when the module is the process entry point. */
  scriptMain: FunctionNode | undefined;
}

/** The value a parameter takes in one call: an argument, or the default. */
interface ParamValue {
  readonly module: ModuleContext;
  readonly expr: ts.Expression | undefined;
  readonly env: Env | undefined;
}

/** The parameter values of the helper calls being followed. */
interface Env {
  readonly params: ReadonlyMap<Binding, ParamValue>;
  readonly depth: number;
}

/** How a scan reaches other modules. */
export interface ScanOptions {
  /** Reads relative imports; without it an imported value counts as outside the checkout. */
  readonly reader?: ModuleReader;
  /**
   * Directories whose helpers the scan enters to find a write made with a
   * caller's argument. Product code outside them is not entered: its writes
   * follow its arguments, and its defaults are not test code. Absent: all.
   */
  readonly helperRoots?: readonly string[];
}

interface ScanState {
  readonly reader: ModuleReader | undefined;
  readonly helperRoots: readonly string[] | undefined;
  readonly modules: Map<string, ModuleContext | null>;
  readonly memo: Map<Binding | FunctionNode, boolean>;
  readonly active: Set<Binding | FunctionNode>;
}

function isDiagnosticArray(value: unknown): value is readonly ts.Diagnostic[] {
  return Array.isArray(value);
}

function scriptKindFor(fileName: string): ts.ScriptKind {
  return /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Parses a module and refuses a recovered parse, which could hide a write. */
export function parseModuleOrThrow(fileName: string, source: string): ts.SourceFile {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const raw: unknown = Reflect.get(sourceFile, 'parseDiagnostics');
  const diagnostics: readonly ts.Diagnostic[] = isDiagnosticArray(raw) ? raw : [];
  const first = diagnostics[0];
  if (first !== undefined) {
    throw new Error(
      `live-checkout-writes: ${fileName} did not parse cleanly (${ts.flattenDiagnosticMessageText(first.messageText, ' ')})`,
    );
  }
  return sourceFile;
}

function isFunctionNode(node: ts.Node): node is FunctionNode {
  return (
    ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)
  );
}

function isBlockScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node) ||
    isFunctionNode(node)
  );
}

function hasExportModifier(node: ts.VariableStatement | ts.FunctionDeclaration): boolean {
  return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function nearest(node: ts.Node, test: (candidate: ts.Node) => boolean): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current !== undefined && !test(current)) current = current.parent;
  return current ?? node.getSourceFile();
}

function declare(module: ModuleContext, scope: ts.Node, binding: Binding): void {
  let names = module.scopes.get(scope);
  if (names === undefined) {
    names = new Map();
    module.scopes.set(scope, names);
  }
  names.set(binding.name, binding);
}

function declareVariable(module: ModuleContext, node: ts.VariableDeclaration, name: ts.Identifier): void {
  const list = node.parent;
  const isVar = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) === 0;
  const scope = isVar ? nearest(node, (n) => isFunctionNode(n) || ts.isSourceFile(n)) : nearest(node, isBlockScope);
  const owner = list.parent;
  const isLoopVariable = (ts.isForOfStatement(owner) || ts.isForInStatement(owner)) && owner.initializer === list;
  const init = isLoopVariable ? owner.expression : node.initializer;
  declare(module, scope, {
    kind: isLoopVariable ? 'loop' : 'variable',
    name: name.text,
    module,
    ...(init !== undefined ? { init } : {}),
    assignments: [],
  });
  if (ts.isVariableStatement(owner) && hasExportModifier(owner)) module.exports.set(name.text, node);
}

function declareImports(module: ModuleContext, node: ts.ImportDeclaration, specifier: string, clause: ts.ImportClause): void {
  const file = module.sourceFile;
  const base: Pick<Binding, 'kind' | 'module' | 'assignments' | 'specifier'> = { kind: 'import', module, assignments: [], specifier };
  if (clause.name !== undefined) declare(module, file, { ...base, name: clause.name.text, importedName: 'default' });
  const bindings = clause.namedBindings;
  if (bindings !== undefined && ts.isNamedImports(bindings)) {
    for (const element of bindings.elements) {
      declare(module, file, { ...base, name: element.name.text, importedName: (element.propertyName ?? element.name).text });
    }
  } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
    declare(module, file, { ...base, name: bindings.name.text, importedName: '*' });
  }
}

function isAssignmentToIdentifier(node: ts.Node): node is ts.BinaryExpression & { left: ts.Identifier } {
  if (!ts.isBinaryExpression(node) || !ts.isIdentifier(node.left)) return false;
  const kind = node.operatorToken.kind;
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken
  );
}

function buildModule(fileName: string, sourceFile: ts.SourceFile): ModuleContext {
  const module: ModuleContext = {
    fileName,
    sourceFile,
    scopes: new Map(),
    callsByFunction: new Map(),
    exports: new Map(),
    scriptMain: undefined,
  };
  const calls: ts.CallExpression[] = [];
  const assignments: Array<ts.BinaryExpression & { left: ts.Identifier }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declareVariable(module, node, node.name);
    } else if (ts.isParameter(node) && ts.isIdentifier(node.name) && isFunctionNode(node.parent)) {
      declare(module, node.parent, {
        kind: 'parameter',
        name: node.name.text,
        module,
        ...(node.initializer !== undefined ? { init: node.initializer } : {}),
        assignments: [],
        fn: node.parent,
        index: node.parent.parameters.indexOf(node),
      });
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      declare(module, nearest(node, isBlockScope), { kind: 'function', name: node.name.text, module, assignments: [], fn: node });
      if (hasExportModifier(node)) module.exports.set(node.name.text, node);
    } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause !== undefined) {
      declareImports(module, node, node.moduleSpecifier.text, node.importClause);
    } else if (ts.isExportDeclaration(node) && node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) module.exports.set(element.name.text, element);
    } else if (ts.isCallExpression(node)) {
      calls.push(node);
    } else if (isAssignmentToIdentifier(node)) {
      assignments.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const assignment of assignments) resolveIdentifier(module, assignment.left)?.assignments.push(assignment.right);
  for (const call of calls) {
    const fn = calledFunction(module, call.expression);
    if (fn === undefined) continue;
    const list = module.callsByFunction.get(fn) ?? [];
    list.push(call);
    module.callsByFunction.set(fn, list);
  }
  module.scriptMain = findScriptMain(module);
  return module;
}

function isInside(node: ts.Node, ancestor: ts.Node | undefined): boolean {
  if (ancestor === undefined) return false;
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/** An `if` condition that holds only when the module is the process entry point. */
function isEntryPointCheck(condition: ts.Expression): boolean {
  return /\bimport\.meta\.(?:url|filename|main)\b|\brequire\.main\s*===\s*module\b/.test(condition.getText());
}

/**
 * The module's top-level `function main`, when every call to it sits inside an
 * entry-point check. Such a `main` runs from a shell (`tsx script.ts`), never
 * when a test imports the module, so its writes are not test writes.
 */
function findScriptMain(module: ModuleContext): FunctionNode | undefined {
  const binding = module.scopes.get(module.sourceFile)?.get('main');
  const fn = binding?.kind === 'function' ? binding.fn : undefined;
  if (fn === undefined) return undefined;
  const calls = module.callsByFunction.get(fn) ?? [];
  const guardedCall = (call: ts.CallExpression): boolean => {
    for (let current: ts.Node | undefined = call.parent; current !== undefined; current = current.parent) {
      if (ts.isIfStatement(current) && isInside(call, current.thenStatement) && isEntryPointCheck(current.expression)) {
        return true;
      }
    }
    return false;
  };
  return calls.length > 0 && calls.every(guardedCall) ? fn : undefined;
}

function envVariableName(node: ts.Expression): string | undefined {
  const inner = unwrap(node);
  const isProcessEnv = (target: ts.Expression): boolean =>
    ts.isPropertyAccessExpression(target) &&
    target.name.text === 'env' &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'process';
  if (ts.isPropertyAccessExpression(inner) && isProcessEnv(inner.expression)) return inner.name.text;
  if (ts.isElementAccessExpression(inner) && isProcessEnv(inner.expression) && ts.isStringLiteral(inner.argumentExpression)) {
    return inner.argumentExpression.text;
  }
  return undefined;
}

/**
 * The env variable of the nearest `if (process.env.NAME === '<literal>')`
 * whose then-branch holds `node`: the opt-in switch of a regeneration write.
 */
function envGate(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (!ts.isIfStatement(current) || !isInside(node, current.thenStatement)) continue;
    const condition = unwrap(current.expression);
    if (!ts.isBinaryExpression(condition)) continue;
    const kind = condition.operatorToken.kind;
    if (kind !== ts.SyntaxKind.EqualsEqualsEqualsToken && kind !== ts.SyntaxKind.EqualsEqualsToken) continue;
    const left = envVariableName(condition.left);
    const right = envVariableName(condition.right);
    if (left !== undefined && ts.isStringLiteral(unwrap(condition.right))) return left;
    if (right !== undefined && ts.isStringLiteral(unwrap(condition.left))) return right;
  }
  return undefined;
}

function resolveIdentifier(module: ModuleContext, identifier: ts.Identifier): Binding | undefined {
  let current: ts.Node | undefined = identifier.parent;
  while (current !== undefined) {
    const binding = module.scopes.get(current)?.get(identifier.text);
    if (binding !== undefined) return binding;
    current = current.parent;
  }
  return undefined;
}

function functionOf(binding: Binding | undefined): FunctionNode | undefined {
  if (binding?.kind === 'function') return binding.fn;
  const init = binding?.kind === 'variable' ? binding.init : undefined;
  return init !== undefined && isFunctionNode(init) ? init : undefined;
}

function calledFunction(module: ModuleContext, callee: ts.Expression): FunctionNode | undefined {
  return ts.isIdentifier(callee) ? functionOf(resolveIdentifier(module, callee)) : undefined;
}

/** A path Node resolves against the working directory: not rooted, not a URL, not `~`. */
function isRelativePathText(text: string): boolean {
  return text.length > 0 && !/^(?:[\\/~]|[A-Za-z]:[\\/]|[a-z][a-z0-9+.-]*:)/i.test(text);
}

/** A relative literal away from the write call counts only with a separator or an extension. */
function isRelativeLiteral(text: string, direct: boolean): boolean {
  if (!isRelativePathText(text)) return false;
  return direct || /[\\/]|\.[A-Za-z0-9]+$/.test(text);
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isAwaitExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isImportMeta(node: ts.Expression): boolean {
  return ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword;
}

function isProcessCwd(callee: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'cwd' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'process'
  );
}

function returnedExpressions(fn: FunctionNode): ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && isFunctionNode(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

function guarded(key: Binding | FunctionNode, state: ScanState, memoize: boolean, compute: () => boolean): boolean {
  const known = memoize ? state.memo.get(key) : undefined;
  if (known !== undefined) return known;
  if (state.active.has(key)) return false;
  state.active.add(key);
  const result = compute();
  state.active.delete(key);
  if (memoize) state.memo.set(key, result);
  return result;
}

/**
 * Whether `raw` evaluates to a path inside the checkout. `direct` is true at
 * the write call itself: there any relative literal counts. A literal that
 * reaches the call through a variable counts only when it looks like a path.
 */
function isLive(module: ModuleContext, raw: ts.Expression, state: ScanState, direct: boolean, env: Env | undefined): boolean {
  const node = unwrap(raw);
  if (ts.isIdentifier(node)) {
    if (node.text === '__dirname' || node.text === '__filename') return true;
    const binding = resolveIdentifier(module, node);
    if (binding === undefined) return false;
    const value = env?.params.get(binding);
    if (value !== undefined) return value.expr !== undefined && isLive(value.module, value.expr, state, false, value.env);
    return bindingIsLive(binding, state, env);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return isRelativeLiteral(node.text, direct);
  if (ts.isTemplateExpression(node)) {
    if (node.head.text !== '') return isRelativeLiteral(node.head.text, direct);
    const first = node.templateSpans[0];
    return first !== undefined && isLive(module, first.expression, state, direct, env);
  }
  if (ts.isBinaryExpression(node)) {
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.PlusToken) return isLive(module, node.left, state, direct, env);
    if (kind === ts.SyntaxKind.QuestionQuestionToken || kind === ts.SyntaxKind.BarBarToken) {
      return isLive(module, node.left, state, direct, env) || isLive(module, node.right, state, direct, env);
    }
    return false;
  }
  if (ts.isConditionalExpression(node)) {
    return isLive(module, node.whenTrue, state, direct, env) || isLive(module, node.whenFalse, state, direct, env);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) => !ts.isSpreadElement(element) && isLive(module, element, state, false, env));
  }
  if (ts.isPropertyAccessExpression(node)) {
    if (isImportMeta(node.expression)) return ['url', 'dirname', 'filename'].includes(node.name.text);
    const exported = namespaceExport(module, node, state);
    if (exported !== undefined) return bindingIsLive(exported, state, undefined);
    return shapeIsLive(module, node.expression, node.name.text, state, 0, env);
  }
  if (ts.isNewExpression(node)) {
    const base = node.arguments?.[1];
    return calleeName(node.expression) === 'URL' && base !== undefined && isLive(module, base, state, false, env);
  }
  if (ts.isCallExpression(node)) return callIsLive(module, node, state, direct, env);
  return false;
}

function callIsLive(module: ModuleContext, node: ts.CallExpression, state: ScanState, direct: boolean, env: Env | undefined): boolean {
  const callee = node.expression;
  if (isProcessCwd(callee)) return true;
  const name = calleeName(callee);
  if (name !== undefined && FIRST_ARG_PATH_FUNCTIONS.has(name)) {
    const first = node.arguments[0];
    return first === undefined ? name === 'resolve' : isLive(module, first, state, direct, env);
  }
  if (ts.isPropertyAccessExpression(callee)) {
    const callback = node.arguments[0];
    if (ARRAY_MAPPERS.has(callee.name.text) && callback !== undefined && isFunctionNode(callback)) {
      return callReturnsLive(module, callback, module, [callee.expression], env, state);
    }
    if (ARRAY_PASSTHROUGH.has(callee.name.text)) return isLive(module, callee.expression, state, false, env);
  }
  const target = calledTarget(module, callee, state);
  return target !== undefined && callReturnsLive(target.module, target.fn, module, node.arguments, env, state);
}

/** The function a call runs, when it is declared in this module or reached by a relative import. */
function calledTarget(
  module: ModuleContext,
  callee: ts.Expression,
  state: ScanState,
): { module: ModuleContext; fn: FunctionNode } | undefined {
  let binding: Binding | undefined;
  if (ts.isIdentifier(callee)) binding = resolveIdentifier(module, callee);
  else if (ts.isPropertyAccessExpression(callee)) binding = namespaceExport(module, callee, state);
  for (let hops = 0; binding !== undefined && hops < SHAPE_DEPTH_LIMIT; hops++) {
    const fn = functionOf(binding);
    if (fn !== undefined) return { module: binding.module, fn };
    if (binding.kind !== 'import' || binding.specifier === undefined || binding.importedName === undefined) return undefined;
    binding = resolveExport(binding.module, binding.specifier, binding.importedName, state);
  }
  return undefined;
}

/** Evaluates a helper's return values with the parameters bound to this call's arguments. */
function callReturnsLive(
  fnModule: ModuleContext,
  fn: FunctionNode,
  callModule: ModuleContext,
  args: readonly ts.Expression[],
  callEnv: Env | undefined,
  state: ScanState,
): boolean {
  const env = bindParams(fnModule, fn, callModule, args, callEnv);
  if (env === undefined) return false;
  return guarded(fn, state, false, () => returnedExpressions(fn).some((value) => isLive(fnModule, value, state, false, env)));
}

/** Binds a function's parameters to one call's arguments, or to their defaults. */
function bindParams(
  fnModule: ModuleContext,
  fn: FunctionNode,
  callModule: ModuleContext,
  args: readonly ts.Expression[],
  callEnv: Env | undefined,
): Env | undefined {
  const depth = (callEnv?.depth ?? 0) + 1;
  if (depth > CALL_DEPTH_LIMIT) return undefined;
  const params = new Map<Binding, ParamValue>();
  fn.parameters.forEach((parameter, index) => {
    if (!ts.isIdentifier(parameter.name)) return;
    const binding = fnModule.scopes.get(fn)?.get(parameter.name.text);
    if (binding === undefined) return;
    const arg = args[index];
    params.set(
      binding,
      arg !== undefined
        ? { module: callModule, expr: arg, env: callEnv }
        : { module: fnModule, expr: parameter.initializer, env: undefined },
    );
  });
  return { params, depth };
}

/**
 * The first write inside an imported helper, or a helper it calls, whose
 * target is in the checkout when the parameters take this call's arguments.
 * Returns where that write is, or `undefined`.
 */
function helperWrite(fnModule: ModuleContext, fn: FunctionNode, env: Env, state: ScanState): string | undefined {
  const body = fn.body;
  if (body === undefined || state.active.has(fn)) return undefined;
  state.active.add(fn);
  let found: string | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isCallExpression(node)) {
      const sink = sinkPositions(fnModule, node);
      if (sink !== undefined) {
        const live = sink.positions.some((position) => {
          const argument = node.arguments[position];
          return argument !== undefined && isLive(fnModule, argument, state, true, env);
        });
        if (live) found = `${sink.name} in ${path.basename(fnModule.fileName)}:${lineOf(fnModule.sourceFile, node)}`;
      } else {
        const target = calledTarget(fnModule, node.expression, state);
        const followed = target !== undefined && isHelperModule(target.module, state) ? target : undefined;
        const inner = followed === undefined ? undefined : bindParams(followed.module, followed.fn, fnModule, node.arguments, env);
        if (followed !== undefined && inner !== undefined) found = helperWrite(followed.module, followed.fn, inner, state);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  state.active.delete(fn);
  return found;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function namespaceExport(module: ModuleContext, node: ts.PropertyAccessExpression, state: ScanState): Binding | undefined {
  if (!ts.isIdentifier(node.expression)) return undefined;
  const binding = resolveIdentifier(module, node.expression);
  if (binding?.kind !== 'import' || binding.importedName !== '*' || binding.specifier === undefined) return undefined;
  return resolveExport(binding.module, binding.specifier, node.name.text, state);
}

/**
 * Whether field `name` of the value `raw` (or of an element of it, when it is
 * an array) is a path inside the checkout.
 */
function shapeIsLive(
  module: ModuleContext,
  raw: ts.Expression,
  name: string,
  state: ScanState,
  depth: number,
  env: Env | undefined,
): boolean {
  if (depth > SHAPE_DEPTH_LIMIT) return false;
  const node = unwrap(raw);
  if (ts.isObjectLiteralExpression(node)) {
    for (const property of node.properties) {
      if (ts.isPropertyAssignment(property) && property.name.getText() === name) {
        return isLive(module, property.initializer, state, false, env);
      }
      if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
        return isLive(module, property.name, state, false, env);
      }
    }
    return false;
  }
  if (ts.isIdentifier(node)) {
    const binding = resolveIdentifier(module, node);
    if (binding === undefined) return false;
    const value = env?.params.get(binding);
    if (value !== undefined) {
      return value.expr !== undefined && shapeIsLive(value.module, value.expr, name, state, depth + 1, value.env);
    }
    return binding.init !== undefined && shapeIsLive(binding.module, binding.init, name, state, depth + 1, env);
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some(
      (element) => !ts.isSpreadElement(element) && shapeIsLive(module, element, name, state, depth + 1, env),
    );
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isPropertyAccessExpression(callee)) {
      const callback = node.arguments[0];
      if (ARRAY_MAPPERS.has(callee.name.text) && callback !== undefined && isFunctionNode(callback)) {
        return returnedExpressions(callback).some((value) => shapeIsLive(module, value, name, state, depth + 1, env));
      }
      if (ARRAY_PASSTHROUGH.has(callee.name.text)) return shapeIsLive(module, callee.expression, name, state, depth + 1, env);
    }
    const target = calledTarget(module, callee, state);
    if (target !== undefined) {
      return returnedExpressions(target.fn).some((value) => shapeIsLive(target.module, value, name, state, depth + 1, env));
    }
  }
  return false;
}

function bindingIsLive(binding: Binding, state: ScanState, env: Env | undefined): boolean {
  return guarded(binding, state, env === undefined, () => {
    const { module } = binding;
    if (binding.kind === 'import') {
      if (binding.specifier === undefined || binding.importedName === undefined || binding.importedName === '*') return false;
      const exported = resolveExport(module, binding.specifier, binding.importedName, state);
      return exported !== undefined && bindingIsLive(exported, state, undefined);
    }
    if (binding.kind === 'function') return false;
    if (binding.init !== undefined && !isFunctionNode(binding.init) && isLive(module, binding.init, state, false, env)) return true;
    if (binding.assignments.some((value) => isLive(module, value, state, false, env))) return true;
    if (binding.kind !== 'parameter' || binding.fn === undefined || binding.index === undefined) return false;
    const index = binding.index;
    return (module.callsByFunction.get(binding.fn) ?? []).some((call) => {
      const argument = call.arguments[index];
      return argument !== undefined && !isInside(call, module.scriptMain) && isLive(module, argument, state, false, undefined);
    });
  });
}

function loadModule(fromModule: ModuleContext, specifier: string, state: ScanState): ModuleContext | undefined {
  if (state.reader === undefined || !specifier.startsWith('.')) return undefined;
  const read = state.reader(fromModule.fileName, specifier);
  if (read === undefined) return undefined;
  const known = state.modules.get(read.fileName);
  if (known !== undefined) return known ?? undefined;
  let parsed: ModuleContext | null;
  try {
    parsed = buildModule(read.fileName, parseModuleOrThrow(read.fileName, read.source));
  } catch {
    parsed = null;
  }
  state.modules.set(read.fileName, parsed);
  return parsed ?? undefined;
}

/** The top-level binding that `name` exports from the module `specifier` names. */
function resolveExport(fromModule: ModuleContext, specifier: string, name: string, state: ScanState): Binding | undefined {
  const target = loadModule(fromModule, specifier, state);
  if (target === undefined) return undefined;
  const topLevel = target.scopes.get(target.sourceFile);
  const exported = target.exports.get(name);
  if (exported === undefined) {
    for (const statement of target.sourceFile.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause === undefined &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const found = resolveExport(target, statement.moduleSpecifier.text, name, state);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  }
  if (!ts.isExportSpecifier(exported)) return topLevel?.get(name);
  const localName = (exported.propertyName ?? exported.name).text;
  const declaration = exported.parent.parent;
  if (declaration.moduleSpecifier !== undefined && ts.isStringLiteral(declaration.moduleSpecifier)) {
    return resolveExport(target, declaration.moduleSpecifier.text, localName, state);
  }
  return topLevel?.get(localName);
}

function sinkPositions(
  module: ModuleContext,
  call: ts.CallExpression,
): { name: string; positions: readonly number[] } | undefined {
  const name = calleeName(call.expression);
  if (name === undefined) return undefined;
  if (ts.isIdentifier(call.expression)) {
    const binding = resolveIdentifier(module, call.expression);
    if (binding !== undefined && binding.kind !== 'import') return undefined;
  }
  const positions = SINK_TARGETS.get(name);
  if (positions !== undefined) return { name, positions };
  const flags = call.arguments[1];
  if (OPEN_SINKS.has(name) && flags !== undefined && ts.isStringLiteral(flags) && WRITE_FLAGS.test(flags.text)) {
    return { name, positions: [0] };
  }
  return undefined;
}

/** Reads a relative import from disk, trying the `.ts` source behind a `.js` specifier. */
export const diskModuleReader: ModuleReader = (fromFile, specifier) => {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, path.join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { fileName: candidate, source: readFileSync(candidate, 'utf8') };
    }
  }
  return undefined;
};

function isHelperModule(module: ModuleContext, state: ScanState): boolean {
  const roots = state.helperRoots;
  if (roots === undefined) return true;
  const file = path.resolve(module.fileName);
  return roots.some((root) => file.startsWith(path.resolve(root) + path.sep));
}

/** Scans one module for writes whose target is inside the live checkout. */
export function scanLiveCheckoutWrites(fileName: string, source: string, options: ScanOptions = {}): LiveCheckoutWriteScan {
  const sourceFile = parseModuleOrThrow(fileName, source);
  const module = buildModule(fileName, sourceFile);
  const state: ScanState = {
    reader: options.reader,
    helperRoots: options.helperRoots,
    modules: new Map([[fileName, module]]),
    memo: new Map(),
    active: new Set(),
  };
  let sinkCallCount = 0;
  const writes: LiveCheckoutWrite[] = [];
  const record = (node: ts.CallExpression, sink: string): void => {
    writes.push({
      file: fileName,
      line: lineOf(sourceFile, node),
      sink,
      text: node.getText(sourceFile).split('\n')[0] ?? '',
      gate: envGate(node),
    });
  };
  const visit = (node: ts.Node): void => {
    if (node === module.scriptMain) return;
    if (ts.isCallExpression(node)) {
      const sink = sinkPositions(module, node);
      if (sink !== undefined) {
        sinkCallCount++;
        const live = sink.positions.some((position) => {
          const argument = node.arguments[position];
          return argument !== undefined && isLive(module, argument, state, true, undefined);
        });
        if (live) record(node, sink.name);
      } else {
        const target = calledTarget(module, node.expression, state);
        const followed = target !== undefined && target.module !== module && isHelperModule(target.module, state);
        const env = followed ? bindParams(target.module, target.fn, module, node.arguments, undefined) : undefined;
        const found = followed && env !== undefined ? helperWrite(target.module, target.fn, env, state) : undefined;
        if (found !== undefined) record(node, `helper writes: ${found}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { sinkCallCount, writes };
}
