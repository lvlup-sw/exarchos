/**
 * The closed edge-condition AST and its compile-time validator.
 * An edge condition answers one question: is this edge structurally legal to take?
 * It is a pure selector over projected facts and observed event identities. It does no I/O and is not admission.
 * Route selection picks which legal edge to take. Evidence-backed admission decides if the transition can occur.
 *
 * The AST is a closed union of seven node kinds. It has no escape-hatch node and no literal boolean leaf.
 * An empty `all` is always legal, and an empty `any` is never legal. A `never` check enforces exhaustiveness.
 *
 * {@link compileEdgeCondition} is the only way to get a {@link CompiledEdgeCondition}, and it validates eagerly.
 * It rejects unknown kinds, functions, prototype-pollution keys, unknown properties, bad leaf values, and undeclared references.
 * The evaluator accepts only a compiled condition, so an invalid condition never reaches evaluation.
 */

/** The closed set of declared field types that the AST can reference. */
export type FactType = 'string' | 'number' | 'boolean';

/** The closed set of scalar values that the AST can compare against. */
export type FactScalar = string | number | boolean;

/** Comparison operators for {@link CounterCompareNode}. */
export const EDGE_COMPARE_OPS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const;
export type EdgeCompareOp = (typeof EDGE_COMPARE_OPS)[number];

/** The exhaustive, closed set of approved condition-node kinds (V1). */
export const EDGE_CONDITION_NODE_KINDS = [
  'eventObserved',
  'factPresent',
  'factEquals',
  'counterCompare',
  'all',
  'any',
  'not',
] as const;
export type EdgeConditionNodeKind = (typeof EDGE_CONDITION_NODE_KINDS)[number];

/** An observed-event identity test. Absence is a definite `false`. */
export interface EventObservedNode {
  readonly kind: 'eventObserved';
  readonly event: string;
}

/** Tests whether a projected fact field is present. Absence is a definite `false`. */
export interface FactPresentNode {
  readonly kind: 'factPresent';
  readonly field: string;
}

/** Tests whether a present projected fact equals a declared scalar. */
export interface FactEqualsNode {
  readonly kind: 'factEquals';
  readonly field: string;
  readonly value: FactScalar;
}

/** Compares a present numeric counter fact against a declared threshold. */
export interface CounterCompareNode {
  readonly kind: 'counterCompare';
  readonly field: string;
  readonly op: EdgeCompareOp;
  readonly value: number;
}

/** Conjunction. Empty operands is the always-legal constant (`true`). */
export interface AllNode {
  readonly kind: 'all';
  readonly operands: readonly EdgeConditionNode[];
}

/** Disjunction. Empty operands is the never-legal constant (`false`). */
export interface AnyNode {
  readonly kind: 'any';
  readonly operands: readonly EdgeConditionNode[];
}

/** Negation. */
export interface NotNode {
  readonly kind: 'not';
  readonly operand: EdgeConditionNode;
}

/** The closed edge-condition AST. */
export type EdgeConditionNode =
  | EventObservedNode
  | FactPresentNode
  | FactEqualsNode
  | CounterCompareNode
  | AllNode
  | AnyNode
  | NotNode;

/**
 * Declares the state fields and event identities that a condition can reference.
 * Compilation rejects any other reference, because the runtime cannot fill an undeclared field deterministically.
 */
export interface EdgeConditionDeclaration {
  /** Declared projected-fact fields and their scalar type. */
  readonly fields: Readonly<Record<string, FactType>>;
  /** Declared observable event identities. */
  readonly events?: readonly string[];
}

/** Normalized, lookup-friendly form of an {@link EdgeConditionDeclaration}. */
export interface NormalizedEdgeConditionDeclaration {
  readonly fields: ReadonlyMap<string, FactType>;
  readonly events: ReadonlySet<string>;
}

declare const compiledBrand: unique symbol;

/**
 * A structurally validated, reference-checked edge condition. The phantom
 * brand makes this type unconstructable outside {@link compileEdgeCondition},
 * so possessing one proves it already passed compile-time validation.
 */
export interface CompiledEdgeCondition {
  readonly node: EdgeConditionNode;
  readonly declaration: NormalizedEdgeConditionDeclaration;
  readonly [compiledBrand]: 'CompiledEdgeCondition';
}

