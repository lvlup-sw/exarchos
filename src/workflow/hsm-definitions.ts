import { guards, composeGuards } from './guards.js';
import type { Guard, GuardResult } from './guards.js';
import type { HSMDefinition, State, Transition } from './state-machine.js';
import { KIND_OBLIGATIONS, type PhaseKind } from './phase-kind.js';
import { builtInDefinition, type BuiltInDefinition } from './definitions/built-in.js';
import type { ExarchosExtension } from './definitions/extension.js';

/**
 * The composite guards of the built-in definitions. A composite runs its inner guards in order, and the
 * first failure decides. The binding table holds one object for each composite.
 */
const COMPOSITE_GUARDS: readonly Guard[] = [
  composeGuards(
    'all-tasks-complete+team-disbanded',
    'All tasks must be complete and team must be disbanded',
    guards.allTasksComplete,
    guards.teamDisbandedEmitted,
  ),
  composeGuards(
    'validation+pr-requested',
    'Validation must pass and PR must be requested',
    guards.validationPassed,
    guards.prRequested,
  ),
  composeGuards(
    'synthesize-retryable+thorough-track',
    'Synthesis retryable on thorough track',
    guards.synthesizeRetryable,
    guards.thoroughTrackSelected,
  ),
  composeGuards(
    'synthesize-retryable+hotfix-track',
    'Synthesis retryable on hotfix track',
    guards.synthesizeRetryable,
    guards.hotfixTrackSelected,
  ),
];

/**
 * Returns a map from each guard id to its guard.
 * @throws When two entries have the same id. The message names the id.
 */
export function buildGuardBindings(entries: readonly Guard[]): ReadonlyMap<string, Guard> {
  const bindings = new Map<string, Guard>();
  for (const guard of entries) {
    if (bindings.has(guard.id)) throw new Error(`the guard id '${guard.id}' has more than one binding`);
    bindings.set(guard.id, guard);
  }
  return bindings;
}

/**
 * The guard of each id that a built-in definition can name: each plain guard and the four composites.
 * The module load builds the table once, so each id has one guard object.
 */
export const GUARD_BINDINGS: ReadonlyMap<string, Guard> = buildGuardBindings([
  ...Object.values(guards),
  ...COMPOSITE_GUARDS,
]);

/** The prefix of the name of a built-in definition. The rest of the name is the id of the machine. */
const BUILT_IN_NAME_PREFIX = 'exarchos.';

/** One group of the extension of a definition. */
type DefinitionGroup = ExarchosExtension['groups'][number];

/** One kernel step of a definition. */
type DefinitionStep = BuiltInDefinition['steps'][number];

/** One kernel transition of a definition. */
type DefinitionTransition = BuiltInDefinition['transitions'][number];

/** The guard data of one kernel transition of a definition. */
type DefinitionEdge = ExarchosExtension['edges'][string];

/** True when the value is a phase kind, a key of the obligation table. */
function isPhaseKind(value: unknown): value is PhaseKind {
  return typeof value === 'string' && Object.hasOwn(KIND_OBLIGATIONS, value);
}

/**
 * Returns the id of the machine of a definition: its name without the built-in prefix.
 * @throws When the name does not start with the built-in prefix.
 */
function machineIdOf(definition: BuiltInDefinition): string {
  if (!definition.name.startsWith(BUILT_IN_NAME_PREFIX)) {
    throw new Error(`the definition '${definition.name}' does not have a built-in name`);
  }
  return definition.name.slice(BUILT_IN_NAME_PREFIX.length);
}

/** Returns the compound state of a group. Each list is a copy, so the state shares no list with the definition. */
function groupState(group: DefinitionGroup): State {
  return {
    id: group.groupId,
    type: 'compound',
    initial: group.initial,
    ...(group.maxFixCycles === undefined ? {} : { maxFixCycles: group.maxFixCycles }),
    ...(group.onEntry === undefined ? {} : { onEntry: [...group.onEntry] }),
    ...(group.onExit === undefined ? {} : { onExit: [...group.onExit] }),
  };
}

/**
 * Returns the state of a kernel step. A terminal step gives a final state. Each other step gives an atomic
 * state with the phase kind of its `stepType`, and with its group as its parent.
 * @throws When a step that is not terminal has no phase kind. The message names the step.
 */
function stepState(machineId: string, step: DefinitionStep, parent: string | undefined): State {
  if (step.isTerminal) return { id: step.stepId, type: 'final' };
  const stepType: unknown = 'stepType' in step ? step.stepType : undefined;
  if (!isPhaseKind(stepType)) {
    throw new Error(`the built-in step '${machineId} ${step.stepId}' has no phase kind`);
  }
  return parent === undefined
    ? { id: step.stepId, type: 'atomic', kind: stepType }
    : { id: step.stepId, type: 'atomic', kind: stepType, parent };
}

