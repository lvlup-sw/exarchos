// Finds test code whose verdict depends on how fast the runner is (#2029).
//
// Two shapes are found. A synchronous spawn blocks the vitest worker's event
// loop, so a slow host can expire the worker's 60 s RPC timer. An assertion on
// elapsed wall-clock time measures the runner, not the code. Both scans parse
// the source with the TypeScript compiler, so text inside a string, a template
// or a comment is never a finding.
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

/** The synchronous spawn wrappers in `src/utils/process.ts`. */
export const PROCESS_UTIL_SYNC_APIS: ReadonlySet<string> = new Set(['runCommandSync', 'spawnCommandSync']);

const CHILD_PROCESS_SPECIFIERS: ReadonlySet<string> = new Set(['node:child_process', 'child_process']);
const PROCESS_UTIL_SPECIFIER = /(^|\/)utils\/process(\.[cm]?[jt]s)?$/;
const SPAWN_HELPER_SPECIFIER = /(^|\/)test-helpers\/spawn(\.[cm]?[jt]s)?$/;
const UPPER_BOUND_MATCHERS: ReadonlySet<string> = new Set(['toBeLessThan', 'toBeLessThanOrEqual']);
const DURATION_PROPERTY = /^(duration|elapsed)(ms|_ms|millis|seconds)?$|(duration|elapsed)(ms|_ms)$/i;

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

/** The sync API names a module specifier carries, or none. */
function syncApisOf(specifier: string | undefined): ReadonlySet<string> | undefined {
  if (specifier === undefined) return undefined;
  if (CHILD_PROCESS_SPECIFIERS.has(specifier)) return CHILD_PROCESS_SYNC_APIS;
  if (PROCESS_UTIL_SPECIFIER.test(specifier)) return PROCESS_UTIL_SYNC_APIS;
  return undefined;
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

/** Local names bound to sync spawn APIs, namespaces that carry them, and local names of `isolatedSync`. */
interface SpawnBindings {
  readonly direct: Map<string, string>;
  readonly namespaces: Map<string, ReadonlySet<string>>;
  readonly isolators: Set<string>;
}

/** Collects the bindings that make a call a sync spawn. */
function spawnBindingsOf(file: ts.SourceFile): SpawnBindings {
  const bindings: SpawnBindings = { direct: new Map(), namespaces: new Map(), isolators: new Set() };
  walk(file, (node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause === undefined || clause.isTypeOnly) return;
      const specifier = specifierText(node.moduleSpecifier);
      const apis = syncApisOf(specifier);
      const named = clause.namedBindings;
      if (apis !== undefined && clause.name !== undefined) bindings.namespaces.set(clause.name.text, apis);
      if (apis !== undefined && named !== undefined && ts.isNamespaceImport(named)) {
        bindings.namespaces.set(named.name.text, apis);
      }
      if (named === undefined || !ts.isNamedImports(named)) return;
      for (const element of named.elements) {
        if (element.isTypeOnly) continue;
        const imported = (element.propertyName ?? element.name).text;
        if (apis?.has(imported) === true) bindings.direct.set(element.name.text, imported);
        if (specifier !== undefined && SPAWN_HELPER_SPECIFIER.test(specifier) && imported === 'isolatedSync') {
          bindings.isolators.add(element.name.text);
        }
      }
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const apis = syncApisOf(dynamicModuleOf(node.initializer));
      if (apis === undefined) return;
      if (ts.isIdentifier(node.name)) {
        bindings.namespaces.set(node.name.text, apis);
        return;
      }
      if (!ts.isObjectBindingPattern(node.name)) return;
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if (!ts.isIdentifier(key) || !ts.isIdentifier(element.name)) continue;
        if (apis.has(key.text)) bindings.direct.set(element.name.text, key.text);
      }
    }
  });
  return bindings;
}

/** The sync API a call invokes, or undefined when the call is not a sync spawn. */
function syncApiCalled(call: ts.CallExpression, bindings: SpawnBindings): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return bindings.direct.get(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const name = callee.name.text;
  const receiver = unwrap(callee.expression);
  if (ts.isIdentifier(receiver)) {
    return bindings.namespaces.get(receiver.text)?.has(name) === true ? name : undefined;
  }
  return syncApisOf(dynamicModuleOf(receiver))?.has(name) === true ? name : undefined;
}

/** Whether the call is the whole body of an arrow passed first to `isolatedSync`. */
function isIsolated(call: ts.CallExpression, bindings: SpawnBindings): boolean {
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
 * `execSync` or `spawnSync` from `node:child_process`, or `runCommandSync` or
 * `spawnCommandSync` from `src/utils/process.ts`. Aliased, namespaced and
 * dynamically imported bindings count. A call that is the whole body of an
 * arrow passed to `isolatedSync` does not.
 */
export function findSyncSpawnCalls(source: string, fileName = 'module.ts'): RunnerDependence[] {
  const file = parse(source, fileName);
  const bindings = spawnBindingsOf(file);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  const constants = numericConstantsOf(file);
  const findings: RunnerDependence[] = [];
  walk(file, (node) => {
    if (!ts.isCallExpression(node)) return;
    const api = syncApiCalled(node, bindings);
    if (api === undefined || isIsolated(node, bindings)) return;
    const timeoutMs = statedTimeout(node, constants);
    findings.push({ line: lineOf(file, node), detail: api, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  });
  return findings;
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
