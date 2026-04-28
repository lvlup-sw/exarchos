import { NextAction } from './next-action.js';
import type { HSMDefinition } from './workflow/state-machine.js';
import { EXCLUDED_MERGE_PHASES } from './workflow/hsm-definitions.js';

/**
 * Subset of workflow state inspected by {@link computeNextActions}.
 *
 * Most fields are optional because callers — especially callers that only
 * have a partial / projected view of state — should not be forced to
 * synthesize values they don't have. Missing fields simply mean the
 * corresponding action verb won't be surfaced.
 *
 * T18 / DR-MO-1 added `featureId` and `mergeOrchestrator` so the computer
 * can emit a `merge_orchestrate` verb (with idempotency key) when the
 * workflow is parked in `merge-pending` and the merge orchestrator hasn't
 * already terminated.
 */
export interface NextActionsState {
  phase?: string;
  workflowType?: string;
  /** Stream identifier — used as the `streamId` segment of merge idempotency keys. */
  featureId?: string;
  mergeOrchestrator?: {
    /**
     * Sub-state of the merge orchestrator. `pending` means the merge has
     * not yet been executed; values in {@link EXCLUDED_MERGE_PHASES}
     * (`completed`, `rolled-back`, `aborted`) mean it has terminated and
     * should not be re-triggered. Any other value is treated as
     * "not-yet-terminated" — i.e., still actionable.
     */
    phase?: string;
    /**
     * Identifier of the delegated task whose merge is pending. Surfaced as
     * the trailing segment of the merge idempotency key so re-invocations
     * for the same task collapse.
     */
    taskId?: string;
  };
}

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
 * T18 / DR-MO-1: when the workflow is parked in the `merge-pending`
 * substate and the merge orchestrator has not already terminated, an
 * additional `merge_orchestrate` action verb (carrying an idempotency key)
 * is appended so callers can auto-trigger the subagent worktree merge.
 * Unlike the HSM-derived verbs above, `merge_orchestrate` is an
 * *action* verb, not a phase name.
 *
 * No I/O, no side effects. Returns `[]` for unknown/missing phase.
 */
export function computeNextActions(
  state: NextActionsState,
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

  // T18 (DR-MO-1): surface `merge_orchestrate` when parked in `merge-pending`
  // and the merge orchestrator has not already terminated. Missing
  // `mergeOrchestrator.phase` is treated as "not yet terminated" — the
  // merge has been requested but no sub-phase has been recorded yet.
  if (phase === 'merge-pending') {
    const moPhase = state.mergeOrchestrator?.phase;
    const terminated = moPhase !== undefined && EXCLUDED_MERGE_PHASES.has(moPhase);
    if (!terminated) {
      // Only surface an idempotency key when both segments are real. An
      // `'unknown'` fallback would collapse unrelated invocations onto the
      // same key, defeating de-duplication.
      const taskId = state.mergeOrchestrator?.taskId;
      const streamId = state.featureId;
      const candidate: NextAction = {
        verb: 'merge_orchestrate',
        reason: 'Pending subagent worktree merge',
        validTargets: ['merge_orchestrate'],
        ...(taskId && streamId
          ? { idempotencyKey: `${streamId}:merge_orchestrate:${taskId}` }
          : {}),
      };
      const parsed = NextAction.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(
          `computeNextActions produced invalid merge_orchestrate NextAction: ${parsed.error.message}`,
        );
      }
      actions.push(parsed.data);
    }
  }

  return actions;
}
