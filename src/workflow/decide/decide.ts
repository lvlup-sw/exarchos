/**
 * The pure decide over one compiled definition. It gives the verdict of each edge from the facts of a
 * guard input, and it picks the move of a request.
 *
 * The decide projects the input once with `projectStateToFacts`. It evaluates the route and the presence
 * probe of an edge with `evaluateEdgeCondition`, and it joins them with the three-valued conjunction. It
 * reads no admission ledger, no clock, no waiver and no legacy guard.
 *
 * The order of the universal moves is the order of the legacy executor. A cancel request takes the cancel
 * move from each step that is not final. A cleanup request takes the cleanup move first, and the explicit
 * edge to the same target decides when `cleanup.mergeVerified` is not true. A transition request to the
 * cleanup target takes the cleanup move first in the same way. A transition request reads no cancel move.
 *
 * A source phase that is no step follows the legacy executor. A cancel request admits from it. A cleanup
 * request admits only on a true `cleanup.mergeVerified`. A transition request gives `no-edge`.
 */

import {
  assertNever,
  compileEdgeCondition,
  type CompiledEdgeCondition,
  type EdgeConditionNode,
  type FactScalar,
} from '../admission/edge-condition.js';
import {
  evaluateEdgeCondition,
  type EdgeConditionFacts,
  type EdgeConditionOutcome,
} from '../admission/edge-condition-evaluate.js';
import { FACT_DECLARATION } from '../admission/built-in-workflow-ir.js';
import { projectStateToFacts } from '../admission/legacy-state-translation.js';
import type { DecideDefinition, DecideEdge, UniversalMove } from './edges.js';

/** The verdict of one explicit edge. `falseFacts` holds the field of each false or indeterminate leaf. */
export interface EdgeVerdict {
  readonly transitionId: string;
  readonly to: string;
  readonly verdict: 'allow' | 'deny' | 'indeterminate';
  readonly falseFacts: readonly string[];
}

/** The request of one decide call. A settle request names no target. */
export type DecideRequest =
  | { readonly kind: 'transition'; readonly target: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'cleanup' }
  | { readonly kind: 'settle' };

/** The outcome of one decide call. */
export type DecideOutcome =
  | { readonly kind: 'idempotent'; readonly phase: string }
  | {
      readonly kind: 'admit';
      readonly from: string;
      readonly move: DecideEdge | UniversalMove;
      readonly verdicts: readonly EdgeVerdict[];
    }
  | {
      readonly kind: 'deny';
      readonly from: string;
      readonly edge: DecideEdge;
      readonly verdict: EdgeVerdict;
      readonly expectedShape: Record<string, unknown>;
    }
  | { readonly kind: 'no-edge'; readonly from: string; readonly validTargets: readonly string[] }
  | { readonly kind: 'stay'; readonly from: string; readonly verdicts: readonly EdgeVerdict[] };

/** The field prefixes of the derived facts. No agent writes a derived fact. */
const DERIVED_FACT_PREFIXES: readonly string[] = ['tasks.', 'reviews.', 'team.', 'mergePending.', 'cleanup.'];

/** The derived facts outside the derived prefixes. */
const DERIVED_FACT_NAMES: readonly string[] = ['planReview.revisionsExhausted', 'artifacts.planNonEmpty'];

/** The declared facts that the projection derives. A false leaf of one of them adds nothing to `expectedShape`. */
const DERIVED_FACT_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(FACT_DECLARATION.fields).filter(
    (field) =>
      DERIVED_FACT_PREFIXES.some((prefix) => field.startsWith(prefix)) || DERIVED_FACT_NAMES.includes(field),
  ),
);

/** True when the value is a plain object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the outcome of one node of a compiled condition. The node compiled as part of its condition. */
function nodeOutcome(node: EdgeConditionNode, facts: EdgeConditionFacts): EdgeConditionOutcome {
  return evaluateEdgeCondition(compileEdgeCondition(node, FACT_DECLARATION), facts);
}

/** The leaves of a condition that are not true. */
interface OpenLeaves {
  readonly fields: string[];
  readonly equals: { readonly field: string; readonly value: FactScalar }[];
}

/**
 * Adds each leaf that is not true to the lists, under each node that is not true. A negated subtree adds
 * nothing. Only a false `factEquals` leaf goes into the shape list.
 */
