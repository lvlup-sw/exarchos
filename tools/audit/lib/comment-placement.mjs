// @ts-check
/**
 * @fileoverview Where a comment block sits, and whether the placement rule allows it there.
 *
 * Allowed placements: the file header, a `/** *\/` description that is attached to a module-level
 * declaration, a member, a module-level literal element, or a test call. A module-level `@typedef`
 * or `@callback` block is itself a declaration, so it needs no target. Every other block gets one
 * check id, in this precedence: banner, trailing, in-body, non-jsdoc, detached, floating. The input
 * is the ESTree that ESLint gives a rule, so the rule and the gate agree.
 */

import { isDirective, isTypeAnnotation } from './comment-baseline.mjs';

/** The roster name of the placement rule. */
export const PLACEMENT_RULE = 'comment-placement';

/** Every placement violation, in precedence order after the allowed placements. */
export const PLACEMENT_CHECKS = Object.freeze(['banner', 'trailing', 'in-body', 'non-jsdoc', 'detached', 'floating']);

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

const DECLARATION_TYPES = new Set([
  'VariableDeclaration',
  'FunctionDeclaration',
  'TSDeclareFunction',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSEnumDeclaration',
  'TSModuleDeclaration',
  'ExportDefaultDeclaration',
  'TSExportAssignment',
]);

const MEMBER_TYPES = new Set([
  'MethodDefinition',
  'PropertyDefinition',
  'AccessorProperty',
  'TSAbstractMethodDefinition',
  'TSAbstractPropertyDefinition',
  'TSAbstractAccessorProperty',
  'StaticBlock',
  'TSIndexSignature',
  'TSPropertySignature',
  'TSMethodSignature',
  'TSCallSignatureDeclaration',
  'TSConstructSignatureDeclaration',
  'TSEnumMember',
  'TSParameterProperty',
]);