/**
 * The code of an {@link EdgeConditionCompileError}.
 * `EXECUTABLE_VALUE` is a function value. `UNKNOWN_PROPERTY` is a key outside the closed node shape, such as `expression`.
 * `INVALID_PROPERTY_TYPE` is a required property that is missing or has the wrong primitive type.
 * `FIELD_TYPE_MISMATCH` is a field whose declared type does not fit the node.
 *
 * `INVALID_NUMBER` is a number that is not finite. The other names state their rule.
 */
export type EdgeConditionCompileErrorCode =
  | 'NOT_AN_OBJECT'
  | 'FORBIDDEN_KEY'
  | 'EXECUTABLE_VALUE'
  | 'MISSING_KIND'
  | 'UNKNOWN_NODE_KIND'
  | 'UNKNOWN_PROPERTY'
  | 'INVALID_PROPERTY_TYPE'
  | 'NON_SCALAR_VALUE'
  | 'INVALID_NUMBER'
  | 'INVALID_OPERATOR'
  | 'UNDECLARED_FIELD'
  | 'UNDECLARED_EVENT'
  | 'FIELD_TYPE_MISMATCH'
  | 'INVALID_DECLARATION';

/** A structured, path-annotated compile/import-time rejection. */
export class EdgeConditionCompileError extends Error {
  readonly code: EdgeConditionCompileErrorCode;
  readonly path: string;

  constructor(code: EdgeConditionCompileErrorCode, message: string, path: string) {
    super(`${code} at ${path}: ${message}`);
    this.name = 'EdgeConditionCompileError';
    this.code = code;
    this.path = path;
  }
}

/** Non-throwing compile result for callers that fold diagnostics. */
export type EdgeConditionCompileResult =
  | { readonly ok: true; readonly condition: CompiledEdgeCondition }
  | { readonly ok: false; readonly error: EdgeConditionCompileError };

/**
 * Compile-time exhaustiveness guard. A missing switch arm makes `value` non-`never`, so the module fails to typecheck.
 * This `never` check keeps the AST closed.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected edge-condition variant: ${String(value)}`);
}

/** Prototype-pollution keys that compilation rejects. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

function isCompareOp(value: unknown): value is EdgeCompareOp {
  return (
    typeof value === 'string' &&
    (EDGE_COMPARE_OPS as readonly string[]).includes(value)
  );
}

function isNodeKind(value: unknown): value is EdgeConditionNodeKind {
  return (
    typeof value === 'string' &&
    (EDGE_CONDITION_NODE_KINDS as readonly string[]).includes(value)
  );
}

function scalarType(value: FactScalar): FactType {
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    default:
      return 'boolean';
  }
}

/**
 * Narrows `raw` to a plain object while rejecting arrays, functions, and
 * prototype-pollution keys. Every own key (enumerable or not) is scanned so a
 * `JSON.parse`-injected `__proto__` own property cannot slip through.
 */
function asNodeObject(raw: unknown, path: string): Record<string, unknown> {
  if (typeof raw === 'function') {
    throw new EdgeConditionCompileError(
      'EXECUTABLE_VALUE',
      'a condition node may not be a function',
      path,
    );
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EdgeConditionCompileError(
      'NOT_AN_OBJECT',
      'expected a condition node object',
      path,
    );
  }
  for (const key of Object.getOwnPropertyNames(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new EdgeConditionCompileError(
        'FORBIDDEN_KEY',
        `forbidden property key ${JSON.stringify(key)}`,
        path,
      );
    }
  }
  return raw as Record<string, unknown>;
}

/** Rejects any own property outside the closed shape of a node kind. */
function expectExactKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new EdgeConditionCompileError(
        'UNKNOWN_PROPERTY',
        `unexpected property ${JSON.stringify(key)}; a closed node may not carry an escape hatch`,
        path,
      );
    }
  }
}

function requireString(value: unknown, name: string, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EdgeConditionCompileError(
      'INVALID_PROPERTY_TYPE',
      `property ${JSON.stringify(name)} must be a non-empty string`,
      path,
    );
  }
  return value;
}

