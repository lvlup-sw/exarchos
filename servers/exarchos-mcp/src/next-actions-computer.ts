import { NextAction } from './next-action.js';
import type { HSMDefinition } from './workflow/state-machine.js';
import { EXCLUDED_MERGE_PHASES } from './workflow/hsm-definitions.js';
import type { DesignDepth } from './workflow/plan-depth-policy.js';

// Wave 0 / Task D.8 — safety-semantics consumer contract.
//
// Design §2.4 commits that `annotations.safety` is consumed here and by
// HSM guards. At D.8 implementation time the current logic is purely
// HSM-topology driven (no in-handler prose infers safety semantics), so
// no read is needed today. The smoke test
// `D.8 — annotations.safety is queryable from registry` in
// `next-actions-computer.test.ts` pins the contract for future
// consumers: any branch on safety semantics MUST read
// `findActionInRegistry(toolName, actionName)?.annotations.safety`
// from `./registry.js` — the registry is the single source of truth
// (DIM-1 Topology). Do NOT hand-code the safety enum or duplicate
// the §2.4 table in handler prose.

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
  phase?: string | undefined;
  workflowType?: string | undefined;
  /** Stream identifier — used as the `streamId` segment of merge idempotency keys. */
  featureId?: string | undefined;
  /**
   * The feature's frozen planning depth (DR-7, #1581 task 018). When `'deep'`
   * and the current phase is a PLAN-kind authoring phase, the deep-rung
   * divergent-loop and discover-bridge affordances are surfaced on
   * `next_actions` (INV-12) — opt-in escalations the author may invoke; they
   * are never auto-run. Absent / `'thin'` / `'standard'` ⇒ not surfaced.
   */
  designDepth?: DesignDepth;
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
  } | undefined;
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

  // DR-7 (#1581 task 018): at the `deep` planning rung, surface the opt-in
  // divergent-loop + discover-bridge affordances during PLAN authoring. Gated
  // on the phase's KIND (PLAN), not its name (INV-6), and excludes the *-review
  // gate phases (the bridge is an authoring escalation, not a review action).
  // These are affordances the author MAY invoke — INV-12 publishes them via
  // next_actions; they never auto-run (the discover_bridge handler is
  // confirm-gated). Other workflow types never freeze `designDepth`, so the
  // block is inert outside the feature PLAN-authoring path.
  const currentKind = (currentState as { kind?: string }).kind;
  if (state.designDepth === 'deep' && currentKind === 'PLAN' && !phase.endsWith('-review')) {
    const deepAffordances: ReadonlyArray<{ verb: string; reason: string }> = [
      {
        verb: 'divergent_loop',
        reason: 'Deep rung: explore 2-3 distinct approaches with trade-offs before converging',
      },
      {
        verb: 'discover_bridge',
        reason:
          'Opt-in: escalate to a /exarchos:discover research pre-pass, stitched to the spec by correlationId (author-confirmed, never auto-run)',
      },
    ];
    for (const a of deepAffordances) {
      const candidate: NextAction = { verb: a.verb, reason: a.reason, validTargets: [a.verb] };
      const parsed = NextAction.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(
          `computeNextActions produced invalid deep-rung NextAction '${a.verb}': ${parsed.error.message}`,
        );
      }
      actions.push(parsed.data);
    }
  }

  // DR-2 (WLM slice 3, task 008): once a workflow reaches the SYNTHESIZE phase
  // its governed worktrees have served their purpose and begin to accumulate —
  // there is otherwise no GC cadence surfaced anywhere. Publish an INV-12
  // prune-cadence affordance suggesting a `prune_worktrees` dry-run so the
  // reclamation hint appears exactly when the workflow is finalizing, never
  // earlier. Gated on the phase's KIND (SYNTHESIZE), not its name (INV-6), so
  // it fires for every workflow type whose synthesis leg reuses that kind
  // (feature / debug / oneshot / refactor). `merge-pending` is kind MERGE (not
  // SYNTHESIZE), so the mid-implementation merge substate never triggers it.
  // Like the deep-rung affordances above this is an opt-in the caller MAY
  // invoke — dry-run first (the safe default), then re-invoke with dryRun:false
  // to apply; it never auto-runs, and prune_worktrees itself defaults to
  // dry-run (INV-5c).
  if (currentKind === 'SYNTHESIZE') {
    const candidate: NextAction = {
      verb: 'prune_worktrees',
      reason:
        'INV-12 GC cadence: the workflow has reached synthesis, so governed worktrees can be reclaimed. Run prune_worktrees as a dry-run first (the default — reports candidates + reclaimable bytes, deletes nothing), then re-invoke with dryRun:false to apply.',
      validTargets: ['prune_worktrees'],
      hint: 'dry-run first',
    };
    const parsed = NextAction.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `computeNextActions produced invalid prune_worktrees NextAction: ${parsed.error.message}`,
      );
    }
    actions.push(parsed.data);
  }

  return actions;
}