function collectOpenLeaves(node: EdgeConditionNode, facts: EdgeConditionFacts, leaves: OpenLeaves): void {
  const outcome = nodeOutcome(node, facts);
  if (outcome === 'true') return;
  switch (node.kind) {
    case 'all':
    case 'any':
      for (const operand of node.operands) collectOpenLeaves(operand, facts, leaves);
      return;
    case 'not':
      return;
    case 'factEquals':
      leaves.fields.push(node.field);
      if (outcome === 'false') leaves.equals.push({ field: node.field, value: node.value });
      return;
    case 'factPresent':
    case 'counterCompare':
      leaves.fields.push(node.field);
      return;
    case 'eventObserved':
      leaves.fields.push(node.event);
      return;
    default:
      assertNever(node);
  }
}

/** Returns the conditions of an edge: the route, then the presence probe when the edge has one. */
function conditionsOf(edge: DecideEdge): readonly CompiledEdgeCondition[] {
  return edge.presence === undefined ? [edge.route] : [edge.route, edge.presence];
}

/** Joins two outcomes with the three-valued conjunction. */
function conjoin(left: EdgeConditionOutcome, right: EdgeConditionOutcome): EdgeConditionOutcome {
  if (left === 'false' || right === 'false') return 'false';
  if (left === 'indeterminate' || right === 'indeterminate') return 'indeterminate';
  return 'true';
}

/** Returns the open leaves of an edge on the facts. */
function openLeavesOf(edge: DecideEdge, facts: EdgeConditionFacts): OpenLeaves {
  const leaves: OpenLeaves = { fields: [], equals: [] };
  for (const condition of conditionsOf(edge)) collectOpenLeaves(condition.node, facts, leaves);
  return leaves;
}

/** Returns the verdict of one explicit edge: the conjunction of its route and its presence probe. */
function verdictOf(edge: DecideEdge, facts: EdgeConditionFacts): EdgeVerdict {
  const outcome = conditionsOf(edge)
    .map((condition) => evaluateEdgeCondition(condition, facts))
    .reduce<EdgeConditionOutcome>(conjoin, 'true');
  const verdict = outcome === 'true' ? 'allow' : outcome === 'false' ? 'deny' : 'indeterminate';
  const fields = verdict === 'allow' ? [] : [...new Set(openLeavesOf(edge, facts).fields)];
  return { transitionId: edge.transitionId, to: edge.to, verdict, falseFacts: fields };
}

/** Sets the value at the dotted path of the shape. A path that the shape already holds keeps its value. */
function nestInto(shape: Record<string, unknown>, path: readonly string[], value: FactScalar): void {
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (rest.length === 0) {
    if (!Object.hasOwn(shape, head)) shape[head] = value;
    return;
  }
  const existing = shape[head];
  if (isRecord(existing)) {
    nestInto(existing, rest, value);
    return;
  }
  if (Object.hasOwn(shape, head)) return;
  const child: Record<string, unknown> = {};
  shape[head] = child;
  nestInto(child, rest, value);
}

/**
 * Returns the shape that a denied edge expects: the nest of each false `factEquals` leaf, with its path and
 * value. A counter leaf and a leaf of a derived fact add nothing.
 */
function expectedShapeOf(edge: DecideEdge, facts: EdgeConditionFacts): Record<string, unknown> {
  const shape: Record<string, unknown> = {};
  for (const leaf of openLeavesOf(edge, facts).equals) {
    if (DERIVED_FACT_FIELDS.has(leaf.field)) continue;
    nestInto(shape, leaf.field.split('.'), leaf.value);
  }
  return shape;
}

/** Returns the step of a phase, or `undefined` when the phase is no step of the definition. */
function stepOf(def: DecideDefinition, phase: string): DecideDefinition['steps'][number] | undefined {
  return def.steps.find((step) => step.stepId === phase);
}

/** Returns the explicit edges out of a step, in edge order. */
function edgesOutOf(def: DecideDefinition, phase: string): readonly DecideEdge[] {
  return def.edges.filter((edge) => edge.from === phase);
}

/**
 * Returns the valid targets of a phase: the explicit targets of the step once each, in edge order. Then each
 * universal target that no explicit edge of the step reaches. A final step and a phase that is no step give none.
 */
export function validTargetsOf(def: DecideDefinition, phase: string): readonly string[] {
  const step = stepOf(def, phase);
  if (step === undefined || step.isFinal) return [];
  const targets: string[] = [];
  for (const edge of edgesOutOf(def, phase)) {
    if (!targets.includes(edge.to)) targets.push(edge.to);
  }
  for (const move of [def.cancel, def.cleanup]) {
    if (move !== undefined && !targets.includes(move.to)) targets.push(move.to);
  }
  return targets;
}