function requireScalar(value: unknown, path: string): FactScalar {
  if (typeof value === 'function') {
    throw new EdgeConditionCompileError(
      'EXECUTABLE_VALUE',
      'a value may not be a function',
      path,
    );
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new EdgeConditionCompileError(
        'INVALID_NUMBER',
        'numeric value must be finite',
        path,
      );
    }
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  throw new EdgeConditionCompileError(
    'NON_SCALAR_VALUE',
    'value must be a string, finite number, or boolean',
    path,
  );
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EdgeConditionCompileError(
      'INVALID_NUMBER',
      'expected a finite number',
      path,
    );
  }
  return value;
}

function requireDeclaredField(
  field: string,
  decl: NormalizedEdgeConditionDeclaration,
  path: string,
): FactType {
  const type = decl.fields.get(field);
  if (type === undefined) {
    throw new EdgeConditionCompileError(
      'UNDECLARED_FIELD',
      `field ${JSON.stringify(field)} is not declared`,
      path,
    );
  }
  return type;
}

/** Parse one raw node and its children, and validate them against the declaration. */
function parseNode(
  raw: unknown,
  path: string,
  decl: NormalizedEdgeConditionDeclaration,
): EdgeConditionNode {
  const obj = asNodeObject(raw, path);
  const kind = obj['kind'];
  if (kind === undefined) {
    throw new EdgeConditionCompileError('MISSING_KIND', 'node has no kind', path);
  }
  if (!isNodeKind(kind)) {
    throw new EdgeConditionCompileError(
      'UNKNOWN_NODE_KIND',
      `unsupported node kind ${JSON.stringify(kind)}`,
      path,
    );
  }

  switch (kind) {
    case 'eventObserved': {
      expectExactKeys(obj, ['kind', 'event'], path);
      const event = requireString(obj['event'], 'event', path);
      if (!decl.events.has(event)) {
        throw new EdgeConditionCompileError(
          'UNDECLARED_EVENT',
          `event ${JSON.stringify(event)} is not declared`,
          path,
        );
      }
      return { kind, event };
    }
    case 'factPresent': {
      expectExactKeys(obj, ['kind', 'field'], path);
      const field = requireString(obj['field'], 'field', path);
      requireDeclaredField(field, decl, path);
      return { kind, field };
    }
    case 'factEquals': {
      expectExactKeys(obj, ['kind', 'field', 'value'], path);
      const field = requireString(obj['field'], 'field', path);
      const declaredType = requireDeclaredField(field, decl, path);
      const value = requireScalar(obj['value'], `${path}.value`);
      if (scalarType(value) !== declaredType) {
        throw new EdgeConditionCompileError(
          'FIELD_TYPE_MISMATCH',
          `field ${JSON.stringify(field)} is declared ${declaredType} but value is ${scalarType(value)}`,
          path,
        );
      }
      return { kind, field, value };
    }
    case 'counterCompare': {
      expectExactKeys(obj, ['kind', 'field', 'op', 'value'], path);
      const field = requireString(obj['field'], 'field', path);
      const declaredType = requireDeclaredField(field, decl, path);
      if (declaredType !== 'number') {
        throw new EdgeConditionCompileError(
          'FIELD_TYPE_MISMATCH',
          `counterCompare requires a numeric field but ${JSON.stringify(field)} is declared ${declaredType}`,
          path,
        );
      }
      const op = obj['op'];
      if (!isCompareOp(op)) {
        throw new EdgeConditionCompileError(
          'INVALID_OPERATOR',
          `unsupported operator ${JSON.stringify(op)}`,
          path,
        );
      }
      const value = requireFiniteNumber(obj['value'], `${path}.value`);
      return { kind, field, op, value };
    }
    case 'all':
    case 'any': {
      expectExactKeys(obj, ['kind', 'operands'], path);
      const operands = obj['operands'];
      if (!Array.isArray(operands)) {
        throw new EdgeConditionCompileError(
          'INVALID_PROPERTY_TYPE',
          'operands must be an array',
          path,
        );
      }
      const parsed = operands.map((operand, index) =>
        parseNode(operand, `${path}.operands[${index}]`, decl),
      );
      return { kind, operands: parsed };
    }
    case 'not': {
      expectExactKeys(obj, ['kind', 'operand'], path);
      if (!('operand' in obj)) {
        throw new EdgeConditionCompileError(
          'INVALID_PROPERTY_TYPE',
          'not requires an operand',
          path,
        );
      }
      return { kind, operand: parseNode(obj['operand'], `${path}.operand`, decl) };
    }
    default:
      return assertNever(kind);
  }
}

