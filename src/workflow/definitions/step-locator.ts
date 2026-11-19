/**
 * The step locator. It classifies the step of a phase from the data of a registered definition only.
 *
 * A task-batch step is a `skill` step of the step type `IMPLEMENT`. An exit of the step has a gate or an
 * approval whose presence requires every planned task to be complete. The capsule pins that condition as its
 * completion predicate. So a capsule never claims a completion that the exit of its step does not need.
 *
 * A presence requires the condition when its conjuncts hold every conjunct of the condition. The conjuncts of a node are
 * the node itself, or for an `all` node the conjuncts of each operand. An `any` node or a `not` node adds only itself, so
 * a clause under it never counts. A route never makes a task batch.
 */

import {
  FACT_DECLARATION,
  TASKS_COMPLETE_CONDITION,
} from '../admission/built-in-workflow-ir.js';
import { type EdgeConditionNode, tryCompileEdgeCondition } from '../admission/edge-condition.js';
import type { ExarchosDefinition } from './extension.js';

/** The kernel kind of a step that the locator can classify as a task batch. */
const SKILL_KIND = 'skill';

/** The step type of a step that implements the tasks of a plan. */
const IMPLEMENT_STEP_TYPE = 'IMPLEMENT';

/** The canonical JSON of each conjunct of the condition that every planned task is complete. */
const TASKS_COMPLETE_CONJUNCTS: readonly string[] = conjunctsOf(TASKS_COMPLETE_CONDITION.node);

/** The kind of a step that prepare compiles. */
type StepKind = 'task-batch';

/** The rule of a step that prepare does not compile. */
export type StepFindingRule = 'not-a-step' | 'terminal-step' | 'not-an-implement-step' | 'single-agent-step';

/** The class of one step: the kind of a compilable step, or the rule of a step that does not compile. */
type StepClass = StepKind | StepFindingRule;

/** A step that prepare compiles, with its kind. */
interface LocatedStep {
  readonly stepId: string;
  readonly kind: StepKind;
}

/** The result of {@link locateStep}: the located step, or the rule of the phase with the compilable steps of the definition. */
type StepLocation =
  | { readonly ok: true; readonly step: LocatedStep }
  | { readonly ok: false; readonly rule: StepFindingRule; readonly compilable: readonly string[] };

/**
 * The canonical JSON of each conjunct of a compiled node. An `all` node gives the conjuncts of each operand. Every other
 * node, `any` and `not` included, gives its own JSON. The JSON is the text that `serializeEdgeCondition` writes for a node.
 */
function conjunctsOf(node: EdgeConditionNode): string[] {
  return node.kind === 'all' ? node.operands.flatMap(conjunctsOf) : [JSON.stringify(node)];
}

/**
 * True when the condition requires every planned task to be complete. The condition compiles against the shared fact
 * vocabulary, and its conjuncts hold every conjunct of the task condition. The clauses can sit in one flat `all` node
 * beside other clauses, or in nested `all` nodes. A condition that does not compile never requires it.
 */
function requiresTasksComplete(node: unknown): boolean {
  const compiled = tryCompileEdgeCondition(node, FACT_DECLARATION);
  if (!compiled.ok) return false;
  const conjuncts = new Set(conjunctsOf(compiled.condition.node));
  return TASKS_COMPLETE_CONJUNCTS.every((conjunct) => conjuncts.has(conjunct));
}

/** True when an exit of the step has a gate or an approval whose presence requires every planned task to be complete. */
function exitRequiresTasksComplete(definition: ExarchosDefinition, stepId: string): boolean {
  const { edges } = definition.exarchos;
  return definition.transitions.some((transition) => {
    if (transition.fromStepId !== stepId || !Object.hasOwn(edges, transition.transitionId)) return false;
    const obligation = edges[transition.transitionId]?.obligation;
    return obligation !== undefined && obligation.kind !== 'none' && requiresTasksComplete(obligation.presence);
  });
}

/**
 * Classifies one step of a definition. The first match decides. The first rule is no step with the id, and the second
 * is a terminal step. The third is a step that is not a `skill` step of the step type `IMPLEMENT`. Then an exit
 * presence that requires every planned task to be complete gives a task batch. Each other step is a single-agent step.
 */
export function classifyStep(definition: ExarchosDefinition, stepId: string): StepClass {
  const step = definition.steps.find((candidate) => candidate.stepId === stepId);
  if (step === undefined) return 'not-a-step';
  if (step.isTerminal) return 'terminal-step';
  if (step.kind !== SKILL_KIND || step.stepType !== IMPLEMENT_STEP_TYPE) return 'not-an-implement-step';
  return exitRequiresTasksComplete(definition, stepId) ? 'task-batch' : 'single-agent-step';
}

/** The ids of the task-batch steps of a definition, in kernel order. */
export function compilableSteps(definition: ExarchosDefinition): readonly string[] {
  return definition.steps
    .filter((step) => classifyStep(definition, step.stepId) === 'task-batch')
    .map((step) => step.stepId);
}

/** Locates the step of a phase. A phase that is not a task-batch step gives its rule and the compilable steps of the definition. */
export function locateStep(definition: ExarchosDefinition, phase: string): StepLocation {
  const stepClass = classifyStep(definition, phase);
  if (stepClass === 'task-batch') return { ok: true, step: { stepId: phase, kind: stepClass } };
  return { ok: false, rule: stepClass, compilable: compilableSteps(definition) };
}
