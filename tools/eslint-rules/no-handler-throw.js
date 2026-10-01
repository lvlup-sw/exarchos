// @ts-check
/**
 * @fileoverview A type-aware ESLint rule for the error-envelope contract of
 * registered MCP action handlers.
 *
 * The outer safety net of the dispatcher catches an escaped `throw` and flattens it to
 * `INTERNAL_ERROR`. Nothing crashes, but a meaningful `error.code` and the structured
 * fields are lost. This rule is a fidelity gate, not a crash-safety gate.
 *
 * The rule walks only the registration set: the functions of the `ACTION_HANDLERS` map
 * in `src/verbs/composite.ts`, and the special-branch functions that `handleOrchestrate`
 * dispatches. It derives the special branches from the dispatch code, so a new verb
 * needs no roster edit. Deep helpers stay out of scope, and they can throw.
 *
 * An unresolvable registration is a rule error, not a skip. The rule covers only literal
 * `throw` statements in the body of a handler. It does not follow an awaited rejection.
 */

import ts from 'typescript';
import path from 'node:path';

const ACTION_HANDLERS_MAP_NAME = 'ACTION_HANDLERS';
const ENVELOPE_WRAP_NAME = 'envelopeWrap';

/**
 * Classifies the first argument of an `envelopeWrap` call. `await handleX(...)` and
 * `handleX(...)` give `identifier`. A pre-built envelope gives `not-a-call`, and the
 * rule skips it. Any other callee gives `unsupported-callee`, which the rule reports,
 * because a dispatch without a name is not an exemption.
 */
function dispatchedCalleeIdentifier(argNode) {
  if (!argNode) return { kind: 'not-a-call' };
  const inner = argNode.type === 'AwaitExpression' ? argNode.argument : argNode;
  if (!inner || inner.type !== 'CallExpression') return { kind: 'not-a-call' };
  if (inner.callee.type !== 'Identifier') {
    return { kind: 'unsupported-callee', node: inner.callee };
  }
  return { kind: 'identifier', node: inner.callee };
}

/**
 * Collects the string literals that a dispatch-branch test compares with a discriminant.
 * `action === 'doctor'` gives `['doctor']`, and `action === 'a' || action === 'b'` gives `['a', 'b']`.
 * The discriminant must be an identifier or a member access, so `typeof action === 'string'` does not match.
 */
function dispatchLiteralsOf(testNode, out) {
  if (!testNode) return out;
  if (testNode.type === 'LogicalExpression') {
    dispatchLiteralsOf(testNode.left, out);
    dispatchLiteralsOf(testNode.right, out);
    return out;
  }
  if (testNode.type !== 'BinaryExpression') return out;
  if (testNode.operator !== '===' && testNode.operator !== '==') return out;
  const sides = [testNode.left, testNode.right];
  const literal = sides.find(s => s.type === 'Literal' && typeof s.value === 'string');
  const discriminant = sides.find(s => s.type === 'Identifier' || s.type === 'MemberExpression');
  if (literal && discriminant) out.push(literal.value);
  return out;
}

/**
 * Walks up from an `envelopeWrap` call to the branch that selects it, and returns the
 * action name of that branch. This derived census key replaces a hand-written roster,
 * so a new special verb is in the census when its branch exists. The walk stops at
 * the enclosing function.
 *
 * It matches the consequent of an `if`, `else if` chains included, and a `switch` case.
 * The `else` of an `if` does not match, because it does not name the verb.
 */
function deriveDispatchedAction(callNode, sourceCode) {
  const ancestors = sourceCode.getAncestors(callNode);
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const node = ancestors[i];
    const child = i + 1 < ancestors.length ? ancestors[i + 1] : callNode;
    if (isEstreeFunctionBoundary(node)) return undefined;
    if (node.type === 'IfStatement' && node.consequent === child) {
      const literals = dispatchLiteralsOf(node.test, []);
      if (literals.length > 0) return literals.join('|');
    }
    if (node.type === 'SwitchCase' && node.test?.type === 'Literal' && typeof node.test.value === 'string') {
      return node.test.value;
    }
  }
  return undefined;
}

function isEstreeFunctionBoundary(node) {
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  );
}

/**
 * True when a dispatched callee is a local or a parameter that holds an `ACTION_HANDLERS`
 * lookup, as in `const handler = ACTION_HANDLERS[action]`. The map walk covers that call.
 * A module-level binding is a named handler and stays subject to the attribution check.
 * A local must have an `ACTION_HANDLERS[...]` initializer, so a plain alias does not match.
 * A parameter matches, because it carries the table value one frame down.
 */
function isTableDispatchCallee(identifierNode, sourceCode) {
  const variable = resolveEstreeVariable(identifierNode, sourceCode);
  if (!variable) return false;
  if (variable.scope.type === 'module' || variable.scope.type === 'global') return false;
  if (variable.defs.length === 0) return false;
  return variable.defs.every(def => {
    if (def.type === 'Parameter') return true;
    if (def.type !== 'Variable') return false;
    return initializerReadsHandlerTable(def.node?.init);
  });
}

/**
 * True when `node` reads `ACTION_HANDLERS[...]`, through the guard and cast wrappers of
 * the real dispatcher. The live shape is
 * `typeof action === 'string' ? ACTION_HANDLERS[action] : undefined`.
 * A bare identifier alias is not a table read.
 */
