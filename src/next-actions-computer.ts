/**
 * Computes the next-action envelopes of a workflow state from the HSM topology and the admission
 * verdicts. A branch on safety semantics must read `annotations.safety` from the registry through
 * `findActionInRegistry`. Do not copy the safety enum into this module.
 */
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

/**
 * The subset of workflow state that {@link computeNextActions} reads. Most fields are optional, so
 * a caller with a partial view does not invent values. A missing field means that the related verb
 * does not surface.
 */
export interface NextActionsState {
  phase?: string | undefined;
  workflowType?: string | undefined;
  /** Stream identifier — used as the `streamId` segment of merge idempotency keys. */
  featureId?: string | undefined;
  /**
   * The frozen planning depth of the feature. When it is `'deep'` and the phase is a PLAN-kind
   * authoring phase, `next_actions` offers the opt-in `divergent_loop` affordance. The affordance
   * never runs automatically.
   */
  designDepth?: DesignDepth;
  mergeOrchestrator?: {
    /**
     * Sub-state of the merge orchestrator. `pending` means that the merge did not run yet. A value
     * in {@link EXCLUDED_MERGE_PHASES} means that the merge terminated and must not run again. Any
     * other value is still actionable.
     */
    phase?: string;
    /**
     * The delegated task whose merge is pending. It is the last segment of the merge idempotency
     * key, so repeated calls for the same task collapse.
     */
    taskId?: string;
  } | undefined;
  /**
   * The admission facts. The caller passes them in, so the computer stays pure. When they are
   * present, {@link computeNextActions} drops each verb that admission denies. When they are
   * absent, the computer uses topology only, so a caller with no facts keeps its affordances.
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
 * The legacy-state slice and the trusted instant that the admission projection needs to decide an
 * edge. The state is opaque, because `workflow/admission/legacy-state-translation.ts` owns the fact
 * vocabulary. A second shape here can drift from it.
 */
export interface AdmissionFacts {
  /** The legacy workflow state the admission projection reads its facts from. */
  readonly state: Readonly<Record<string, unknown>>;
  /**
   * Trusted RFC3339 evaluation instant, never `Date.now()`. Callers pass the `updatedAt` of the
   * state, so the same state always gives the same affordances.
   */
  readonly evaluatedAt: string;
  /**
   * True when `state` still carries its event log (`_events`). The default is `false`, the safe
   * direction: {@link adjudicateOutboundEdges} reports log-decided edges as undecidable and keeps
   * them.
   */
  readonly eventLogAvailable?: boolean;
}

/**
 * Trusted ActionId-admission inputs for the registry advertisement envelope: the subject, the
 * persisted evidence, the authorization and the HSM facts. Wall-clock time and the request payload
 * are not members. Without this carrier, the computer publishes no registry ActionIds.
 *
 * The exception is `merge_orchestrate` on the control envelope. It is a capability-gated registry
 * action, and a rehydrate snapshot often has no authorization. Thus the control envelope still
 * surfaces it from recorded merge-pending topology.
 */
export interface ActionAdmissionFacts {
  readonly subject: { readonly featureId: string; readonly stream: string };
  readonly evidence: readonly unknown[];
  readonly authorization?: unknown;
  readonly hsmFacts?: { readonly phase: string; readonly phaseAttemptId?: string };
  /**
   * Optional ActionId subset. When it is absent, the computer considers each contracted,
   * phase-eligible registry action. Control-owned verbs are never candidates.
   */
  readonly actionIds?: readonly string[];
}

/** Hint for a published verb whose admission verdict is `indeterminate`. */
const ADMISSION_INDETERMINATE_HINT =
  'admission: indeterminate — the transition guard may still deny this move';
/** Hint for a published verb whose edge the event log decides. */
const ADMISSION_UNDECIDABLE_HINT =
  'admission: undecidable — this edge is decided from the workflow event log, which this payload does not carry';

/**
 * Asks the admission projection for a verdict on each outbound edge. Returns `null` when the
 * state has no admission facts or no workflow type, or when adjudication throws. The computer then
 * uses topology only. A fault fails open, so a bad `evaluatedAt` does not empty the affordance list.
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
 * Pure function: computes the next actions of a workflow state from the HSM topology. Each
 * outbound transition gives one `NextAction`, with the target phase as the verb and the guard
 * description as the reason. An unknown, missing or final phase gives `[]`.
 *
 * - With admission facts, it drops each edge that admission denies and adds a hint to a verdict
 *   other than `allow`. An edge with no verdict publishes as normal.
 * - In `merge-pending`, it adds `merge_orchestrate` until the merge orchestrator terminates. The
 *   idempotency key needs a real `taskId` and `featureId`, so unrelated calls do not share a key.
 * - At the `deep` rung in a PLAN-kind phase that is not a `-review` phase, it adds `divergent_loop`.
 * - It validates each action against the `NextAction` schema and throws on drift.
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

    const parsed = NextAction.safeParse(candidate);
    if (!parsed.success) {
      throw new Error(
        `computeNextActions produced invalid NextAction for ${phase} → ${t.to}: ${parsed.error.message}`,
      );
    }
    actions.push(parsed.data);
  }

  if (phase === 'merge-pending') {
    const moPhase = state.mergeOrchestrator?.phase;
    const terminated = moPhase !== undefined && EXCLUDED_MERGE_PHASES.has(moPhase);
    if (!terminated) {
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

  const currentKind = (currentState as { kind?: string }).kind;
  if (state.designDepth === 'deep' && currentKind === 'PLAN' && !phase.endsWith('-review')) {
    const deepAffordances: ReadonlyArray<{ verb: string; reason: string }> = [
      {
        verb: 'divergent_loop',
        reason: 'Deep rung: explore 2-3 distinct approaches with trade-offs before converging',
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
 * The two next-action envelopes: HSM control verbs and allow-only registry ActionIds. One call
 * computes both, so a caller cannot publish one without the rule of the other. Phase and control
 * verbs never become ActionIds.
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
 * Publishes the registry ActionIds that the shared ActionId evaluator allows. A denied or
 * indeterminate verdict and an evaluation fault give no ActionId. Missing authorization omits each
 * capability-gated ActionId. Without `actionAdmission`, the function publishes nothing.
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
      }
    }
  }

  return advertised;
}
