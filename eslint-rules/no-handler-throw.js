// @ts-check
/**
 * @fileoverview Custom `@typescript-eslint` rule enforcing the error-envelope
 * contract (#1706 DR-1, INV-5b output-contract / INV-17 response-economy) on
 * REGISTERED MCP action handlers.
 *
 * Why this exists: `dispatch/core/dispatch.ts`'s outer safety net already catches any
 * escaped `throw` and flattens it to `{ success:false, error:{ code:
 * 'INTERNAL_ERROR', message } }`. Nothing crashes — but a meaningful
 * `error.code` (e.g. `MERGE_CONFLICT`) and structured fields (`suggestedFix`,
 * `unmetGates`, ...) are silently discarded, leaving the agent on the other
 * end with an un-actionable generic code. This is a fidelity gate, not a
 * crash-safety gate.
 *
 * Scope: the rule ONLY walks the "registration set" — the functions
 * `servers/exarchos-mcp/src/orchestrate/composite.ts`'s `ACTION_HANDLERS` map
 * resolves to, plus the six special-cased branch functions `handleOrchestrate`
 * dispatches directly (`describe`/`doctor`/`onboard`/`invariants_scaffold`/
 * `invariants_add`/`runbook`). This is intentionally a CLOSED, PRECISE set —
 * NOT "any function that returns ToolResult" (which would over-select the
 * deep helpers the registration set is allowed to call and that are allowed
 * to throw, e.g. `execute-merge.ts`'s internals, which the public
 * `merge_orchestrate` handler is expected to catch and convert).
 *
 * Handler identification is TYPE-AWARE: `ACTION_HANDLERS` values are usually
 * `adaptXxx(handleYyy)` call expressions — the rule resolves the WRAPPED
 * handler (`handleYyy`), which may live in a different file, via the
 * TypeScript checker's symbol resolution (`parserOptions.project` gives it a
 * full `ts.Program`). Other value shapes also occur in the real map and are
 * resolved directly: a bare identifier cast (`fooHandler as ActionHandler`),
 * an inline arrow/function literal assigned straight into the map (e.g.
 * `create_issue`'s custom closure) — the resolver treats that literal itself
 * as the handler — and a ZERO-ARG factory call (`adaptSetupWorktree()`),
 * where there is no handler argument to unwrap: the handler logic lives in
 * the closure the factory's OWN body returns, so the resolver follows the
 * callee to its declaration and then unwraps ITS `return` statement.
 *
 * Resolution failure is FAIL-LOUD, not fail-open: every `ACTION_HANDLERS`
 * property is a registered handler by construction, so if none of the known
 * shapes above can resolve a scannable function for it, the rule reports a
 * rule error on that map entry (`unresolvedHandler`) rather than silently
 * skipping it — an unscannable entry is a gate hole, and a gate must fail
 * closed, not drop registrations off the census.
 *
 * CAVEAT (review #1706): this gate covers literal `throw` statements
 * reachable in a handler's own body — it does NOT cover an un-converted
 * awaited rejection (a handler that `await`s a throwing helper with no
 * surrounding `try`/`catch`, e.g. `handleMergeOrchestrate` awaiting
 * `executeMergeFn(...)` outside a catch). Detecting that would need
 * following the awaited call's own throw surface, which this rule
 * deliberately does not do (see the DR-1 "registration set" scope note
 * above — deep helpers are allowed to throw). Treat this as covering literal
 * handler-body throws only, not a full INV-5b guarantee against every path
 * an unconverted rejection can escape a handler — a possible future
 * enhancement, not a claim this rule currently makes.
 */

import ts from 'typescript';
import path from 'node:path';

/**
 * The six branches `handleOrchestrate` special-cases OUTSIDE the
 * `ACTION_HANDLERS` map (composite.ts:639-715, dispatched via the same
 * `envelopeWrap(await handleXxx(...), startedAt)` shape as the map's own
 * dispatch at :748). Keyed by the imported handler function's name; the
 * value is the human-facing action name used in the census/report message.
 * This is a closed set BY DESIGN (Technical Design, #1706 spec) — matching by
 * name here (rather than "any envelopeWrap(await X(...))" call) keeps the
 * rule from over-selecting unrelated envelopeWrap call sites (e.g. the
 * ACTION_HANDLERS dispatch itself at composite.ts:748, which calls a
 * *variable* `handler`, not a named import, and so never matches this set).
 */
