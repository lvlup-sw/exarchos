/**
 * Post-dispatch emission verifier.
 *
 * A registry action that declares `autoEmits: [{ event, condition: 'always' }]`
 * has made an unconditional promise: run this action's handler to completion and
 * that event lands. Nothing was checking it. This interceptor reads the promise
 * back off the declaration after the handler returns, asks the store what
 * actually landed on this operation, and reports the difference.
 *
 * The fault it reports is OURS. An agent cannot cause a violation by calling
 * badly — a malformed call never reaches a handler, and a handler that refuses
 * the work still emits whatever its declaration says it emits unconditionally.
 * A miss here means the declaration and the implementation have drifted apart,
 * which is an Exarchos bug, and it is written to the log as `emission.violated`
 * so it outlives the run that noticed it.
 *
 * ── Applicability is declared BEFORE the assertion, not discovered by it ─────
 *
 * `dispatch()` has many branches that return before any handler runs: an
 * unloadable composite, an unknown tool, a missing or unknown action, a
 * multi-match workspace, a schema rejection, an ignored parameter, a denied
 * capability, a blocked install. None of them has an emission contract to keep,
 * because the contract is a property of the HANDLER and the handler never ran.
 *
 * Left undeclared, this is the failure mode where the check looks fine either
 * way: assert over all returns and the verifier is permanently red on the
 * refusal paths; narrow the assertion to whatever happens to be green and it has
 * silently stopped covering the paths that matter. So the classes of dispatch
 * outcome are enumerated first — {@link DISPATCH_RETURN_CLASSES} — and each one
 * says up front whether a contract applies to it — {@link RETURN_CLASS_APPLICABILITY}.
 * Only the applicable class carries the structural obligation to reach this
 * interceptor. Same shape as the reachability census's `owner` hop, which is
 * `not-applicable` for a non-mutating action rather than counted as a miss.
 *
 * ── Conditional edges are out of subject, and out of subject is not a pass ───
 *
 * An edge declared `condition: 'conditional'` fires on a predicate this
 * interceptor cannot see. It is therefore not required, and — equally
 * load-bearing — its ABSENCE is not evidence of health. An action whose only
 * edges are conditional resolves `not-applicable`, never `ok`: reporting `ok`
 * would record a pass that was never earned, which is indistinguishable from
 * not having checked.
 */

import type { EventStore } from '../../../events/store.js';
// Via the published `registry.js` identity, not `registry/gate-metadata.js`:
// the dispatch layer reaches the declarations through the barrel every other
// consumer uses, and the layer-boundary audit holds it to that.
import type { AutoEmission } from '../../../registry.js';
import { logger } from '../../../logger.js';

const verifierLogger = logger.child({ subsystem: 'emission-verifier' });

/** The event type this verifier writes its findings to. */
export const EMISSION_VIOLATION_EVENT = 'emission.violated';

// ─── Declared applicability ─────────────────────────────────────────────────

/**
 * The classes of `dispatch()` return site, by what has happened to the handler
 * at the moment the function returns.
 *
 * This is the axis applicability is declared over. It is deliberately about the
 * HANDLER and not about success/failure: a handler that ran and returned an
 * error result still owes its unconditional emissions, while a refusal that
 * never reached a handler owes nothing.
 */
export const DISPATCH_RETURN_CLASSES = [
  /** Returned before any handler was invoked — a refusal, a gate, a validation. */
  'pre-handler',
  /** The handler ran to completion and its result is being returned. */
  'handler-completing',
  /** The handler (or something around it) threw; the catch arm is returning. */
  'handler-threw',
] as const;

export type DispatchReturnClass = (typeof DISPATCH_RETURN_CLASSES)[number];

/** Why a given dispatch carries no emission contract this interceptor can assess. */
export const EMISSION_INAPPLICABILITY_REASONS = [
  /** No handler ran, so no handler promised anything. */
  'handler-did-not-run',
  /** The handler aborted; its declared emissions describe completion, not a throw. */
  'handler-threw',
  /** The action declares emissions, but every one of them is conditional. */
  'no-unconditional-contract',
  /** No stream id on the call, so there is nowhere for the events to have landed. */
  'no-stream',
  /** The store could not be read; the contract was not assessed either way. */
  'store-unavailable',
] as const;

export type EmissionInapplicabilityReason =
  (typeof EMISSION_INAPPLICABILITY_REASONS)[number];

/** Whether a class of return carries an emission contract, and if not, why not. */
export type EmissionApplicability =
  | { readonly applicable: true }
  | { readonly applicable: false; readonly reason: EmissionInapplicabilityReason };

/**
 * The applicability declaration, total over {@link DispatchReturnClass}.
 *
 * The structural bypass assertion reads THIS table to decide which return sites
 * it is entitled to demand anything of. A class marked applicable must reach the
 * interceptor; a class marked inapplicable is exempt, with the reason on the
 * record. Flipping an entry moves the obligation — which is the point: the
 * exemption is a declaration someone made, not a gap the assertion grew around.
 */
export const RETURN_CLASS_APPLICABILITY: Readonly<
  Record<DispatchReturnClass, EmissionApplicability>
> = Object.freeze({
  'pre-handler': { applicable: false, reason: 'handler-did-not-run' },
  'handler-completing': { applicable: true },
  'handler-threw': { applicable: false, reason: 'handler-threw' },
});

/**
 * The classes that must route through this interceptor. Derived from the
 * declaration above rather than restated, so the two cannot disagree.
 */
