/**
 * Lowers a built-in workflow from its state machine into a published kernel
 * definition at compile time.
 *
 * A capsule names its definition by digest, so settlement knows the definition
 * that the work ran under. The topology comes only from the state machine, so
 * no second copy can disagree with it. Only topology survives the lowering:
 *
 * - An atomic state becomes a `skill` step typed by its phase kind. A final
 *   state becomes a terminal step. A compound state flattens into its children.
 * - A transition from a compound state leaves from each of its leaves. A
 *   transition into a compound state enters at its initial child.
 * - Guards do not survive. The kernel gate vocabulary has no slot for these
 *   obligations, and a guard in a shape with a different meaning is worse than
 *   none. Obligations reach a capsule through its completion predicate.
 *
 * A custom workflow type has no machine here, so it is not lowered.
 */

import {
  WorkflowDefinitionV1Schema,
  type WorkflowDefinitionV1,
} from '@lvlup-sw/strategos-contracts';

import { contentDigest } from '../../contract/capsule/capsule-digest.js';
import {
  getHSMDefinition,
  getInitialPhase,
  isBuiltInWorkflowType,
  type State,
} from '../../workflow/state-machine.js';
import { builtInWorkflowAuthority } from './built-in-authority.js';

export interface LoweredBuiltInDefinition {
  readonly workflowType: string;
  readonly definition: WorkflowDefinitionV1;
  /** Bare hex over the definition's canonical JSON — the digest a capsule pins. */
  readonly definitionVersion: string;
}

type KernelStep = WorkflowDefinitionV1['steps'][number];
type KernelTransition = WorkflowDefinitionV1['transitions'][number];

/**
 * Lower one built-in workflow into a kernel definition, or return `undefined`
 * for a type with no built-in machine.
 *
 * Two guarded transitions between the same two states become one edge. A
 * workflow without exactly one final state gets no `terminalStepId`.
 *
 * @throws When a transition names an undeclared state, a compound state has no
 * initial child, or the result fails the kernel contract.
 */
export function lowerBuiltInDefinition(workflowType: string): LoweredBuiltInDefinition | undefined {
  if (!isBuiltInWorkflowType(workflowType)) return undefined;
  const hsm = getHSMDefinition(workflowType);
  const states = Object.values(hsm.states);

  const stateOf = (id: string): State => {
    const state = hsm.states[id];
    if (state === undefined) {
      throw new Error(`workflow '${workflowType}' names state '${id}', which it does not declare`);
    }
    return state;
  };
  const entryOf = (id: string): string => {
    const state = stateOf(id);
    if (state.type !== 'compound') return id;
    if (state.initial === undefined) {
      throw new Error(
        `compound state '${id}' of workflow '${workflowType}' declares no initial child, so nothing enters it`,
      );
    }
    return entryOf(state.initial);
  };
  const leavesOf = (id: string): string[] => {
    const state = stateOf(id);
    if (state.type !== 'compound') return [id];
    return states.filter((child) => child.parent === id).flatMap((child) => leavesOf(child.id));
  };

  const steps: KernelStep[] = states
    .filter((state) => state.type !== 'compound')
    .map((state) => ({
      kind: 'skill',
      stepId: state.id,
      stepName: state.id,
      isTerminal: state.type === 'final',
      runtime: 'exarchos',
      stepType: state.type === 'atomic' ? state.kind : 'final',
    }));

  const transitions: KernelTransition[] = [];
  const seen = new Set<string>();
  for (const transition of hsm.transitions) {
    const to = entryOf(transition.to);
    for (const from of leavesOf(transition.from)) {
      const transitionId = `${from}->${to}`;
      if (seen.has(transitionId)) continue;
      seen.add(transitionId);
      transitions.push({ transitionId, fromStepId: from, toStepId: to, isDefault: false });
    }
  }

  const terminals = steps.filter((step) => step.isTerminal);
  const onlyTerminal = terminals.length === 1 ? terminals[0] : undefined;
  const parsed = WorkflowDefinitionV1Schema.safeParse({
    schemaVersion: '1.0',
    name: `exarchos.${workflowType}`,
    steps,
    transitions,
    branchPoints: [],
    loops: [],
    forkPoints: [],
    failureHandlers: [],
    approvalPoints: [],
    authority: builtInWorkflowAuthority(),
    entryStepId: entryOf(getInitialPhase(workflowType)),
    ...(onlyTerminal !== undefined ? { terminalStepId: onlyTerminal.stepId } : {}),
  });
  if (!parsed.success) {
    throw new Error(
      `the lowered '${workflowType}' definition fails the published kernel contract: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return {
    workflowType,
    definition: parsed.data,
    definitionVersion: contentDigest(parsed.data),
  };
}
