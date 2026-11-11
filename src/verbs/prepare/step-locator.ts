/**
 * The step locator. It classifies the step of a phase from the data of a registered definition only.
 *
 * A task-batch step is a `skill` step of the step type `IMPLEMENT`. An exit of the step has a gate or an
 * approval whose presence requires every planned task to be complete. The capsule pins that condition as its
 * completion predicate. So a capsule never claims a completion that the exit of its step does not need.
 *
 * A presence requires the condition when it equals the condition. An `all` node with an operand that requires
 * the condition also requires it. An `any` node or a `not` node never requires it, and a route never makes a task batch.
 */

import {
  FACT_DECLARATION,
  TASKS_COMPLETE_CONDITION,
} from '../../workflow/admission/built-in-workflow-ir.js';
import { serializeEdgeCondition, tryCompileEdgeCondition } from '../../workflow/admission/edge-condition.js';
import type { ExarchosDefinition } from '../../workflow/definitions/extension.js';

/** The kernel kind of a step that the locator can classify as a task batch. */
const SKILL_KIND = 'skill';

/** The step type of a step that implements the tasks of a plan. */
const IMPLEMENT_STEP_TYPE = 'IMPLEMENT';

/** The canonical JSON of the condition that every planned task is complete. */
const TASKS_COMPLETE_TEXT = serializeEdgeCondition(TASKS_COMPLETE_CONDITION);

/** The kind of a step that prepare compiles. */
export type StepKind = 'task-batch';

/** The rule of a step that prepare does not compile. */
export type StepFindingRule = 'not-a-step' | 'terminal-step' | 'not-an-implement-step' | 'single-agent-step';

/** The class of one step: the kind of a compilable step, or the rule of a step that does not compile. */
export type StepClass = StepKind | StepFindingRule;

/** A step that prepare compiles, with its kind. */
export interface LocatedStep {
  readonly stepId: string;
  readonly kind: StepKind;
}

/** The result of {@link locateStep}: the located step, or the rule of the phase with the compilable steps of the definition. */
export type StepLocation =
  | { readonly ok: true; readonly step: LocatedStep }
  | { readonly ok: false; readonly rule: StepFindingRule; readonly compilable: readonly string[] };

/**
 * True when the condition requires every planned task to be complete. The condition compiles against the shared fact
 * vocabulary, and it requires the task condition when it serializes as that condition. An `all` node also requires it
 * when an operand requires it. A condition that does not compile never requires it.
 */
function requiresTasksComplete(node: unknown): boolean {
  const compiled = tryCompileEdgeCondition(node, FACT_DECLARATION);
  if (!compiled.ok) return false;
  if (serializeEdgeCondition(compiled.condition) === TASKS_COMPLETE_TEXT) return true;
  const condition = compiled.condition.node;
  return condition.kind === 'all' && condition.operands.some(requiresTasksComplete);
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