const SPECIAL_BRANCH_ACTIONS = new Map([
  ['handleDescribe', 'describe'],
  ['handleDoctor', 'doctor'],
  ['handleOnboard', 'onboard'],
  ['handleScaffold', 'invariants_scaffold'],
  ['handleAdd', 'invariants_add'],
  ['handleRunbook', 'runbook'],
]);

const ACTION_HANDLERS_MAP_NAME = 'ACTION_HANDLERS';
const ENVELOPE_WRAP_NAME = 'envelopeWrap';

// ─── ts.Node helpers (registration-set resolution) ─────────────────────────

/**
 * Resolves an ESTree node found as an `ACTION_HANDLERS` property value (or a
 * special-branch call's callee) to the `ts.Node` of the actual handler
 * function — unwrapping `adaptXxx(handleYyy)` call expressions and `as`
 * casts, and resolving identifiers to their declaration (possibly cross-file)
 * via the type checker. Returns `undefined` when no function-shaped
 * declaration can be resolved (e.g. the identifier resolves to something that
 * isn't a function — defensively skipped rather than crashing the rule).
 */
function resolveHandlerFnNode(estreeNode, services, checker) {
  if (!estreeNode) return undefined;
  switch (estreeNode.type) {
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return resolveHandlerFnNode(estreeNode.expression, services, checker);
    case 'CallExpression': {
      if (estreeNode.arguments.length === 0) {
        // Zero-arg factory shape (composite.ts's `adaptSetupWorktree()`): no
        // handler argument is passed — the handler logic lives in the
        // closure the factory's OWN body returns (this is where an escaping
        // throw would actually live). Resolve the callee to its
        // declaration, then unwrap the function/arrow literal its body
        // returns.
        const factoryFnNode = resolveHandlerFnNode(estreeNode.callee, services, checker);
        if (!factoryFnNode) return undefined;
        return factoryReturnedFunctionNode(factoryFnNode);
      }
      // adaptXxx(..., handleYyy) — the handler is always the LAST argument
      // across every adapter shape in composite.ts (adapt/adaptCtx/
      // adaptWithEventStore/adaptLadderGate/...).
      const lastArg = estreeNode.arguments[estreeNode.arguments.length - 1];
      return resolveHandlerFnNode(lastArg, services, checker);
    }
    case 'Identifier': {
      const tsNode = services.esTreeNodeToTSNodeMap.get(estreeNode);
      if (!tsNode) return undefined;
      let symbol = checker.getSymbolAtLocation(tsNode);
      if (!symbol) return undefined;
      if (symbol.flags & ts.SymbolFlags.Alias) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      return functionNodeFromSymbol(symbol);
    }
    case 'ArrowFunctionExpression':
    case 'FunctionExpression':
      // An inline closure assigned directly as the map value (e.g.
      // `create_issue: async (args, _stateDir, ctx) => {...}`) IS the
      // handler — no further resolution needed.
      return services.esTreeNodeToTSNodeMap.get(estreeNode);
    default:
      return undefined;
  }
}

/** Finds the function-with-a-body declaration behind a resolved symbol. */
function functionNodeFromSymbol(symbol) {
  const decls = symbol.getDeclarations?.() ?? [];
  for (const decl of decls) {
    if (ts.isFunctionDeclaration(decl) && decl.body) return decl;
    if (
      ts.isVariableDeclaration(decl) &&
      decl.initializer &&
      (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
    ) {
      return decl.initializer;
    }
  }
  return undefined;
}

/**
 * Given a zero-arg factory's own resolved `ts.Node` (e.g. `adaptSetupWorktree`'s
 * `FunctionDeclaration`), finds the function/arrow literal ITS body returns —
 * the closure a zero-arg-factory `ACTION_HANDLERS` entry (`adaptSetupWorktree()`)
 * actually dispatches through at runtime. Function-scope-local: does not
 * cross into a nested function's own `return`. Handles both a concise arrow
 * body (`() => async (...) => {...}`) and a block body with an explicit
 * `return <function literal>;` statement. Returns `undefined` when the
 * factory's body doesn't return a function literal by either shape (this
 * propagates up as an unresolved handler — fail-loud, not fail-open).
 */
function factoryReturnedFunctionNode(factoryFnNode) {
  const body = functionBody(factoryFnNode);
  if (!body) return undefined;
  if (!ts.isBlock(body)) {
    return ts.isArrowFunction(body) || ts.isFunctionExpression(body) ? body : undefined;
  }
  let found;
  (function walk(node) {
    if (found || !node) return;
    if (node !== body && isFunctionBoundary(node)) return;
    if (
      ts.isReturnStatement(node) &&
      node.expression &&
      (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression))
    ) {
      found = node.expression;
      return;
    }
    ts.forEachChild(node, walk);
  })(body);
  return found;
}