/** Validate the declaration and convert it to a field map and an event set. */
function normalizeDeclaration(
  declaration: EdgeConditionDeclaration,
): NormalizedEdgeConditionDeclaration {
  if (
    declaration === null ||
    typeof declaration !== 'object' ||
    typeof declaration.fields !== 'object' ||
    declaration.fields === null
  ) {
    throw new EdgeConditionCompileError(
      'INVALID_DECLARATION',
      'declaration.fields must be an object',
      '$declaration',
    );
  }

  const fields = new Map<string, FactType>();
  for (const [name, type] of Object.entries(declaration.fields)) {
    if (FORBIDDEN_KEYS.has(name)) {
      throw new EdgeConditionCompileError(
        'FORBIDDEN_KEY',
        `forbidden field name ${JSON.stringify(name)}`,
        '$declaration.fields',
      );
    }
    if (name.length === 0) {
      throw new EdgeConditionCompileError(
        'INVALID_DECLARATION',
        'field names must be non-empty',
        '$declaration.fields',
      );
    }
    if (type !== 'string' && type !== 'number' && type !== 'boolean') {
      throw new EdgeConditionCompileError(
        'INVALID_DECLARATION',
        `field ${JSON.stringify(name)} has invalid type ${JSON.stringify(type)}`,
        '$declaration.fields',
      );
    }
    fields.set(name, type);
  }

  const events = new Set<string>();
  const declaredEvents = declaration.events ?? [];
  if (!Array.isArray(declaredEvents)) {
    throw new EdgeConditionCompileError(
      'INVALID_DECLARATION',
      'declaration.events must be an array',
      '$declaration.events',
    );
  }
  for (const event of declaredEvents) {
    if (typeof event !== 'string' || event.length === 0) {
      throw new EdgeConditionCompileError(
        'INVALID_DECLARATION',
        'event identities must be non-empty strings',
        '$declaration.events',
      );
    }
    events.add(event);
  }

  return { fields, events };
}

/**
 * Compile (import-time validate) a raw, untrusted edge-condition value against
 * a declaration. Throws {@link EdgeConditionCompileError} on any structural
 * violation, escape hatch, executable value, or undeclared reference.
 */
export function compileEdgeCondition(
  raw: unknown,
  declaration: EdgeConditionDeclaration,
): CompiledEdgeCondition {
  const normalized = normalizeDeclaration(declaration);
  const node = parseNode(raw, '$', normalized);
  const compiled = {
    node: deepFreezeNode(node),
    declaration: Object.freeze(normalized),
  };
  return Object.freeze(compiled) as unknown as CompiledEdgeCondition;
}

/** Non-throwing variant of {@link compileEdgeCondition}. */
export function tryCompileEdgeCondition(
  raw: unknown,
  declaration: EdgeConditionDeclaration,
): EdgeConditionCompileResult {
  try {
    return { ok: true, condition: compileEdgeCondition(raw, declaration) };
  } catch (error) {
    if (error instanceof EdgeConditionCompileError) {
      return { ok: false, error };
    }
    throw error;
  }
}

function deepFreezeNode(node: EdgeConditionNode): EdgeConditionNode {
  switch (node.kind) {
    case 'all':
    case 'any':
      node.operands.forEach(deepFreezeNode);
      Object.freeze(node.operands);
      break;
    case 'not':
      deepFreezeNode(node.operand);
      break;
    default:
      break;
  }
  return Object.freeze(node);
}

/**
 * Serialize a compiled condition to canonical JSON.
 * The closed AST holds only scalars, arrays, and plain objects, so this never throws and never emits executable code.
 */
export function serializeEdgeCondition(condition: CompiledEdgeCondition): string {
  return JSON.stringify(condition.node);
}