function initializerReadsHandlerTable(node) {
  if (!node) return false;
  switch (node.type) {
    case 'MemberExpression':
      return (
        node.computed === true &&
        node.object?.type === 'Identifier' &&
        node.object.name === ACTION_HANDLERS_MAP_NAME
      );
    case 'ConditionalExpression':
      return (
        initializerReadsHandlerTable(node.consequent) ||
        initializerReadsHandlerTable(node.alternate)
      );
    case 'LogicalExpression':
      return (
        initializerReadsHandlerTable(node.left) || initializerReadsHandlerTable(node.right)
      );
    case 'TSNonNullExpression':
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
    case 'TSTypeAssertion':
      return initializerReadsHandlerTable(node.expression);
    default:
      return false;
  }
}

function resolveEstreeVariable(identifierNode, sourceCode) {
  let scope = sourceCode.getScope(identifierNode);
  while (scope) {
    const found = scope.variables.find(v => v.name === identifierNode.name);
    if (found) return found;
    scope = scope.upper;
  }
  return undefined;
}

/**
 * Resolves an `ACTION_HANDLERS` value or a special-branch callee to the `ts.Node` of
 * the handler function. It unwraps casts, takes the last argument of an adapter call,
 * and resolves an identifier through the type checker, across files too. An inline
 * function literal is the handler. For a zero-arg factory call, it resolves the factory
 * and unwraps the function literal that the factory returns.
 * It returns `undefined` when no function declaration resolves.
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
        const factoryFnNode = resolveHandlerFnNode(estreeNode.callee, services, checker);
        if (!factoryFnNode) return undefined;
        return factoryReturnedFunctionNode(factoryFnNode);
      }
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
 * Finds the function literal that the body of a zero-arg factory returns. It handles
 * a concise arrow body and a block with `return <function literal>`, and it does not
 * enter nested functions. It returns `undefined` for other shapes, which the rule reports.
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
 * Collects each `throw` statement under `root`, and does not enter a nested function,
 * method or class. A throw in a callback belongs to a different closure.
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

/**
 * Exemption: an AbortError or a cancellation. The abort handling of the caller observes
 * it, so a re-throw from a converting catch is deliberate. When type resolution fails,
 * the throw is not exempt.
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
    }
  }
  return false;
}

/**
 * Exemption: a fail-loud precondition guard. The `throw` is the only statement of an `if`
 * with no `else`, and the condition does not reference `args` or a local derived from it.
 * Such a guard checks the wiring of the handler, as in `if (!ctx) throw ...`.
 * A guard on `args` is domain validation and stays a violation.
 * When `firstParamName` cannot name the first parameter, as for a destructured one,
 * the throw is not exempt.
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
 * Collects the local names bound from `args` in one step, as in `const id = args.id`
 * or `const { id } = args`. It does not enter nested functions. It follows one hop only,
 * because a deeper heuristic gives false exemptions.
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

/**
 * Classifies one throw. A catch that holds a `return` converts to a `ToolResult`,
 * because the handler returns `Promise<ToolResult>`. Such a `try` guards each throw in
 * its `try` block. A throw in a catch clause or a `finally` block bubbles up, so only
 * an outer converting `try` guards it. An unguarded throw is abnormal.
 */
function classifyThrow(throwNode) {
  let child = throwNode;
  let node = throwNode.parent;
  while (node) {
    if (isFunctionBoundary(node)) break;
    if (ts.isTryStatement(node)) {
      if (node.catchClause && child === node.catchClause) {
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

/** Returns the `ts.ThrowStatement` nodes in the body of `fnNode` that can complete it abnormally, after the exemptions. */
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
        "Registered handler '{{handlerName}}' could not be resolved to a scannable function by any known shape (adaptXxx(handleYyy), a zero-arg factory, an 'as ActionHandler' cast, or an inline literal) — this rule cannot verify its envelope-fidelity (#1706 DR-1). Fix the rule's resolution for this shape rather than letting a registered handler drop off the census unscanned.",
      unattributedDispatch:
        "This envelopeWrap() dispatches directly to the named handler '{{handlerName}}', but the special-branch census cannot attribute it to an action: it sits in no `if (action === '...')` / `case '...':` dispatch branch (#1706 DR-1). An envelope-wrapped handler call the census can neither name nor scan is exactly the hole a hand-maintained handler list used to leave. Route it through a dispatch branch, or teach deriveDispatchedAction this shape.",
    },
  },
  /**
   * Without type information, the rule reports nothing. It cannot resolve handlers
   * across files, and a return-type heuristic is too imprecise.
   * An unresolvable map entry or derived branch reports `unresolvedHandler`.
   * A dispatch that no branch selects reports `unattributedDispatch`, unless it is the table dispatch.
   */
  create(context) {
    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
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
            context.report({ node: prop, messageId: 'unresolvedHandler', data: { handlerName } });
            continue;
          }
          reportAbnormalThrows(fnNode, handlerName, prop);
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== ENVELOPE_WRAP_NAME) return;
        const dispatched = dispatchedCalleeIdentifier(node.arguments[0]);
        if (dispatched.kind === 'not-a-call') return;
        if (dispatched.kind === 'unsupported-callee') {
          context.report({
            node,
            messageId: 'unattributedDispatch',
            data: { handlerName: context.sourceCode.getText(dispatched.node) },
          });
          return;
        }
        const callee = dispatched.node;

        const actionName = deriveDispatchedAction(node, context.sourceCode);
        if (!actionName) {
          if (isTableDispatchCallee(callee, context.sourceCode)) return;
          context.report({
            node,
            messageId: 'unattributedDispatch',
            data: { handlerName: callee.name },
          });
          return;
        }

        const fnNode = resolveHandlerFnNode(callee, services, checker);
        if (!fnNode) {
          context.report({
            node,
            messageId: 'unresolvedHandler',
            data: { handlerName: actionName },
          });
          return;
        }
        reportAbnormalThrows(fnNode, actionName, node);
      },
    };
  },
};

export default rule;