// ─── Throw discovery (function-scope-local, no interprocedural follow) ─────

function isFunctionBoundary(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node)
  );
}

function functionBody(fnNode) {
  if (ts.isArrowFunction(fnNode) || ts.isFunctionExpression(fnNode) || ts.isFunctionDeclaration(fnNode)) {
    return fnNode.body;
  }
  return undefined;
}

function firstParamName(fnNode) {
  const p = fnNode.parameters?.[0];
  if (!p || !ts.isIdentifier(p.name)) return undefined;
  return p.name.text;
}

/**
 * Collects every `throw` statement reachable from `root` WITHOUT crossing
 * into a nested function/method/class scope — a throw inside a callback the
 * handler passes somewhere is a different closure, not part of the handler's
 * own abnormal-completion surface.
 */
function collectThrowsInScope(root) {
  const throws = [];
  (function walk(node) {
    if (!node) return;
    if (isFunctionBoundary(node)) return;
    if (ts.isThrowStatement(node)) {
      throws.push(node);
      return;
    }
    ts.forEachChild(node, walk);
  })(root);
  return throws;
}

// ─── Exemption classes (DR-3 — each documented with its one-line rationale) ─

/**
 * Exemption: AbortError / cancellation. A cancellation signal is not a
 * domain failure the caller needs a coded `ToolResult.error` for — it is
 * infrastructure plumbing the caller's OWN abort handling is expected to
 * observe, so re-throwing it (typically from inside a catch that converts
 * every other error) is deliberate, not an envelope-fidelity bug.
 */
function isAbortErrorThrow(throwNode, checker) {
  const expr = throwNode.expression;
  if (!expr) return false;
  if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && /AbortError/i.test(expr.expression.text)) {
    return true;
  }
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr)) {
    try {
      const type = checker.getTypeAtLocation(expr);
      const symbolName = type?.symbol?.name ?? type?.aliasSymbol?.name;
      if (symbolName && /AbortError/i.test(symbolName)) return true;
    } catch {
      // Type resolution can fail on synthetic/ambient nodes — treat as
      // "not exempt" rather than let the rule crash on a best-effort check.
    }
  }
  return false;
}

/**
 * Exemption: fail-loud precondition guards. A `throw` that is the sole
 * statement of a no-`else` `if`, whose condition never mentions the
 * handler's own `args` parameter (or a local bound directly from it, e.g.
 * `const id = args.id;`), reads as a programmer-error assertion about the
 * handler's OWN wiring (e.g. composite.ts's `if (!ctx) throw new
 * Error('DispatchContext required for this handler')`) — not a domain-input
 * validation failure. Domain validation (`if (!args.id) throw ...`, or
 * `const id = args.id; if (!id) throw ...`) still counts as a violation: it
 * DOES reference `args` (directly or via a derived local), so it must become
 * a ToolResult.error instead.
 *
 * When the handler's first-param shape is unrecognized (e.g. destructured —
 * `async ({ featureId }, ...) =>` — `firstParamName` can't name a single
 * `args` identifier for it), this defaults to **NON-exempt**: an unknown
 * shape is scanned, not silently skipped, so a genuine destructured-arg
 * validation throw is still reported rather than fail-opening past the gate.
 */
function isFailLoudPreconditionGuard(throwNode, argsParamName, argsDerivedNames) {
  const ifStmt = enclosingIfGuard(throwNode);
  if (!ifStmt || ifStmt.elseStatement) return false;
  if (!argsParamName) return false;
  if (referencesIdentifier(ifStmt.expression, argsParamName)) return false;
  for (const derived of argsDerivedNames ?? []) {
    if (referencesIdentifier(ifStmt.expression, derived)) return false;
  }
  return true;
}

