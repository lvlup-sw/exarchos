import { NextAction, RegistryAdvertisement, isControlOwnedVerb } from './next-action.js';
import { getFullRegistry } from './registry.js';
import type { HSMDefinition } from './workflow/state-machine.js';
import { EXCLUDED_MERGE_PHASES } from './workflow/hsm-definitions.js';
import type { DesignDepth } from './workflow/plan-depth-policy.js';
import { evaluateActionAdmission } from './workflow/admission/action-admission.js';
import {
  adjudicateOutboundEdges,
  defaultTranslationContext,
  type OutboundEdgeVerdict,
} from './workflow/admission/legacy-state-translation.js';

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
  /**
   * DR-9 (T-13) — the admission-fact carrier.
   *
   * Before this field existed the seam was too narrow for the fix to be
   * possible at all: `NextActionsState` carried only `phase`, `workflowType`,
   * `featureId`, `designDepth` and `mergeOrchestrator`, deliberately omitting
   * `artifacts` / `reviews` / `tasks` / `_cleanup` — i.e. exactly what every
   * guard and every admission obligation reads. So the computer had nothing to
   * decide with and fell back to `t.guard.description` prose.
   *
   * Supplying this widens the seam without breaking purity: the facts are
   * PASSED IN, never fetched. When present, {@link computeNextActions} asks the
   * admission projection for a per-edge verdict and omits any verb admission
   * would deny. When absent, the computer keeps its pre-DR-9 topology-only
   * behaviour — an affordance list is advisory, and a caller that supplies no
   * facts must not have its affordances silently emptied.
   */
  admission?: AdmissionFacts | undefined;
  /**
   * Workflow-scoped ActionId admission inputs. Distinct from the HSM-edge
   * `admission` carrier: registry advertisements use the shared ActionId
   * evaluator and publish only an allow verdict.
   */
  actionAdmission?: ActionAdmissionFacts | undefined;
}

/**
 * The legacy-state slice + trusted instant the admission projection needs to
 * decide an edge. Deliberately opaque (`Record<string, unknown>`): the closed
 * fact vocabulary and every state-shape read live in
 * `workflow/admission/legacy-state-translation.ts`, which is the single
 * authority for projecting legacy state into admission facts. Re-declaring the
 * shape here would create a second, driftable copy of that vocabulary.
 */
export interface AdmissionFacts {
  /** The legacy workflow state the admission projection reads its facts from. */
  readonly state: Readonly<Record<string, unknown>>;
  /**
   * Trusted RFC3339 evaluation instant — never `Date.now()`. Callers thread the
   * state's own `updatedAt` through, which keeps the computer deterministic:
   * the same state always yields the same affordances.
   */
  readonly evaluatedAt: string;
  /**
   * Whether `state` still carries its event log (`_events`). Defaults to
   * `false`, the fail-safe direction — see
   * {@link adjudicateOutboundEdges}: edges whose decision needs the log are
   * reported undecidable and keep being advertised rather than being
   * suppressed on facts the caller never supplied.
   */
  readonly eventLogAvailable?: boolean;
}

/**
 * Trusted ActionId-admission inputs for the registry advertisement envelope.
 *
 * Feature/stream subject, persisted evidence, authorization, and HSM facts
 * only. Wall-clock and request payload are not members. When this carrier
 * is absent the computer publishes no registry ActionIds — topology alone
 * is not an advertisement authority. The named exception is the control
 * verb `merge_orchestrate`, which may still surface from recorded
 * merge-pending topology on the HSM envelope.
 */
export interface ActionAdmissionFacts {
  readonly subject: { readonly featureId: string; readonly stream: string };
  readonly evidence: readonly unknown[];
  readonly authorization?: unknown;
  readonly hsmFacts?: { readonly phase: string; readonly phaseAttemptId?: string };
  /**
   * Optional ActionId subset. When omitted, every contracted, phase-eligible
   * registry action is considered. Control-owned verbs and phase names are
   * never candidates.
   */
  readonly actionIds?: readonly string[];
}

/** Hint attached to a published verb whose admission verdict was not `allow`. */
const ADMISSION_INDETERMINATE_HINT =
  'admission: indeterminate — the transition guard may still deny this move';
const ADMISSION_UNDECIDABLE_HINT =
  'admission: undecidable — this edge is decided from the workflow event log, which this payload does not carry';

/**
 * DR-9 — ask the admission projection for a verdict per outbound edge.
 *
 * Returns `null` when the caller supplied no admission facts (topology-only
 * mode) or when adjudication is impossible, in which case the computer keeps
 * its pre-DR-9 behaviour. Adjudication faults fail OPEN for affordances: a
 * malformed `evaluatedAt` or an IR/state shape the translation rejects must
 * degrade to "advertise everything the topology allows", never to a silently
 * empty affordance list that would strand the caller.
 */
