/**
 * The five built-in workflows in the shared admission IR.
 *
 * The edges derive from the authored built-in definitions. Each kernel transition gives one edge, in kernel order.
 * The `exarchos` extension of the definition gives the guard id, the category, the route and the obligation of the edge.
 *
 * Each edge has a route condition as a compiled {@link CompiledEdgeCondition} and an admission obligation as data.
 * It also carries the phase kind and the legacy guard id for the live shadow observer.
 * Route conditions and presence probes use one fact vocabulary, {@link FACT_DECLARATION}.
 * The `legacy-state-translation` module projects legacy state into it. Nothing here reads state.
 *
 * This module has no import path to a legacy guard module: `guards.ts`, `hsm-definitions.ts`, `config/guards.ts` or `config/register.ts`.
 * `built-in-workflow-ir.structure.test.ts` proves this.
 */

import {
  compileEdgeCondition,
  type CompiledEdgeCondition,
  type EdgeConditionDeclaration,
} from './edge-condition.js';
import { KIND_OBLIGATIONS, type PhaseKind } from '../phase-kind.js';
import {
  BUILT_IN_WORKFLOW_TYPES,
  builtInDefinition,
  type BuiltInDefinition,
  type BuiltInWorkflowType,
} from '../definitions/built-in.js';
import type { EdgeCategory, ExarchosExtension } from '../definitions/extension.js';

export { BUILT_IN_WORKFLOW_TYPES };
export type { BuiltInWorkflowType, EdgeCategory };

/**
 * The admission obligation of an edge after the route is legal.
 * `none` has no evidence obligation. `gate` and `approval` have a `presence` probe.
 * The translation evaluates the probe against the projected legacy state. The probe is separate from the route condition.
 */
export type EdgeObligation =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'gate';
      readonly gateId: string;
      readonly presence: CompiledEdgeCondition;
    }
  | {
      readonly kind: 'approval';
      readonly approvalClass: string;
      readonly minimumApprovals: number;
      readonly presence: CompiledEdgeCondition;
    };

/** One built-in-workflow edge, fully expressed in shared IR. */
export interface WorkflowEdgeIR {
  readonly workflowType: BuiltInWorkflowType;
  readonly from: string;
  readonly to: string;
  /** The phase kind that this edge enters. A final edge uses the source kind. */
  readonly toPhaseKind: PhaseKind;
  /** The classification category of this edge. */
  readonly category: EdgeCategory;
  /** The legacy guard id, as a string only and never a reference to guard code. `null` when the edge has no guard. */
  readonly legacyGuardId: string | null;
  /** The route legality. An edge without a route selector uses `all([])`, which is always legal. */
  readonly routeCondition: CompiledEdgeCondition;
  /** The admission obligation after the route is legal. */
  readonly obligation: EdgeObligation;
}

/**
 * The closed fact vocabulary of all route conditions and presence probes.
 * The projector of the translation produces exactly these facts. A test proves that it can fill each field that the IR uses.
 */
export const FACT_DECLARATION: EdgeConditionDeclaration = {
  fields: {
    'artifacts.plan': 'string',
    plan: 'string',
    'artifacts.pr': 'string',
    'synthesis.prUrl': 'string',
    'artifacts.rca': 'string',
    'artifacts.fixDesign': 'string',
    'artifacts.report': 'string',
    'triage.symptom': 'string',
    'explore.scopeAssessment': 'string',
    'resolution.commitSha': 'string',
    'synthesis.lastError': 'string',
    track: 'string',
    'oneshot.synthesisPolicy': 'string',
    'planReview.approved': 'boolean',
    'planReview.gapsFound': 'boolean',
    'validation.testsPass': 'boolean',
    'validation.docsUpdated': 'boolean',
    'implementation.complete': 'boolean',
    unblocked: 'boolean',
    'tasks.allComplete': 'boolean',
    'reviews.allPassed': 'boolean',
    'reviews.anyFailed': 'boolean',
    'synthesis.requested': 'boolean',
    'investigation.escalate': 'boolean',
    'resolution.directPush': 'boolean',
    'cleanup.mergeVerified': 'boolean',
    'mergePending.entryReady': 'boolean',
    'mergePending.exitReady': 'boolean',
    'team.disbandedOk': 'boolean',
    /**
     * This fact and the next two come from config. `projectStateToFacts` resolves them from the state that the legacy guard reads.
     * A hardcoded threshold here becomes a second authority that can drift and over-admit.
     */
    'planReview.revisionsExhausted': 'boolean',
    'reviews.requiredSatisfied': 'boolean',
    'artifacts.planNonEmpty': 'boolean',
    /** This counter and `policy.maxPlanRevisions` are evidence for an explanation. They do not make the decision. */
    'planReview.revisionCount': 'number',
    'policy.maxPlanRevisions': 'number',
    'synthesis.retryCount': 'number',
    'tasks.count': 'number',
    'artifacts.sources.count': 'number',
  },
  events: ['synthesize.requested'],
} as const satisfies EdgeConditionDeclaration;

function compile(node: unknown): CompiledEdgeCondition {
  return compileEdgeCondition(node, FACT_DECLARATION);
}

/** The always-legal route (no branch selector on the edge). */
const ALWAYS_LEGAL: CompiledEdgeCondition = compile({ kind: 'all', operands: [] });

const NONE: EdgeObligation = Object.freeze({ kind: 'none' });

/** The condition that the plan has at least one task and that every task is complete. */
const TASKS_COMPLETE = {
  kind: 'all',
  operands: [
    { kind: 'counterCompare', field: 'tasks.count', op: 'gte', value: 1 },
    { kind: 'factEquals', field: 'tasks.allComplete', value: true },
  ],
};