/**
 * Collects local binding names that are derived DIRECTLY from the handler's
 * `args` parameter — `const id = args.id;`, `const { id } = args;`, `const
 * [first] = args.list;` — so `isFailLoudPreconditionGuard` can recognize a
 * validation guard that aliases `args` into a local before testing it, not
 * just one that references `args` inline. Function-scope-local (does not
 * cross into a nested function's own locals), and only follows ONE hop
 * (`args.foo` → `foo`, not `foo` → `bar` if `bar` were later derived from
 * `foo`) — deliberately shallow: the real handlers in composite.ts alias at
 * most one level deep, and a deeper heuristic risks false "exempt" verdicts
 * this DR-3 class explicitly exists to avoid.
 */
function collectArgsDerivedNames(body, argsParamName) {
  const names = new Set();
  if (!argsParamName) return names;
  (function walk(node) {
    if (!node) return;
    if (isFunctionBoundary(node)) return;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      referencesIdentifier(node.initializer, argsParamName)
    ) {
      collectBoundNames(node.name, names);
    }
    ts.forEachChild(node, walk);
  })(body);
  return names;
}

function collectBoundNames(bindingName, names) {
  if (ts.isIdentifier(bindingName)) {
    names.add(bindingName.text);
    return;
  }
  if (ts.isObjectBindingPattern(bindingName) || ts.isArrayBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (ts.isBindingElement(element)) collectBoundNames(element.name, names);
    }
  }
}

function enclosingIfGuard(throwNode) {
  const parent = throwNode.parent;
  if (!parent) return undefined;
  if (ts.isIfStatement(parent) && parent.thenStatement === throwNode) return parent;
  if (
    ts.isBlock(parent) &&
    parent.statements.length === 1 &&
    parent.statements[0] === throwNode &&
    parent.parent &&
    ts.isIfStatement(parent.parent) &&
    parent.parent.thenStatement === parent
  ) {
    return parent.parent;
  }
  return undefined;
}

function referencesIdentifier(node, name) {
  let found = false;
  (function walk(n) {
    if (found || !n) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  })(node);
  return found;
}

// ─── Position classification: does this throw abnormally complete the handler? ─

/**
 * Exemption (structural, not a separate "class"): a `try` whose `catch`
 * converts to a `ToolResult` (heuristic: the catch block contains a
 * `return` — the handler's declared/inferred return type is `Promise<
 * ToolResult>`, so any reachable `return` inside it necessarily returns one)
 * guards every throw inside its `try` block. A throw inside a `catch` clause
 * is likewise exempt if THAT catch's enclosing try is itself nested inside
 * an outer guarding try (re-caught); otherwise it is the DR-1
 * "catch-clause throw not re-caught" violation.
 */
function classifyThrow(throwNode) {
  let child = throwNode;
  let node = throwNode.parent;
  while (node) {
    if (isFunctionBoundary(node)) break;
    if (ts.isTryStatement(node)) {
      if (node.catchClause && child === node.catchClause) {
        // Bubbling out of a catch clause: keep walking — an OUTER converting
        // try/catch re-catches this re-throw.
        child = node;
        node = node.parent;
        continue;
      }
      if (child === node.tryBlock) {
        if (node.catchClause && catchConverts(node.catchClause)) {
          return { abnormal: false };
        }
        child = node;
        node = node.parent;
        continue;
      }
      // Inside `finally` (or an otherwise-unrelated position under this
      // TryStatement) — not guarded by THIS try's own catch; keep bubbling.
      child = node;
      node = node.parent;
      continue;
    }
    child = node;
    node = node.parent;
  }
  return { abnormal: true };
}

function catchConverts(catchClause) {
  let hasReturn = false;
  (function walk(node) {
    if (hasReturn || !node) return;
    if (isFunctionBoundary(node)) return;
    if (ts.isReturnStatement(node)) {
      hasReturn = true;
      return;
    }
    ts.forEachChild(node, walk);
  })(catchClause.block);
  return hasReturn;
}

/**
 * Returns the `ts.ThrowStatement` nodes in `fnNode`'s own body that can
 * abnormally complete it, with the DR-3 exemption classes already applied.
 */
