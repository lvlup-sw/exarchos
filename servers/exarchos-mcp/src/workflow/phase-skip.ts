import type { HSMDefinition, Transition } from './state-machine.js';

/**
 * Apply phase skipping to an HSM definition by rerouting transitions
 * around skipped phases. Returns a new HSMDefinition; the original is
 * not mutated.
 *
 * Rules:
 * - Cannot skip the initial phase (no incoming transitions).
 * - Cannot skip a final phase.
 * - Nonexistent phase names are silently ignored.
 * - Skipping a compound state also removes transitions from its children.
 * - Guards on the skipped phase's outgoing transition are inherited by
 *   the predecessor transition. If the outgoing has no guard, the
 *   predecessor keeps its own guard.
 */
export function applyPhaseSkips(
  hsm: HSMDefinition,
  skipPhases: readonly string[],
): HSMDefinition {
  if (skipPhases.length === 0) return hsm;

  // Validate: cannot skip initial or final phases
  for (const skip of skipPhases) {
    const state = hsm.states[skip];
    if (!state) continue; // nonexistent = ignore

    if (state.type === 'final') {
      throw new Error(`Cannot skip final phase '${skip}'`);
    }

    // A phase with no incoming transitions is the initial phase
    const hasIncoming = hsm.transitions.some(t => t.to === skip);
    if (!hasIncoming) {
      throw new Error(`Cannot skip initial phase '${skip}'`);
    }
  }

  let transitions: Transition[] = hsm.transitions.map(t => ({ ...t }));

  for (const skip of skipPhases) {
    if (!hsm.states[skip]) continue;

    // Find the outgoing transition from the skipped phase
    const outgoing = transitions.find(t => t.from === skip);
    if (!outgoing) continue;

    // Reroute incoming transitions: point them to the skipped phase's target.
    // Guard inheritance: use the skipped phase's outgoing guard if it exists,
    // otherwise keep the predecessor's existing guard.
    transitions = transitions.map(t => {
      if (t.to === skip) {
        return {
          ...t,
          to: outgoing.to,
          guard: outgoing.guard ?? t.guard,
        };
      }
      return t;
    });

    // Remove all transitions originating from the skipped phase
    transitions = transitions.filter(t => t.from !== skip);

    // Also remove transitions from child states of compound states
    const childIds = new Set(
      Object.values(hsm.states)
        .filter(s => s.parent === skip)
        .map(s => s.id),
    );
    if (childIds.size > 0) {
      transitions = transitions.filter(t => !childIds.has(t.from));
    }
  }

  return { ...hsm, transitions };
}
