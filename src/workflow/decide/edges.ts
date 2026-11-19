/**
 * Compiles one workflow definition into the edges that the pure decide reads.
 *
 * Each kernel transition gives one explicit edge, in kernel order. The `exarchos` extension of the
 * definition gives the guard id, the category, the flags, the effects, the route and the presence probe
 * of the edge. A route that the edge does not declare compiles to `all([])`, which is always legal. An
 * obligation of kind `none` has no presence probe.
 *
 * The universal edges of the extension become the cancel move and the cleanup move. The cancel move has
 * no condition. The cleanup move holds the condition that `cleanup.mergeVerified` is true.
 *
 * A skip list routes each incoming edge of a skipped step to each outgoing target. The new edge takes
 * the condition of the outgoing edge. The throw rules and the routing order are those of the legacy skip.
 *
 * This module reads no state, no clock and no legacy guard module.
 */

import {
  compileEdgeCondition,
  type CompiledEdgeCondition,
} from '../admission/edge-condition.js';
import { FACT_DECLARATION } from '../admission/built-in-workflow-ir.js';
import { KIND_OBLIGATIONS, type PhaseKind } from '../phase-kind.js';
import type {
  Effect,
  EdgeCategory,
  ExarchosDefinition,
  ExarchosExtension,
} from '../definitions/extension.js';

/** One explicit edge of a compiled definition. */
export interface DecideEdge {
  readonly edgeKind: 'explicit';
  readonly transitionId: string;
  readonly from: string;
  readonly to: string;
  readonly guardId?: string;
  readonly category: EdgeCategory;
  readonly route: CompiledEdgeCondition;
  /** The presence probe of the obligation. An obligation of kind `none` has no probe. */
  readonly presence?: CompiledEdgeCondition;
  readonly isFixCycle?: true;
  readonly isRevision?: true;
  readonly effects?: readonly Effect[];
}

/** One universal move. The cleanup move holds its condition, and the cancel move holds none. */
export type UniversalMove =
  | { readonly edgeKind: 'cancel'; readonly to: string }
  | {
      readonly edgeKind: 'cleanup';
      readonly to: string;
      readonly guardId: string;
      readonly condition: CompiledEdgeCondition;
    };

/** One kernel step of a compiled definition. A final step has no phase kind. */
export interface DecideStep {
  readonly stepId: string;
  readonly isFinal: boolean;
  readonly kind?: PhaseKind;
  readonly groupId?: string;
}

/** A compiled definition: the steps, the groups, the explicit edges and the universal moves. */
export interface DecideDefinition {
  readonly workflowType: string;
  readonly entryStepId?: string;
  readonly steps: readonly DecideStep[];
  readonly groups: ExarchosExtension['groups'];
  readonly edges: readonly DecideEdge[];
  readonly cancel?: UniversalMove;
  readonly cleanup?: UniversalMove;
}

/** The condition of the universal cleanup move. */
const MERGE_VERIFIED_NODE = { kind: 'factEquals', field: 'cleanup.mergeVerified', value: true };

/** The guard data of one edge of the extension. */
type ExtensionEdge = ExarchosExtension['edges'][string];

/** True when the value is a phase kind, a key of the obligation table. */
function isPhaseKind(value: unknown): value is PhaseKind {
  return typeof value === 'string' && Object.hasOwn(KIND_OBLIGATIONS, value);
}

/**
 * Compiles one condition of an edge against the fact vocabulary.
 * @throws When the condition does not compile. The message names the type, the transition and the part.
 */
