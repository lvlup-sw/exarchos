/**
 * P06-02 — Pure, total, three-valued edge-condition evaluator
 * (Transition task 010; DR-1, DR-9, DR-10).
 *
 * ## Purity contract
 *
 * `evaluateEdgeCondition` is a pure total function of its two arguments. It
 * imports no `fs`, `child_process`, `process`, clock, or randomness; it reads
 * no ambient state; it mutates neither the condition nor the facts. The same
 * compiled condition and the same facts always yield the same outcome — which
 * is what makes edge selection replay-safe (DR-9).
 *
 * ## Three-valued (Kleene K3) semantics
 *
 * Evaluation is three-valued because a projected fact may simply be **unknown**
 * at the point a route is chosen, and guessing would break fail-closed replay.
 * An unknown or malformed fact evaluates to `indeterminate`, never to a
 * fabricated `true`/`false`.
 *
 *   - `eventObserved` / `factPresent` are total two-valued: an unobserved event
 *     or an absent field is a *definite* `false` (the projection is complete
 *     for presence questions).
 *   - `factEquals` / `counterCompare` are `indeterminate` when the field is
 *     absent, and `counterCompare` is also `indeterminate` when the present
 *     value is not a finite number (malformed for a numeric comparison).
 *
 * The connectives are Kleene strong logic, so De Morgan's laws hold exactly:
 * `not(all(a, b)) === any(not(a), not(b))` and
 * `not(any(a, b)) === all(not(a), not(b))` for all three-valued operands.
 */
import {
  assertNever,
  type CompiledEdgeCondition,
  type EdgeCompareOp,
  type EdgeConditionNode,
  type FactScalar,
} from './edge-condition.js';

/** The three-valued outcome of evaluating an edge condition. */
export type EdgeConditionOutcome = 'true' | 'false' | 'indeterminate';

export const EDGE_CONDITION_OUTCOME = {
  TRUE: 'true',
  FALSE: 'false',
  INDETERMINATE: 'indeterminate',
} as const;

/**
 * The declared state an edge condition is evaluated against: a snapshot of
 * projected scalar facts and the set of observed event identities. This is
 * plain, inert data — never a closure, handle, or I/O source.
 */
export interface EdgeConditionFacts {
  readonly fields: Readonly<Record<string, FactScalar>>;
  readonly events: readonly string[];
}

/** Evaluate a compiled condition against a fact snapshot. Pure and total. */
export function evaluateEdgeCondition(
  condition: CompiledEdgeCondition,
  facts: EdgeConditionFacts,
): EdgeConditionOutcome {
  return evaluateNode(condition.node, facts);
}

function evaluateNode(
  node: EdgeConditionNode,
  facts: EdgeConditionFacts,
): EdgeConditionOutcome {
  switch (node.kind) {
    case 'eventObserved':
      return facts.events.includes(node.event) ? 'true' : 'false';
    case 'factPresent':
      return hasField(facts, node.field) ? 'true' : 'false';
    case 'factEquals': {
      const value = readField(facts, node.field);
      if (value === undefined) return 'indeterminate';
      return value === node.value ? 'true' : 'false';
    }
    case 'counterCompare': {
      const value = readField(facts, node.field);
      if (value === undefined) return 'indeterminate';
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return 'indeterminate';
      }
      return compareNumbers(value, node.op, node.value) ? 'true' : 'false';
    }
    case 'not':
      return notK(evaluateNode(node.operand, facts));
    case 'all':
      return allK(node.operands, facts);
    case 'any':
      return anyK(node.operands, facts);
    default:
      return assertNever(node);
  }
}

function hasField(facts: EdgeConditionFacts, field: string): boolean {
  return Object.hasOwn(facts.fields, field) && facts.fields[field] !== undefined;
}

function readField(
  facts: EdgeConditionFacts,
  field: string,
): FactScalar | undefined {
  if (!Object.hasOwn(facts.fields, field)) return undefined;
  return facts.fields[field];
}

function compareNumbers(
  actual: number,
  op: EdgeCompareOp,
  threshold: number,
): boolean {
  switch (op) {
    case 'lt':
      return actual < threshold;
    case 'lte':
      return actual <= threshold;
    case 'eq':
      return actual === threshold;
    case 'gte':
      return actual >= threshold;
    case 'gt':
      return actual > threshold;
    default:
      return assertNever(op);
  }
}

// ─── Kleene K3 connectives ───────────────────────────────────────────────────

function notK(value: EdgeConditionOutcome): EdgeConditionOutcome {
  switch (value) {
    case 'true':
      return 'false';
    case 'false':
      return 'true';
    case 'indeterminate':
      return 'indeterminate';
    default:
      return assertNever(value);
  }
}

/** Conjunction: any `false` ⇒ `false`; else any `indeterminate` ⇒ `indeterminate`; else `true`. */
function allK(
  operands: readonly EdgeConditionNode[],
  facts: EdgeConditionFacts,
): EdgeConditionOutcome {
  let sawIndeterminate = false;
  for (const operand of operands) {
    const outcome = evaluateNode(operand, facts);
    if (outcome === 'false') return 'false';
    if (outcome === 'indeterminate') sawIndeterminate = true;
  }
  return sawIndeterminate ? 'indeterminate' : 'true';
}

/** Disjunction: any `true` ⇒ `true`; else any `indeterminate` ⇒ `indeterminate`; else `false`. */
function anyK(
  operands: readonly EdgeConditionNode[],
  facts: EdgeConditionFacts,
): EdgeConditionOutcome {
  let sawIndeterminate = false;
  for (const operand of operands) {
    const outcome = evaluateNode(operand, facts);
    if (outcome === 'true') return 'true';
    if (outcome === 'indeterminate') sawIndeterminate = true;
  }
  return sawIndeterminate ? 'indeterminate' : 'false';
}
