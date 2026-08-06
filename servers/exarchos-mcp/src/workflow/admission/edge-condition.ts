/**
 * P06-02 — Closed edge-condition AST and compile/import-time validator
 * (Transition task 009; DR-1, DR-2, DR-10).
 *
 * ## What this is
 *
 * An *edge condition* answers exactly one question: **"is this edge
 * structurally legal to take?"** It is a pure, declarative selector over
 * projected facts and observed event identities. It is deliberately NOT
 * admission: it never collects evidence, evaluates policy, models severity or
 * remediation, shells out, or performs any I/O. Route selection decides which
 * legal edge to take; evidence-backed admission (P06-03/P06-04) decides whether
 * a transition may actually occur.
 *
 * ## Closed by construction
 *
 * The AST is a closed discriminated union of exactly SEVEN node kinds
 * (`eventObserved`, `factPresent`, `factEquals`, `counterCompare`, `all`,
 * `any`, `not`). "Closed" means, concretely:
 *
 *   1. there is no escape-hatch node — no `custom`, no `expression: string`
 *      lowered to `eval`, no provider reference, no function-valued node;
 *   2. the node-kind union is exhaustive and that exhaustiveness is enforced at
 *      compile time by a `never` check (see {@link assertNever}); and
 *   3. every constant is expressed structurally — an empty `all` is the
 *      always-legal edge (`true`) and an empty `any` is the never-legal edge
 *      (`false`) — so there is no literal-boolean leaf to smuggle logic through.
 *
 * ## Rejected at compile/import time, not lazily at evaluation
 *
 * {@link compileEdgeCondition} is the ONLY supported way to obtain a
 * {@link CompiledEdgeCondition}, and it validates eagerly. It rejects, with a
 * structured {@link EdgeConditionCompileError}:
 *
 *   - unknown / unsupported `kind` values;
 *   - arbitrary executable values (any `function`) anywhere in the tree;
 *   - prototype-pollution keys (`__proto__`, `constructor`, `prototype`);
 *   - extra / unknown properties (which is how a string-expression escape hatch
 *     such as `{ kind: 'factEquals', expression: 'a && b' }` is caught);
 *   - non-scalar leaf values and non-finite numbers; and
 *   - references to state fields or event identities that were not declared.
 *
 * Because the evaluator only accepts an already-compiled condition, an invalid
 * condition can never reach evaluation.
 */

// ─── Scalar value algebra ────────────────────────────────────────────────────

/** The closed set of declared field types the AST may reference. */
export type FactType = 'string' | 'number' | 'boolean';

/** The closed set of scalar values the AST may compare against. */
export type FactScalar = string | number | boolean;

/** Comparison operators for {@link CounterCompareNode}. */
export const EDGE_COMPARE_OPS = ['lt', 'lte', 'eq', 'gte', 'gt'] as const;
export type EdgeCompareOp = (typeof EDGE_COMPARE_OPS)[number];

// ─── Closed AST node kinds ───────────────────────────────────────────────────

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

// ─── Declaration of legal references ─────────────────────────────────────────

/**
 * Declares which state fields and event identities a condition may reference.
 * Compilation rejects any reference outside this declaration, so a condition
 * can never depend on an undeclared field (which the runtime could never
 * populate deterministically).
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

// ─── Compiled (validated) condition ──────────────────────────────────────────

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

// ─── Structured compile errors ───────────────────────────────────────────────

export type EdgeConditionCompileErrorCode =
  /** A node (or the whole condition) is not a plain object. */
  | 'NOT_AN_OBJECT'
  /** A prototype-pollution key (`__proto__`/`constructor`/`prototype`) was present. */
  | 'FORBIDDEN_KEY'
  /** A value was a function — an arbitrary executable expression. */
  | 'EXECUTABLE_VALUE'
  /** A node object had no `kind` discriminant. */
  | 'MISSING_KIND'
  /** The `kind` discriminant is not one of the seven approved node kinds. */
  | 'UNKNOWN_NODE_KIND'
  /** A node carried a property outside its closed shape (e.g. `expression`). */
  | 'UNKNOWN_PROPERTY'
  /** A required property was missing or had the wrong primitive type. */
  | 'INVALID_PROPERTY_TYPE'
  /** A leaf value was not a `string`/`number`/`boolean` scalar. */
  | 'NON_SCALAR_VALUE'
  /** A numeric value was not finite. */
  | 'INVALID_NUMBER'
  /** A `counterCompare.op` value was not a supported operator. */
  | 'INVALID_OPERATOR'
  /** A referenced field was not declared. */
  | 'UNDECLARED_FIELD'
  /** A referenced event identity was not declared. */
  | 'UNDECLARED_EVENT'
  /** A referenced field's declared type is incompatible with the node. */
  | 'FIELD_TYPE_MISMATCH'
  /** The declaration passed to the compiler was itself malformed. */
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

// ─── Exhaustiveness helper ───────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness guard. A missing switch arm makes `value`
 * non-`never`, so the whole module fails to typecheck — this is the `never`
 * check that keeps the AST closed.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected edge-condition variant: ${String(value)}`);
}

// ─── Internal validation primitives ──────────────────────────────────────────

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

// ─── Recursive node parser ───────────────────────────────────────────────────

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

// ─── Declaration normalization ───────────────────────────────────────────────

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

// ─── Public compile API ──────────────────────────────────────────────────────

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

// ─── Total serialization ─────────────────────────────────────────────────────

/**
 * Serialize a compiled condition to canonical JSON. Serialization is total —
 * the closed AST holds only scalars, arrays, and plain objects, never a
 * function or command — so this never throws and never emits executable code.
 */
export function serializeEdgeCondition(condition: CompiledEdgeCondition): string {
  return JSON.stringify(condition.node);
}