const TYPE_DECLARATION_TAG = /@(?:typedef|callback)\b/;
const DECORATION_RUN = /[─━═\-=~_*#]{4,}/;
const DECORATION_ONLY = /^[\s─━═\-=~_*#+./\\|:<>·•]{3,}$/;
const TITLED_RULE = /^(?:[─━═]{2,}|[─━═\-=~_*#]{3,})\s+\S.*\s+(?:[─━═]{2,}|[─━═\-=~_*#]{3,})$/;

/**
 * An ESTree node, as far as this module reads it.
 *
 * @typedef {{ type: string, range: [number, number], [key: string]: unknown }} EsNode
 */

/**
 * One comment as ESLint gives it, directives included.
 *
 * @typedef {{ type: string, value: string, range: readonly [number, number] }} RawComment
 */

/**
 * The placement of one block: allowed, or the check id that it breaks.
 *
 * @typedef {{ allowed: true, kind: 'header' | 'description' } | { allowed: false, checkId: string }} Placement
 */

/**
 * Whether a value is an ESTree node.
 *
 * @param {unknown} value
 * @returns {value is EsNode}
 */
function isNode(value) {
  if (value === null || typeof value !== 'object') return false;
  const candidate = /** @type {{ type?: unknown, range?: unknown }} */ (value);
  return typeof candidate.type === 'string' && Array.isArray(candidate.range);
}

/**
 * Index an AST: each node's parent, the outermost node at each start offset, and the function-like nodes.
 *
 * @param {EsNode} ast
 * @returns {{ parents: Map<EsNode, EsNode>, outermostAt: Map<number, EsNode>, functions: EsNode[] }}
 */
function indexAst(ast) {
  /** @type {Map<EsNode, EsNode>} */
  const parents = new Map();
  /** @type {Map<number, EsNode>} */
  const outermostAt = new Map();
  /** @type {EsNode[]} */
  const functions = [];
  /** @type {[EsNode, EsNode | undefined][]} */
  const stack = [[ast, undefined]];
  while (stack.length > 0) {
    const [node, parent] = /** @type {[EsNode, EsNode | undefined]} */ (stack.pop());
    if (parent !== undefined) parents.set(node, parent);
    if (!outermostAt.has(node.range[0]) && node.type !== 'Program') outermostAt.set(node.range[0], node);
    if (FUNCTION_TYPES.has(node.type) || node.type === 'StaticBlock') functions.push(node);
    /** @type {EsNode[]} */
    const children = [];
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent' || key === 'range' || key === 'loc' || key === 'tokens' || key === 'comments') continue;
      if (Array.isArray(value)) for (const item of value) if (isNode(item)) children.push(item);
      if (isNode(value)) children.push(value);
    }
    children.sort((a, b) => b.range[0] - a.range[0]);
    for (const child of children) stack.push([child, node]);
  }
  return { parents, outermostAt, functions };
}

/**
 * The range of a function-like node that counts as its body.
 *
 * @param {EsNode} fn
 * @returns {[number, number] | undefined}
 */
function bodyRange(fn) {
  if (fn.type === 'StaticBlock') return fn.range;
  const body = fn.body;
  return isNode(body) ? body.range : undefined;
}

/**
 * The root identifier name of a call's callee chain, through members, curried calls and tagged templates.
 *
 * @param {unknown} callee
 * @returns {string | undefined}
 */
function calleeRoot(callee) {
  let current = callee;
  while (isNode(current)) {
    if (current.type === 'Identifier') return /** @type {string} */ (current.name);
    if (current.type === 'MemberExpression') current = current.object;
    else if (current.type === 'CallExpression') current = current.callee;
    else if (current.type === 'TaggedTemplateExpression') current = current.tag;
    else return undefined;
  }
  return undefined;
}

/**
 * Whether a node is a call to a test callee.
 *
 * @param {unknown} node
 * @param {ReadonlySet<string>} callees
 * @returns {boolean}
 */
function isTestCallExpression(node, callees) {
  if (!isNode(node) || node.type !== 'CallExpression') return false;
  const root = calleeRoot(node.callee);
  return root !== undefined && callees.has(root);
}

/**
 * Whether a block is a section banner. Every line is decoration, a short title, or a title with a
 * decoration run on each side, such as `── Setup ──`.
 *
 * @param {string} raw
 * @returns {boolean}
 */
export function isBanner(raw) {
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:\/\/+|\/\*+|\*+(?!\/))\s?/, '').replace(/\*+\/\s*$/, '').trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0 || !lines.some((line) => DECORATION_RUN.test(line) || TITLED_RULE.test(line))) return false;
  return lines.every((line) => {
    if (DECORATION_ONLY.test(line)) return true;
    if (TITLED_RULE.test(line)) return line.length <= 120;
    const title = line.replace(/[─━═\-=~_*#]{2,}/g, ' ').trim();
    return title.length <= 60 && (DECORATION_RUN.test(line) || lines.length <= 3);
  });
}

/**
 * Classify the placement of every block in a file.
 *
 * A block attaches to the outermost node that starts after it. Whitespace, directives and type-only
 * JSDoc in between are transparent, and a blank line breaks the attachment.
 *
 * @param {object} input
 * @param {EsNode} input.ast The ESTree Program.
 * @param {readonly RawComment[]} input.comments Every comment in the file, directives included.
 * @param {string} input.text The source text.
 * @param {readonly import('./comment-baseline.mjs').CommentBlock[]} input.blocks
 * @param {readonly string[]} input.testCallees
 * @returns {Placement[]} One placement per block, in the same order.
 */
export function classifyPlacements({ ast, comments, text, blocks, testCallees }) {
  const { parents, outermostAt, functions } = indexAst(ast);
  const callees = new Set(testCallees);
  /** @type {Map<number, RawComment>} */
  const commentAt = new Map(comments.map((comment) => [comment.range[0], comment]));
  const body = /** @type {EsNode[]} */ (Array.isArray(ast.body) ? ast.body : []);
  const firstStatement = body[0];

  /** @param {EsNode} node @returns {boolean} */
  const isModuleLevel = (node) => {
    const parent = parents.get(node);
    if (parent === undefined) return false;
    if (parent.type === 'Program') return true;
    if (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') return isModuleLevel(parent);
    if (parent.type === 'TSModuleBlock') {
      const owner = parents.get(parent);
      return owner !== undefined && isModuleLevel(owner);
    }
    return false;
  };

  /** @param {EsNode} fn */
  const isTestCallback = (fn) => {
    const parent = parents.get(fn);
    if (parent === undefined || parent.type !== 'CallExpression' || !Array.isArray(parent.arguments)) return false;
    return parent.arguments.includes(fn) && isTestCallExpression(parent, callees);
  };

  /** @param {EsNode} node */
  const isTestCallStatement = (node) => node.type === 'ExpressionStatement' && isTestCallExpression(node.expression, callees);

  /** @param {EsNode} target */
  const isDescribable = (target) => {
    if (target.type === 'ExportNamedDeclaration') return isNode(target.declaration) && isModuleLevel(target);
    if (DECLARATION_TYPES.has(target.type)) return isModuleLevel(target);
    if (MEMBER_TYPES.has(target.type)) return true;
    const parent = parents.get(target);
    if (parent !== undefined && (parent.type === 'ObjectExpression' || parent.type === 'ArrayExpression')) return true;
    return isTestCallStatement(target);
  };

  /** @param {import('./comment-baseline.mjs').CommentBlock} block @returns {EsNode | 'detached' | 'none'} */
  const attachedTarget = (block) => {
    let pos = block.end;
    for (;;) {
      while (pos < text.length && /\s/.test(text.charAt(pos))) pos += 1;
      const comment = commentAt.get(pos);
      if (comment === undefined) break;
      const skippable = isDirective(comment.value) || (comment.type === 'Block' && isTypeAnnotation(comment.value));
      if (!skippable) break;
      pos = comment.range[1];
    }
    if (/\n[ \t]*\r?\n/.test(text.slice(block.end, pos))) return 'detached';
    return outermostAt.get(pos) ?? 'none';
  };

  /** @param {number} offset */
  const enclosingFunctions = (offset) =>
    functions.filter((fn) => {
      const range = bodyRange(fn);
      return range !== undefined && range[0] < offset && offset < range[1];
    });

  return blocks.map((block, index) => {
    const isJsdoc = block.kind === 'block' && block.raw.startsWith('/**') && block.raw !== '/**/';
    if (firstStatement === undefined || block.end <= firstStatement.range[0]) {
      const next = blocks[index + 1];
      const lastHeader = next === undefined || firstStatement === undefined || next.end > firstStatement.range[0];
      const target = attachedTarget(block);
      if (lastHeader && isJsdoc && typeof target !== 'string' && isDescribable(target)) return { allowed: true, kind: 'description' };
      return { allowed: true, kind: 'header' };
    }
    if (isBanner(block.raw)) return { allowed: false, checkId: 'banner' };
    if (!block.ownLine) return { allowed: false, checkId: 'trailing' };
    const enclosing = enclosingFunctions(block.start);
    const target = attachedTarget(block);
    if (enclosing.length > 0) {
      const testScope = enclosing.every(isTestCallback);
      if (testScope && typeof target !== 'string' && isTestCallStatement(target)) {
        return isJsdoc ? { allowed: true, kind: 'description' } : { allowed: false, checkId: 'non-jsdoc' };
      }
      return { allowed: false, checkId: 'in-body' };
    }
    if (isJsdoc && TYPE_DECLARATION_TAG.test(block.raw)) return { allowed: true, kind: 'description' };
    if (target === 'detached') return { allowed: false, checkId: 'detached' };
    if (target === 'none') return { allowed: false, checkId: 'floating' };
    if (isDescribable(target)) return isJsdoc ? { allowed: true, kind: 'description' } : { allowed: false, checkId: 'non-jsdoc' };
    return { allowed: false, checkId: 'floating' };
  });
}