function compilePart(
  workflowType: string,
  transitionId: string,
  part: 'route' | 'presence',
  node: unknown,
): CompiledEdgeCondition {
  try {
    return compileEdgeCondition(node, FACT_DECLARATION);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the ${part} of the edge '${workflowType} ${transitionId}' does not compile: ${reason}`, {
      cause: error,
    });
  }
}

/** Returns the presence probe of an edge, or `undefined` for an obligation of kind `none`. */
function presenceOf(
  workflowType: string,
  transitionId: string,
  edge: ExtensionEdge,
): CompiledEdgeCondition | undefined {
  const obligation = edge.obligation;
  if (obligation.kind === 'none') return undefined;
  return compilePart(workflowType, transitionId, 'presence', obligation.presence);
}

/** Compiles the explicit edge of one kernel transition. */
function explicitEdge(
  workflowType: string,
  transitionId: string,
  from: string,
  to: string,
  edge: ExtensionEdge,
): DecideEdge {
  const presence = presenceOf(workflowType, transitionId, edge);
  return {
    edgeKind: 'explicit',
    transitionId,
    from,
    to,
    ...(edge.guardId === undefined ? {} : { guardId: edge.guardId }),
    category: edge.category,
    route: compilePart(workflowType, transitionId, 'route', edge.route ?? { kind: 'all', operands: [] }),
    ...(presence === undefined ? {} : { presence }),
    ...(edge.isFixCycle === true ? { isFixCycle: true } : {}),
    ...(edge.isRevision === true ? { isRevision: true } : {}),
    ...(edge.effects === undefined ? {} : { effects: edge.effects }),
  };
}

/** Returns the steps of a definition in kernel order, each with its phase kind and its group. */
function stepsOf(definition: ExarchosDefinition): readonly DecideStep[] {
  const groupOfStep = new Map<string, string>();
  for (const group of definition.exarchos.groups) {
    for (const member of group.members) groupOfStep.set(member, group.groupId);
  }
  return definition.steps.map((step) => {
    const stepType: unknown = 'stepType' in step ? step.stepType : undefined;
    const groupId = groupOfStep.get(step.stepId);
    return {
      stepId: step.stepId,
      isFinal: step.isTerminal,
      ...(!step.isTerminal && isPhaseKind(stepType) ? { kind: stepType } : {}),
      ...(groupId === undefined ? {} : { groupId }),
    };
  });
}

/** Returns the edge that a skip gives for one incoming edge and one outgoing edge of the skipped step. */
function reroutedEdge(incoming: DecideEdge, outgoing: DecideEdge): DecideEdge {
  const guardId = outgoing.guardId ?? incoming.guardId;
  const effects = outgoing.effects ?? incoming.effects;
  const isFixCycle = outgoing.isFixCycle ?? incoming.isFixCycle;
  return {
    edgeKind: 'explicit',
    transitionId: `${incoming.from}->${outgoing.to}`,
    from: incoming.from,
    to: outgoing.to,
    ...(guardId === undefined ? {} : { guardId }),
    category: outgoing.category,
    route: outgoing.route,
    ...(outgoing.presence === undefined ? {} : { presence: outgoing.presence }),
    ...(isFixCycle === undefined ? {} : { isFixCycle }),
    ...(incoming.isRevision === undefined ? {} : { isRevision: incoming.isRevision }),
    ...(effects === undefined ? {} : { effects }),
  };
}

/**
 * Checks each skip before any change, with the rules of the legacy skip.
 * @throws When a skip names a final step, the entry step, or a step with no incoming edge.
 */
function checkSkips(
  steps: readonly DecideStep[],
  groups: ExarchosExtension['groups'],
  entryStepId: string | undefined,
  edges: readonly DecideEdge[],
  skipPhases: readonly string[],
): void {
  for (const skip of skipPhases) {
    const step = steps.find((candidate) => candidate.stepId === skip);
    const isGroup = groups.some((group) => group.groupId === skip);
    if (step === undefined && !isGroup) continue;
    if (step?.isFinal === true) throw new Error(`Cannot skip final phase '${skip}'`);
    const hasNoIncoming = !edges.some((edge) => edge.to === skip);
    if (skip === entryStepId || hasNoIncoming) throw new Error(`Cannot skip initial phase '${skip}'`);
  }
}

/**
 * Routes the edges around each skipped step, in the order of the skip list. A skip of a group also drops
 * each edge to or from a member of the group. A skip that names no step and no group has no effect.
 */
function applySkips(
  steps: readonly DecideStep[],
  groups: ExarchosExtension['groups'],
  entryStepId: string | undefined,
  edges: readonly DecideEdge[],
  skipPhases: readonly string[],
): readonly DecideEdge[] {
  if (skipPhases.length === 0) return edges;
  checkSkips(steps, groups, entryStepId, edges, skipPhases);
  let routed: readonly DecideEdge[] = edges;
  for (const skip of skipPhases) {
    const group = groups.find((candidate) => candidate.groupId === skip);
    if (group === undefined && !steps.some((step) => step.stepId === skip)) continue;
    const outgoings = routed.filter((edge) => edge.from === skip);
    if (outgoings.length === 0) continue;
    const next: DecideEdge[] = [];
    for (const edge of routed) {
      if (edge.to === skip) {
        for (const outgoing of outgoings) next.push(reroutedEdge(edge, outgoing));
      } else if (edge.from !== skip) {
        next.push(edge);
      }
    }
    const members = new Set(group?.members ?? []);
    routed = next.filter((edge) => !members.has(edge.from) && !members.has(edge.to));
  }
  return routed;
}

/**
 * Compiles one definition into its decide form. The skip list routes the edges around each skipped step.
 * @throws When a transition has no edge in the extension, or when a condition does not compile. The message
 * names the edge.
 * @throws When a skip names a final step, the entry step or a step with no incoming edge. The message names the step.
 */
export function compileDecideDefinition(
  workflowType: string,
  definition: ExarchosDefinition,
  skipPhases: readonly string[] = [],
): DecideDefinition {
  const edges = definition.transitions.map((transition) => {
    const { transitionId, fromStepId, toStepId } = transition;
    const edge = definition.exarchos.edges[transitionId];
    if (edge === undefined) {
      throw new Error(`the edge '${workflowType} ${transitionId}' has no entry in the extension`);
    }
    return explicitEdge(workflowType, transitionId, fromStepId, toStepId, edge);
  });
  const steps = stepsOf(definition);
  const groups = definition.exarchos.groups;
  const cancelEdge = definition.exarchos.universal.find((edge) => edge.edgeKind === 'cancel');
  const cleanupEdge = definition.exarchos.universal.find((edge) => edge.edgeKind === 'cleanup');
  const cancel: UniversalMove | undefined =
    cancelEdge === undefined ? undefined : { edgeKind: 'cancel', to: cancelEdge.to };
  const cleanup: UniversalMove | undefined =
    cleanupEdge === undefined || cleanupEdge.edgeKind !== 'cleanup'
      ? undefined
      : {
          edgeKind: 'cleanup',
          to: cleanupEdge.to,
          guardId: cleanupEdge.guardId,
          condition: compilePart(workflowType, 'cleanup', 'route', MERGE_VERIFIED_NODE),
        };
  return {
    workflowType,
    ...(definition.entryStepId === undefined ? {} : { entryStepId: definition.entryStepId }),
    steps,
    groups,
    edges: applySkips(steps, groups, definition.entryStepId, edges, skipPhases),
    ...(cancel === undefined ? {} : { cancel }),
    ...(cleanup === undefined ? {} : { cleanup }),
  };
}