/**
 * Returns the transition of a kernel transition, with the guard that its edge names. The effects list is a
 * copy, so the transition shares no list with the definition.
 * @throws When the transition has no edge, when the edge names no guard, or when no guard binds the id.
 * The message names the edge.
 */
function machineTransition(
  machineId: string,
  transition: DefinitionTransition,
  edge: DefinitionEdge | undefined,
  bindings: ReadonlyMap<string, Guard>,
): Transition {
  const edgeName = `${machineId} ${transition.transitionId}`;
  if (edge === undefined) throw new Error(`the built-in edge '${edgeName}' has no authored edge`);
  if (edge.guardId === undefined) throw new Error(`the built-in edge '${edgeName}' names no guard`);
  const guard = bindings.get(edge.guardId);
  if (guard === undefined) {
    throw new Error(`the built-in edge '${edgeName}' names the unknown guard '${edge.guardId}'`);
  }
  return {
    from: transition.fromStepId,
    to: transition.toStepId,
    guard,
    ...(edge.isRevision === true ? { isRevision: true } : {}),
    ...(edge.isFixCycle === true ? { isFixCycle: true } : {}),
    ...(edge.effects === undefined ? {} : { effects: [...edge.effects] }),
  };
}

/**
 * Derives the phase machine of a built-in definition. Each call returns a fresh machine that shares no object
 * or list with the definition.
 *
 * The states follow kernel step order, and each group sits directly before its first member. The
 * transitions follow kernel transition order. Each state and each transition keeps the key order of the
 * hand-written machines, so the JSON of each machine stays the same. The universal edges are not
 * transitions, because the executor runs them.
 * @throws When the name is not a built-in name, when a step has no phase kind, or when an edge has no
 * bound guard. The message names the step or the edge.
 */
export function deriveMachine(
  definition: BuiltInDefinition,
  bindings: ReadonlyMap<string, Guard>,
): HSMDefinition {
  const id = machineIdOf(definition);
  const groupOfStep = new Map<string, DefinitionGroup>();
  for (const group of definition.exarchos.groups) {
    for (const member of group.members) groupOfStep.set(member, group);
  }
  const states: Record<string, State> = {};
  for (const step of definition.steps) {
    const group = groupOfStep.get(step.stepId);
    if (group !== undefined && !Object.hasOwn(states, group.groupId)) states[group.groupId] = groupState(group);
    states[step.stepId] = stepState(id, step, group?.groupId);
  }
  const transitions = definition.transitions.map((transition) =>
    machineTransition(id, transition, definition.exarchos.edges[transition.transitionId], bindings),
  );
  return { id, states, transitions };
}

/**
 * The feature workflow HSM, with `plan` as the initial state. It derives from
 * `definitions/feature.workflow.json`. `maxFixCycles: 3` bounds the delegate and review loop. Keep it
 * separate from the escalation auto-fix bound `DEFAULT_MAX_ITERATIONS`.
 *
 * The harness lands each accepted task head, and settle observes the landing by
 * ancestry, so the machine has no merge substate. Transitions are
 * first-match-wins, so the file puts `blocked` before the revise edge, and the revision
 * cap ends the loop. The cap counts the `prepare_review` dispatch events of this
 * loop, because the standard revise edge emits no `plan-revision` event.
 */
export function createFeatureHSM(): HSMDefinition {
  return deriveMachine(builtInDefinition('feature'), GUARD_BINDINGS);
}

/** The debug workflow HSM, with a thorough track and a hotfix track. It derives from `definitions/debug.workflow.json`. */
export function createDebugHSM(): HSMDefinition {
  return deriveMachine(builtInDefinition('debug'), GUARD_BINDINGS);
}

/**
 * The oneshot workflow HSM for small changes: plan, implementing, then a choice state. It derives from
 * `definitions/oneshot.workflow.json`. `implementing` has two mutually exclusive guards,
 * `synthesisOptedIn` and `synthesisOptedOut`. Both are pure functions of `synthesisPolicy` and the
 * `synthesize.requested` events. The file keeps both branches, so `getValidTransitions` advertises
 * both, and exactly one guard passes.
 */
export function createOneshotHSM(): HSMDefinition {
  return deriveMachine(builtInDefinition('oneshot'), GUARD_BINDINGS);
}

/** The discovery workflow HSM: gathering, then synthesizing. It derives from `definitions/discovery.workflow.json`. */
export function createDiscoveryHSM(): HSMDefinition {
  return deriveMachine(builtInDefinition('discovery'), GUARD_BINDINGS);
}

/**
 * The refactor workflow HSM, with a polish track and an overhaul track. It derives from
 * `definitions/refactor.workflow.json`. Transitions are first-match-wins, so the file puts `blocked`
 * before the overhaul revise edge, and the revision cap ends the loop. The revise edge sets
 * `isRevision`. Without it the revision count never increments, and the cap never trips.
 */
export function createRefactorHSM(): HSMDefinition {
  return deriveMachine(builtInDefinition('refactor'), GUARD_BINDINGS);
}
