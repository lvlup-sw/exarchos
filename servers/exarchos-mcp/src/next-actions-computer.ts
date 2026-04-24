import { NextAction } from './next-action.js';
import type { HSMDefinition } from './workflow/state-machine.js';

/**
 * Pure function: compute the set of valid next actions for a workflow state
 * given the HSM topology. Used to populate the `next_actions` field of
 * HATEOAS rehydration envelopes (DR-8).
 *
 * Reads outbound transitions from the HSM for the current phase and emits
 * one `NextAction` per transition. Each returned action describes the verb
 * (target phase name — what the caller should transition to) and the reason
 * (the guard description, if any).
 *
 * No I/O, no side effects. Returns `[]` for unknown/missing phase.
 */
export function computeNextActions(
  state: { phase?: string; workflowType?: string },
  hsm: HSMDefinition,
): NextAction[] {
  const phase = state.phase;
  if (!phase) return [];

  const currentState = hsm.states[phase];
  if (!currentState) return [];
  if (currentState.type === 'final') return [];

  const seen = new Set<string>();
  const actions: NextAction[] = [];

  for (const t of hsm.transitions) {
    if (t.from !== phase) continue;
    if (seen.has(t.to)) continue;
    seen.add(t.to);

    const reason = t.guard
      ? t.guard.description
      : `Transition to ${t.to}`;

    const candidate: NextAction = {
      verb: t.to,
      reason,
      validTargets: [t.to],
    };

    // Defensive: validate every produced NextAction against the Zod schema
    // so we fail loud on shape drift rather than shipping malformed envelopes.
    const parsed = NextAction.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `computeNextActions produced invalid NextAction for ${phase} → ${t.to}: ${parsed.error.message}`,
      );
    }
    actions.push(parsed.data);
  }

  return actions;
}
