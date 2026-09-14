// ─── Built-in workflows, lowered into the published kernel ───────────────────
//
// A capsule names the workflow definition it compiled from by digest, so that
// settlement can tell which definition the work ran under. The built-in
// workflows have no serialized definition of their own — their topology lives
// in the state machine — so the definition is lowered from that machine at
// compile time rather than written down a second time. A hand-authored copy
// would be one more place the topology could disagree with the machine that
// actually enforces it.
//
// What survives the lowering is topology, and only topology:
//
//   • every atomic and final state becomes a `skill` step typed by its phase
//     kind. A compound state has no step of its own and is flattened into its
//     children;
//   • every transition becomes a kernel transition. One leaving a compound
//     state leaves from each of its leaves, and one entering it enters at its
//     declared initial child;
//   • guards do not survive. The kernel's gate vocabulary has no slot for this
//     repository's obligations, and a guard lowered into a shape that means
//     something else would be worse than none. Obligations reach a capsule
//     through its completion predicate, in this repository's own condition
//     language.
//
// A custom workflow type has no machine here to lower, and is not lowered.

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
 * Throws only on a machine that cannot be lowered at all — a transition naming
 * an undeclared state, a compound state with no initial child. Those are
 * defects in the machine, and a definition that papered over them would pin a
 * topology the runtime does not have.
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

  // Two guarded transitions between the same pair of states are one edge of
  // topology; the guards that told them apart did not survive the lowering.
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
    // A workflow with two ways to end has no single terminal step to name.
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