/** Returns the outcome of one explicit edge: `admit` on `allow`, and `deny` on `deny` or `indeterminate`. */
function explicitOutcome(edge: DecideEdge, from: string, facts: EdgeConditionFacts): DecideOutcome {
  const verdict = verdictOf(edge, facts);
  if (verdict.verdict === 'allow') return { kind: 'admit', from, move: edge, verdicts: [verdict] };
  return { kind: 'deny', from, edge, verdict, expectedShape: expectedShapeOf(edge, facts) };
}

/** Returns the outcome of the explicit edge from the source to the target, or `no-edge` when none exists. */
function explicitOrNoEdge(def: DecideDefinition, from: string, target: string, facts: EdgeConditionFacts): DecideOutcome {
  const edge = edgesOutOf(def, from).find((candidate) => candidate.to === target);
  if (edge === undefined) return { kind: 'no-edge', from, validTargets: validTargetsOf(def, from) };
  return explicitOutcome(edge, from, facts);
}

/** True when the cleanup move exists and its condition is true on the facts. */
function cleanupAdmits(def: DecideDefinition, facts: EdgeConditionFacts): boolean {
  const cleanup = def.cleanup;
  return cleanup?.edgeKind === 'cleanup' && evaluateEdgeCondition(cleanup.condition, facts) === 'true';
}

/** Decides a cleanup request, or a transition request to the cleanup target, from a step that is not final. */
function decideCleanupMove(
  def: DecideDefinition,
  from: string,
  known: boolean,
  facts: EdgeConditionFacts,
): DecideOutcome {
  const cleanup = def.cleanup;
  if (cleanup === undefined) return { kind: 'no-edge', from, validTargets: validTargetsOf(def, from) };
  if (cleanupAdmits(def, facts)) return { kind: 'admit', from, move: cleanup, verdicts: [] };
  if (!known) return { kind: 'no-edge', from, validTargets: [] };
  return explicitOrNoEdge(def, from, cleanup.to, facts);
}

/** Decides a settle request: exactly one allowed explicit edge admits, and another count stays. */
function decideSettle(def: DecideDefinition, from: string, facts: EdgeConditionFacts): DecideOutcome {
  const edges = edgesOutOf(def, from);
  const verdicts = edges.map((edge) => verdictOf(edge, facts));
  const allowed = edges.filter((_edge, index) => verdicts[index]?.verdict === 'allow');
  const [only] = allowed;
  if (allowed.length === 1 && only !== undefined) return { kind: 'admit', from, move: only, verdicts };
  return { kind: 'stay', from, verdicts };
}

/** Returns the target of a request at a final step, or `undefined` for a request that names no target. */
function finalTargetOf(def: DecideDefinition, request: DecideRequest): string | undefined {
  switch (request.kind) {
    case 'transition':
      return request.target;
    case 'cancel':
      return def.cancel?.to;
    case 'cleanup':
      return def.cleanup?.to;
    case 'settle':
      return undefined;
    default:
      return assertNever(request);
  }
}

/**
 * Decides one request on one guard input. The source phase is `input.phase`. The input is projected once.
 * A target equal to the source is idempotent. A final source gives no move.
 */
export function decide(def: DecideDefinition, input: Record<string, unknown>, request: DecideRequest): DecideOutcome {
  const from = typeof input.phase === 'string' ? input.phase : '';
  const step = stepOf(def, from);
  const target = finalTargetOf(def, request);
  if (target === from) return { kind: 'idempotent', phase: from };
  if (step?.isFinal === true) return { kind: 'no-edge', from, validTargets: [] };
  const facts = projectStateToFacts(input);
  switch (request.kind) {
    case 'transition':
      if (step === undefined) return { kind: 'no-edge', from, validTargets: [] };
      if (request.target === def.cleanup?.to) return decideCleanupMove(def, from, true, facts);
      return explicitOrNoEdge(def, from, request.target, facts);
    case 'cancel':
      if (def.cancel === undefined) return { kind: 'no-edge', from, validTargets: validTargetsOf(def, from) };
      return { kind: 'admit', from, move: def.cancel, verdicts: [] };
    case 'cleanup':
      return decideCleanupMove(def, from, step !== undefined, facts);
    case 'settle':
      if (step === undefined) return { kind: 'no-edge', from, validTargets: [] };
      return decideSettle(def, from, facts);
    default:
      return assertNever(request);
  }
}