export function applicableReturnClasses(
  policy: Readonly<
    Record<DispatchReturnClass, EmissionApplicability>
  > = RETURN_CLASS_APPLICABILITY,
): readonly DispatchReturnClass[] {
  return DISPATCH_RETURN_CLASSES.filter((cls) => policy[cls].applicable);
}

// ─── Verdict ────────────────────────────────────────────────────────────────

export type EmissionVerificationStatus = 'ok' | 'violated' | 'not-applicable';

export interface EmissionVerdict {
  readonly status: EmissionVerificationStatus;
  /** Present only when `status === 'not-applicable'`. */
  readonly reason?: EmissionInapplicabilityReason;
  /** The unconditionally declared events that did not land. Empty unless violated. */
  readonly missingEvents: readonly string[];
  /** The unconditional subject set the verdict was reached over. */
  readonly required: readonly string[];
}

/**
 * The unconditionally declared event names for one action, de-duplicated and
 * sorted so a report is stable.
 *
 * Reads `condition` verbatim. An edge with any other condition is dropped from
 * the subject set here and never re-enters it — it is neither required below nor
 * available to satisfy something that is.
 */
export function unconditionalEmissions(
  declared: readonly AutoEmission[] | undefined,
): readonly string[] {
  const events = new Set<string>();
  for (const emission of declared ?? []) {
    if (emission.condition === 'always') events.add(emission.event);
  }
  return [...events].sort();
}

/**
 * Compare what the action promised unconditionally against what landed.
 *
 * Pure and total: every input produces a verdict, nothing throws. `landed` is
 * the set of event types observed on this operation; anything in `required` and
 * not in `landed` is a miss, and ALL of the misses are reported rather than the
 * first, so a handler that dropped three emissions reads as three.
 */
export function verifyDeclaredEmissions(input: {
  readonly declared: readonly AutoEmission[] | undefined;
  readonly streamId: string | undefined;
  readonly landed: readonly string[];
}): EmissionVerdict {
  const required = unconditionalEmissions(input.declared);

  // Out of subject — see the header. Not `ok`: there was nothing to earn a pass with.
  if (required.length === 0) {
    return { status: 'not-applicable', reason: 'no-unconditional-contract', missingEvents: [], required };
  }
  if (input.streamId === undefined || input.streamId.length === 0) {
    return { status: 'not-applicable', reason: 'no-stream', missingEvents: [], required };
  }

  const landed = new Set(input.landed);
  const missingEvents = required.filter((event) => !landed.has(event));
  return missingEvents.length === 0
    ? { status: 'ok', missingEvents: [], required }
    : { status: 'violated', missingEvents, required };
}

// ─── Interceptor entry point ────────────────────────────────────────────────

export interface EmissionVerifierCall {
  /** The composite tool the action is registered under. */
  readonly tool: string;
  /** The dispatched action name. */
  readonly action: string;
  /** The dispatch operation being assessed — the join key for the finding. */
  readonly operationId: string;
  /** The dispatched action's stream (its `featureId`), when it has one. */
  readonly streamId: string | undefined;
  /** The action's declared emission edges, read from the registry. */
  readonly declared: readonly AutoEmission[] | undefined;
}

/**
 * Run the post-dispatch emission verifier for one dispatch call.
 *
 * Wired by `dispatch()` AFTER the handler has produced its result and BEFORE
 * that result is returned — the only position from which "the handler completed
 * without its declared emissions" is answerable at all.
 *
 * The subject set is computed before any I/O, so an action with no unconditional
 * contract (most of the read surface) costs one registry read and no query.
 *
 * Failures are LOGGED-AND-SWALLOWED, same posture as the sibling interceptor: a
 * verifier that turned a working dispatch into a failed one would be a worse
 * bug than any it could report. A swallowed failure resolves `not-applicable`
 * with reason `store-unavailable` rather than `ok`, because an unread store is
 * an unanswered question, not a clean bill.
 */
export async function runEmissionVerifierInterceptor(
  eventStore: EventStore,
  call: EmissionVerifierCall,
): Promise<EmissionVerdict> {
  const required = unconditionalEmissions(call.declared);
  if (required.length === 0) {
    return { status: 'not-applicable', reason: 'no-unconditional-contract', missingEvents: [], required };
  }
  const streamId = call.streamId;
  if (streamId === undefined || streamId.length === 0) {
    return { status: 'not-applicable', reason: 'no-stream', missingEvents: [], required };
  }

  try {
    const observed = await eventStore.query(streamId, { operationId: call.operationId });
    const verdict = verifyDeclaredEmissions({
      declared: call.declared,
      streamId,
      landed: observed.map((event) => event.type),
    });
    if (verdict.status !== 'violated') return verdict;

    // The finding has to outlive the run that noticed it, so it is written to
    // the log rather than only logged. One report per operation: the
    // idempotency key collapses a racing duplicate into a no-op.
    await eventStore.append(
      streamId,
      {
        type: 'emission.violated',
        data: {
          action: `${call.tool}.${call.action}`,
          missingEvents: verdict.missingEvents,
          operationId: call.operationId,
        },
      },
      { idempotencyKey: `emission.violated:${call.operationId}` },
    );
    verifierLogger.warn(
      {
        tool: call.tool,
        action: call.action,
        operationId: call.operationId,
        missingEvents: verdict.missingEvents,
      },
      'declared emissions did not land: the handler and its registration have drifted',
    );
    return verdict;
  } catch (err) {
    verifierLogger.warn(
      {
        tool: call.tool,
        action: call.action,
        operationId: call.operationId,
        err: err instanceof Error ? err.message : String(err),
      },
      'emission verifier swallowed error; the contract was not assessed',
    );
    return { status: 'not-applicable', reason: 'store-unavailable', missingEvents: [], required };
  }
}