function admissionVerdicts(
  state: NextActionsState,
  phase: string,
): ReadonlyMap<string, OutboundEdgeVerdict> | null {
  const admission = state.admission;
  const workflowType = state.workflowType;
  if (admission === undefined || !workflowType) return null;
  try {
    return adjudicateOutboundEdges(
      workflowType,
      phase,
      admission.state,
      defaultTranslationContext(admission.evaluatedAt),
      { eventLogAvailable: admission.eventLogAvailable ?? false },
    );
  } catch {
    return null;
  }
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
 * DR-9 (T-13): when `state.admission` carries the fact slice, each HSM-derived
 * verb is checked against the ADMISSION verdict for that edge and dropped when
 * admission would deny it — the runtime no longer advertises moves the
 * transition guard will refuse. Topology and admission remain two distinct
 * authorities: the topology decides which edges EXIST, admission decides which
 * are currently TAKEABLE, and `next-actions-computer.test.ts` cross-checks the
 * published set against the admission verdict computed independently.
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

  const verdicts = admissionVerdicts(state, phase);
  const seen = new Set<string>();
  const actions: NextAction[] = [];

  for (const t of hsm.transitions) {
    if (t.from !== phase) continue;
    if (seen.has(t.to)) continue;
    seen.add(t.to);

    // DR-9: an edge admission would DENY is not an affordance. An edge with no
    // shared-IR entry yields `undefined` — no admission opinion, so the verb is
    // published exactly as before.
    const verdict = verdicts?.get(t.to);
    if (verdict?.verdict === 'deny') continue;

    const reason = t.guard
      ? t.guard.description
      : `Transition to ${t.to}`;

    const candidate: NextAction = {
      verb: t.to,
      reason,
      validTargets: [t.to],
      ...(verdict !== undefined && verdict.verdict !== 'allow'
        ? {
            hint: verdict.undecidable
              ? ADMISSION_UNDECIDABLE_HINT
              : ADMISSION_INDETERMINATE_HINT,
          }
        : {}),
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCapabilityGated(contract: unknown): boolean {
  if (!isPlainRecord(contract)) return false;
  const needs = contract.needs;
  return isPlainRecord(needs) && needs.kind === 'declared';
}

function registryActionId(toolName: string, actionName: string): string {
  return `${toolName}.${actionName}`;
}

/**
 * The two next-action envelopes: HSM/control verbs and allow-only registry
 * ActionIds. They are computed together so callers cannot accidentally
 * publish one without applying the other's rule, but they stay distinct
 * arrays — phase and control verbs never become ActionIds.
 */
export interface NextActionEnvelopes {
  readonly control: readonly NextAction[];
  readonly registry: readonly RegistryAdvertisement[];
}

export function computeNextActionEnvelopes(
  state: NextActionsState,
  hsm: HSMDefinition,
): NextActionEnvelopes {
  return {
    control: computeNextActions(state, hsm),
    registry: computeRegistryAdvertisements(state),
  };
}

/**
 * Publish registry ActionIds that the shared ActionId evaluator allows.
 *
 * Denied, indeterminate, and evaluation faults are omitted. Missing
 * authorization omits capability-gated ActionIds rather than treating
 * the gap as allow. Host-owned actions may appear when those local
 * checks pass. Topology without this carrier publishes nothing.
 */
export function computeRegistryAdvertisements(
  state: NextActionsState,
): readonly RegistryAdvertisement[] {
  const facts = state.actionAdmission;
  const phase = facts?.hsmFacts?.phase ?? state.phase;
  if (facts === undefined || !phase) return [];

  const wanted =
    facts.actionIds === undefined ? undefined : new Set(facts.actionIds);
  const advertised: RegistryAdvertisement[] = [];
  const hsmFacts =
    facts.hsmFacts === undefined
      ? { phase }
      : facts.hsmFacts.phaseAttemptId === undefined
        ? { phase: facts.hsmFacts.phase }
        : {
            phase: facts.hsmFacts.phase,
            phaseAttemptId: facts.hsmFacts.phaseAttemptId,
          };

  for (const tool of getFullRegistry()) {
    if (tool.hidden === true) continue;
    for (const action of tool.actions) {
      const actionId = registryActionId(tool.name, action.name);
      if (wanted !== undefined && !wanted.has(actionId)) continue;
      if (isControlOwnedVerb(action.name) || isControlOwnedVerb(actionId)) {
        continue;
      }
      if (!('actionContract' in action)) continue;
      if (action.phases.size === 0 || !action.phases.has(phase)) continue;

      const contract = Reflect.get(action, 'actionContract');
      if (facts.authorization === undefined && isCapabilityGated(contract)) {
        continue;
      }
      if (facts.authorization === undefined) continue;

      try {
        const decision = evaluateActionAdmission(
          actionId,
          {
            actionId,
            subject: facts.subject,
            evidence: facts.evidence,
            authorization: facts.authorization,
            hsmFacts,
          },
          contract,
        );
        if (decision.verdict !== 'allow') continue;
        const parsed = RegistryAdvertisement.safeParse({
          actionId,
          subject: facts.subject,
          digest: decision.digest,
        });
        if (!parsed.success) continue;
        advertised.push(parsed.data);
      } catch {
        // An evaluation fault is not an allow and is not a topology fallback.
      }
    }
  }

  return advertised;
}
