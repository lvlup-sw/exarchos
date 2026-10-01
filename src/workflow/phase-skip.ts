import type { HSMDefinition, Transition } from './state-machine.js';
import { getInitialPhase } from './state-machine.js';

/**
 * Returns `hsm` with its transitions routed around each skipped phase, and does not mutate it.
 * Each incoming transition of a skipped phase becomes one transition to each outgoing target.
 * The new transition takes the guard, effects and `isFixCycle` of the outgoing transition, or keeps its own value.
 * Transitions to and from the children of a skipped compound state go away. Unknown phase names have no effect.
 * The registry gives the initial phase, because an initial phase can have an incoming edge.
 * @throws when a skip names a final phase, the initial phase, or a phase with no incoming transitions.
 */
export function applyPhaseSkips(
  hsm: HSMDefinition,
  skipPhases: readonly string[],
): HSMDefinition {
  if (skipPhases.length === 0) return hsm;

  let initialPhase: string | undefined;
  try {
    initialPhase = getInitialPhase(hsm.id);
  } catch {
    initialPhase = undefined;
  }

  for (const skip of skipPhases) {
    const state = hsm.states[skip];
    if (!state) continue;

    if (state.type === 'final') {
      throw new Error(`Cannot skip final phase '${skip}'`);
    }

    const isRegistryInitial = initialPhase !== undefined && skip === initialPhase;
    const hasNoIncoming = !hsm.transitions.some(t => t.to === skip);
    if (isRegistryInitial || hasNoIncoming) {
      throw new Error(`Cannot skip initial phase '${skip}'`);
    }
  }

  let transitions: Transition[] = hsm.transitions.map(t => ({ ...t }));

  for (const skip of skipPhases) {
    if (!hsm.states[skip]) continue;

    const outgoings = transitions.filter(t => t.from === skip);
    if (outgoings.length === 0) continue;

    const newTransitions: typeof transitions = [];
    for (const t of transitions) {
      if (t.to === skip) {
        for (const outgoing of outgoings) {
          newTransitions.push({
            ...t,
            to: outgoing.to,
            guard: outgoing.guard ?? t.guard,
            effects: outgoing.effects ?? t.effects,
            isFixCycle: outgoing.isFixCycle ?? t.isFixCycle,
          });
        }
      } else if (t.from !== skip) {
        newTransitions.push(t);
      }
    }
    transitions = newTransitions;

    const childIds = new Set(
      Object.values(hsm.states)
        .filter(s => s.parent === skip)
        .map(s => s.id),
    );
    if (childIds.size > 0) {
      transitions = transitions.filter(
        t => !childIds.has(t.from) && !childIds.has(t.to),
      );
    }
  }

  return { ...hsm, transitions };
}
