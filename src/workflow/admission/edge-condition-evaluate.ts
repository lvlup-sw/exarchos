/**
 * A pure, total, three-valued evaluator for edge conditions.
 *
 * The evaluator reads no ambient state, does no I/O and changes no input.
 * The same condition and facts always give the same outcome, so edge selection is safe to replay.
 *
 * For `eventObserved` and `factPresent`, an absent event or field is a definite `false`.
 * For `factEquals` and `counterCompare`, an absent field is `indeterminate`, not a guessed value.
 * For `counterCompare`, a value that is not a finite number is also `indeterminate`.
 * The connectives use Kleene strong logic, so De Morgan's laws hold for all three values.
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
 * The facts for an edge condition: projected scalar fields and the observed event identities.
 * This is plain data, never a closure, a handle or an I/O source.
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

/** Kleene conjunction. Any `false` gives `false`. Else any `indeterminate` gives `indeterminate`. Else `true`. */
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

/** Kleene disjunction. Any `true` gives `true`. Else any `indeterminate` gives `indeterminate`. Else `false`. */
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