function findAbnormalThrows(fnNode, checker) {
  const body = functionBody(fnNode);
  if (!body || !ts.isBlock(body)) return [];
  const argsParamName = firstParamName(fnNode);
  const argsDerivedNames = collectArgsDerivedNames(body, argsParamName);
  const throwNodes = collectThrowsInScope(body);
  const abnormal = [];
  for (const throwNode of throwNodes) {
    if (isAbortErrorThrow(throwNode, checker)) continue;
    if (isFailLoudPreconditionGuard(throwNode, argsParamName, argsDerivedNames)) continue;
    if (classifyThrow(throwNode).abnormal) abnormal.push(throwNode);
  }
  return abnormal;
}

function relativeLocation(tsNode) {
  const sf = tsNode.getSourceFile();
  const { line } = sf.getLineAndCharacterOfPosition(tsNode.getStart());
  return `${path.relative(process.cwd(), sf.fileName)}:${line + 1}`;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Registered MCP action handlers must return ToolResult.error, never let a throw abnormally complete them (#1706 DR-1).',
    },
    schema: [],
    messages: {
      abnormalThrow:
        "Handler '{{handlerName}}' can abnormally complete via a throw at {{location}} — return ToolResult.error (with a meaningful error.code), not a raw throw. core/dispatch.ts's safety net would flatten this to a generic INTERNAL_ERROR, discarding the code and structured fields (suggestedFix/unmetGates/...).",
      unresolvedHandler:
        "ACTION_HANDLERS entry '{{handlerName}}' could not be resolved to a scannable function by any known shape (adaptXxx(handleYyy), a zero-arg factory, an 'as ActionHandler' cast, or an inline literal) — this rule cannot verify its envelope-fidelity (#1706 DR-1). Fix the rule's resolution for this shape rather than letting a registered handler drop off the census unscanned.",
    },
  },
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      // No type information available (parserOptions.project not set for
      // this file) — the rule cannot resolve cross-file handler references
      // without it. Stay silent rather than fall back to an imprecise
      // return-type heuristic (the spec explicitly rejects that approach).
      return {};
    }
    const checker = services.program.getTypeChecker();
    const reportedKeys = new Set();

    function reportAbnormalThrows(fnNode, handlerName, reportNode) {
      for (const throwNode of findAbnormalThrows(fnNode, checker)) {
        const key = `${throwNode.getSourceFile().fileName}#${throwNode.getStart()}`;
        if (reportedKeys.has(key)) continue;
        reportedKeys.add(key);
        context.report({
          node: reportNode,
          messageId: 'abnormalThrow',
          data: { handlerName, location: relativeLocation(throwNode) },
        });
      }
    }

    function propertyKeyName(prop) {
      if (prop.key.type === 'Identifier') return prop.key.name;
      if (prop.key.type === 'Literal') return String(prop.key.value);
      return '<computed>';
    }

    return {
      VariableDeclarator(node) {
        if (node.id.type !== 'Identifier' || node.id.name !== ACTION_HANDLERS_MAP_NAME) return;
        if (!node.init || node.init.type !== 'ObjectExpression') return;
        for (const prop of node.init.properties) {
          if (prop.type !== 'Property') continue;
          const handlerName = propertyKeyName(prop);
          const fnNode = resolveHandlerFnNode(prop.value, services, checker);
          if (!fnNode) {
            // Fail-loud, not fail-open: every ACTION_HANDLERS entry IS a
            // registered handler by construction — an entry the resolver
            // can't map to a scannable function is a gate hole, not a
            // legitimate "nothing to scan" case.
            context.report({ node: prop, messageId: 'unresolvedHandler', data: { handlerName } });
            continue;
          }
          reportAbnormalThrows(fnNode, handlerName, prop);
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== ENVELOPE_WRAP_NAME) return;
        const firstArg = node.arguments[0];
        if (!firstArg) return;
        const awaited = firstArg.type === 'AwaitExpression' ? firstArg.argument : firstArg;
        if (!awaited || awaited.type !== 'CallExpression' || awaited.callee.type !== 'Identifier') return;
        const actionName = SPECIAL_BRANCH_ACTIONS.get(awaited.callee.name);
        if (!actionName) return;
        const fnNode = resolveHandlerFnNode(awaited.callee, services, checker);
        if (!fnNode) return;
        reportAbnormalThrows(fnNode, actionName, node);
      },
    };
  },
};

export default rule;