/**
 * The compiled obligation that every planned task is complete. The capsule compiler uses it.
 * The feature delegate edge also requires team teardown, but teardown is a harness detail.
 * Thus a capsule that requires teardown binds every runtime to one harness.
 * A test proves that it equals the gate presence of the refactor edge from `overhaul-delegate` to `overhaul-review`.
 */
export const TASKS_COMPLETE_CONDITION: CompiledEdgeCondition = compile(TASKS_COMPLETE);

/** The guard data of one edge in an authored definition. */
type AuthoredEdge = ExarchosExtension['edges'][string];

/** True when the value is a phase kind, a key of the obligation table. */
function isPhaseKind(value: unknown): value is PhaseKind {
  return typeof value === 'string' && Object.hasOwn(KIND_OBLIGATIONS, value);
}

/** Returns the phase kind of each step that has one. A final step has no phase kind. */
function stepKinds(definition: BuiltInDefinition): ReadonlyMap<string, PhaseKind> {
  const kinds = new Map<string, PhaseKind>();
  for (const step of definition.steps) {
    const stepType: unknown = 'stepType' in step ? step.stepType : undefined;
    if (isPhaseKind(stepType)) kinds.set(step.stepId, stepType);
  }
  return kinds;
}

/**
 * Compiles one condition of an edge against the fact vocabulary.
 * @throws When the condition does not compile. The message names the workflow type, the transition and the part of the edge.
 */
function compileEdgePart(
  type: BuiltInWorkflowType,
  transitionId: string,
  part: 'route' | 'presence',
  node: unknown,
): CompiledEdgeCondition {
  try {
    return compile(node);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`the ${part} of the built-in edge '${type} ${transitionId}' does not compile: ${reason}`, {
      cause: error,
    });
  }
}

/** Returns the IR obligation of an authored edge. A gate or an approval compiles its presence probe. */
function obligationOf(type: BuiltInWorkflowType, transitionId: string, edge: AuthoredEdge): EdgeObligation {
  const obligation = edge.obligation;
  switch (obligation.kind) {
    case 'none':
      return NONE;
    case 'gate':
      return Object.freeze({
        kind: 'gate',
        gateId: obligation.gateId,
        presence: compileEdgePart(type, transitionId, 'presence', obligation.presence),
      });
    case 'approval':
      return Object.freeze({
        kind: 'approval',
        approvalClass: obligation.approvalClass,
        minimumApprovals: obligation.minimumApprovals,
        presence: compileEdgePart(type, transitionId, 'presence', obligation.presence),
      });
  }
}

/**
 * Derives the IR edges of one built-in workflow from its definition, in kernel order.
 * An edge enters the phase kind of its target. An edge to a final step enters the phase kind of its source.
 * @throws When a transition has no authored edge, when an endpoint has no phase kind, or when a condition does not compile.
 * The message names the edge.
 */
export function deriveWorkflowEdges(
  type: BuiltInWorkflowType,
  definition: BuiltInDefinition,
): readonly WorkflowEdgeIR[] {
  const kinds = stepKinds(definition);
  const finals = new Set(definition.steps.filter((step) => step.isTerminal).map((step) => step.stepId));
  return definition.transitions.map((transition) => {
    const { transitionId, fromStepId: from, toStepId: to } = transition;
    const edge = definition.exarchos.edges[transitionId];
    if (edge === undefined) {
      throw new Error(`the built-in edge '${type} ${transitionId}' has no authored edge`);
    }
    const sourceKind = kinds.get(from);
    const targetKind = kinds.get(to);
    if (sourceKind === undefined || (targetKind === undefined && !finals.has(to))) {
      throw new Error(`the built-in edge '${type} ${transitionId}' has an endpoint with no phase kind`);
    }
    return Object.freeze({
      workflowType: type,
      from,
      to,
      toPhaseKind: targetKind ?? sourceKind,
      category: edge.category,
      legacyGuardId: edge.guardId ?? null,
      routeCondition:
        edge.route === undefined ? ALWAYS_LEGAL : compileEdgePart(type, transitionId, 'route', edge.route),
      obligation: obligationOf(type, transitionId, edge),
    });
  });
}

/** All built-in workflow edges in shared IR: the types in roster order, and the edges of each type in kernel order. */
export const BUILT_IN_WORKFLOW_IR: readonly WorkflowEdgeIR[] = Object.freeze(
  BUILT_IN_WORKFLOW_TYPES.flatMap((type) => deriveWorkflowEdges(type, builtInDefinition(type))),
);

const EDGE_INDEX: ReadonlyMap<string, WorkflowEdgeIR> = new Map(
  BUILT_IN_WORKFLOW_IR.map((e) => [edgeKey(e.workflowType, e.from, e.to), e]),
);

/** The canonical key of an edge. The IR and the translation use the same key. */
export function edgeKey(
  workflowType: string,
  from: string,
  to: string,
): string {
  return `${workflowType}:${from}:${to}`;
}

/** Returns the shared-IR edge for a workflow, source and target, or undefined. */
export function getEdgeIR(
  workflowType: string,
  from: string,
  to: string,
): WorkflowEdgeIR | undefined {
  return EDGE_INDEX.get(edgeKey(workflowType, from, to));
}

/** All edges for one built-in workflow, in declaration order. */
export function edgesForWorkflow(
  workflowType: BuiltInWorkflowType,
): readonly WorkflowEdgeIR[] {
  return BUILT_IN_WORKFLOW_IR.filter((e) => e.workflowType === workflowType);
}
