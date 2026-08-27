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
 *
 * A conditional edge is dropped from the subject set and never re-enters it. It
 * is not required, and it is equally not AVAILABLE to satisfy something that
 * is: an event that landed under a conditional declaration cannot be spent
 * discharging a different unconditional promise.
 *
 * ── The lifecycle axis: what landed, not only what is missing ───────────────
 *
 * Registration carries two independent axes — the tier an event is welded to,
 * and whether anything emits it at all. `planned` means the schema and type-map
 * entry exist but no producer does; `retired` means the producer is gone and the
 * entry is KEPT so old logs stay replayable.
 *
 * Both are claims about runtime, so runtime can falsify them. An event that
 * lands while its registration says `planned` or `retired` is the same class of
 * defect as a declared emission that never lands — the declaration and the
 * implementation have drifted — and it is invisible to a missing-events check,
 * which only ever looks for absence. Presence is the other half.
 *
 * Scope is declared, not discovered, and what declares it is the DISPATCHED
 * ACTION. The lifecycle check reads the events already fetched for the
 * missing-events comparison — it adds no query — then keeps only those the
 * action declares an edge for. An operation id is a shared join key: a hook, a
 * projection repair or a second interceptor may append under it, and a check
 * that judged everything landed there would fail this action for a write it
 * neither made nor promised, which makes one action's verdict depend on who
 * else happened to write.
 *
 * A conditional edge stays in scope here although it is never required. The two
 * axes ask different questions: absence of a conditional edge proves nothing,
 * but its PRESENCE while the registration says nothing emits it is this
 * action's own drift, whatever condition guards the edge.
 *
 * An action with no unconditional contract is never fetched for and so is never
 * lifecycle-checked here. That is a stated boundary rather than a silent one;
 * the boot-time diagnostics in `events/registration-validate.ts` own the
 * whole-tree sweep.
 *
 * An event absent from the annotation table is NOT a lifecycle violation. An
 * unknown registration is an unanswered question, and it already has its own
 * diagnostic — treating it as a fault here would double-report it under a name
 * that does not describe it.
 *
 * ── Enforcement is a mode, and the no-config path states its own ────────────
 *
 * Whether a violation blocks is `events.emission-enforcement`, resolved once
 * from `.exarchos.yml`. `block` is the default and does not vary by
 * environment.
 *
 * `initializeContext` returns without a `projectConfig` whenever no
 * `projectRoot` is supplied — the CLI cold start, and most tests. On that path
 * the resolved default is never consulted at all, so this interceptor names the
 * mode it uses instead of inheriting a default that cannot reach it. Both land
 * on `block`: the absence of a config file is not an opt-out of enforcement.
 *
 * ── "We did not check" is not "there was nothing to check" ──────────────────
 *
 * Two very different outcomes used to share one status. A conditional-only
 * action has no unconditional promise, so there is nothing to keep — benign,
 * and permanently so. A store that would not answer leaves the promise
 * UNASSESSED — the events may be missing and nobody looked. Collapsing the
 * second into the first meant an infrastructure fault presented as a clean
 * exemption, and since only `violated` blocked, a store that failed on every
 * call disabled enforcement entirely while every verdict read benign.
 *
 * `indeterminate` is therefore its own status, and under `block` it refuses
 * promotion exactly as a violation does: an operation whose bookkeeping could
 * not be read is not a successful operation. The benign exemptions — no
 * contract, no unconditional edge, no stream, a handler that never ran, threw,
 * refused or was stubbed, a reasoned read-only abstention — stay
 * `not-applicable` and never block. A handler REFUSAL in particular is decided
 * before any store read, so a business failure can never present as an
 * infrastructure one.
 */

import type { EventStore } from '../../../events/store.js';
import { EVENT_ANNOTATIONS } from '../../../events/event-annotations.js';
import type {
  EventLifecycle,
  EventRegistration,
} from '../../../events/event-registration.js';
import {
  resolveEmissionEnforcement,
  type EmissionEnforcementMode,
  type ResolvedProjectConfig,
} from '../../../config/resolve.js';
// Via the published `registry.js` identity, not `registry/gate-metadata.js`:
// the dispatch layer reaches the declarations through the barrel every other
// consumer uses, and the layer-boundary audit holds it to that.
import type { ActionContract, AutoEmission } from '../../../registry.js';
import { logger } from '../../../logger.js';

const verifierLogger = logger.child({ subsystem: 'emission-verifier' });

/** The event type this verifier writes its findings to. */
export const EMISSION_VIOLATION_EVENT = 'emission.violated';

/**
 * The dispatch stream for a call, read from whichever parameter names it.
 *
 * `featureId` is the usual spelling; `streamId` is the spelling used by actions
 * re-parented onto a stream they did not open. They denote the same thing — a
 * stream id is a bare feature id — so a verifier that reads only the first
 * exempts the second from its own contract on the strength of a parameter name,
 * which is the shape this layer exists to remove.
 *
 * Returns `undefined` when the call names neither. That is a real answer, not a
 * failure: it resolves `no-stream`, which is a DECLARED inapplicability rather
 * than a quiet pass, and the actions in that class are counted under it.
 */
export function dispatchStreamId(args: Record<string, unknown>): string | undefined {
  for (const key of ['featureId', 'streamId'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// ─── Declared applicability ─────────────────────────────────────────────────

/**
 * The classes of `dispatch()` return site, by what has happened to the handler
 * at the moment the function returns.
 *
 * This is the axis applicability is declared over. It is about the HANDLER: a
 * refusal that never reached one owes nothing.
 *
 * It used to add that an error RESULT still owes the unconditional emissions,
 * on the reasoning that a handler refusing the work still emits whatever it
 * declares unconditionally. Arming the enforcement mode falsified that: the
 * governance suites drive denied transitions, blocked gates and refused
 * completions through real handlers, and those paths return an error without
 * appending the success record — correctly, because the record describes an
 * operation that did not happen. A refusal reached through a handler is the
 * same kind of non-event as one caught before it, so it is declared
 * `handler-refused` rather than counted as drift. `condition: 'always'` means
 * "whenever this action does its work", not "on every call".
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
  /**
   * The handler ran and returned an unsuccessful result. Its declared emissions
   * record work performed; a refusal performed none, so their absence is the
   * correct outcome rather than a drift between declaration and implementation.
   */
  'handler-refused',
  /**
   * The registered composite handler was replaced by a test stub, so the party
   * that made the promise never ran. The contract belongs to the HANDLER — a
   * stand-in returning a canned envelope did not undertake it, and holding a
   * stub to it would report drift that exists only in the fixture.
   */
  'handler-stubbed',
  /**
   * A read-only action reasoned that it appends nothing. The append check
   * would ask the store for events that the action promised not to write.
   */
  'read-only-abstention',
] as const;

export type EmissionInapplicabilityReason =
  (typeof EMISSION_INAPPLICABILITY_REASONS)[number];

/**
 * Why a dispatch that DID carry an assessable contract was left unassessed.
 *
 * Every member names a fault in the verifier's own machinery or in what it
 * depends on — never a decision the handler made. A handler that refused the
 * work is decided before any of these can arise, so a business failure cannot
 * arrive here wearing an infrastructure name.
 */
export const EMISSION_INDETERMINACY_CAUSES = [
  /** The store would not answer the query; the contract was not read at all. */
  'store-unavailable',
  /** The read succeeded and the assessment itself faulted after it. */
  'verification-fault',
] as const;

export type EmissionIndeterminacyCause = (typeof EMISSION_INDETERMINACY_CAUSES)[number];

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

/**
 * `not-applicable` and `indeterminate` are deliberately separate. The first is
 * a benign absence of subject; the second is a subject that exists and was not
 * assessed. Only the second is a reason to refuse promotion.
 */
export type EmissionVerificationStatus =
  | 'ok'
  | 'violated'
  | 'not-applicable'
  | 'indeterminate';

/**
 * The lifecycle values that assert nothing emits the event. `active` is absent
 * because an active registration is exactly the case a runtime emission agrees
 * with; deriving this by subtraction keeps the two from drifting apart.
 */
export type NonEmittingLifecycle = Exclude<EventLifecycle, 'active'>;

/** An event that landed at runtime while its registration said nothing emits it. */
export interface LifecycleViolation {
  readonly event: string;
  readonly lifecycle: NonEmittingLifecycle;
}

export interface EmissionVerdict {
  readonly status: EmissionVerificationStatus;
  /** Present only when `status === 'not-applicable'`. */
  readonly reason?: EmissionInapplicabilityReason;
  /** Present only when `status === 'indeterminate'`. */
  readonly cause?: EmissionIndeterminacyCause;
  /** The unconditionally declared events that did not land. Empty unless violated. */
  readonly missingEvents: readonly string[];
  /**
   * Events that landed although their registration is `planned` or `retired`.
   * Empty unless violated, and independent of {@link missingEvents} — either
   * alone is enough to make the verdict `violated`.
   */
  readonly lifecycleViolations: readonly LifecycleViolation[];
  /** The unconditional subject set the verdict was reached over. */
  readonly required: readonly string[];
}

/**
 * The landed events whose registration claims nothing emits them.
 *
 * Total and pure. An unregistered event yields nothing — see the header: absence
 * from the table is a different question with a different owner.
 *
 * Judges exactly the landings it is handed. Which landings belong to a given
 * action is the caller's decision, and {@link verifyDeclaredEmissions} makes it.
 */
export function lifecycleViolations(
  landed: readonly string[],
  annotations: Readonly<Record<string, EventRegistration>> = EVENT_ANNOTATIONS,
): readonly LifecycleViolation[] {
  const seen = new Set<string>();
  const violations: LifecycleViolation[] = [];
  for (const event of landed) {
    if (seen.has(event)) continue;
    seen.add(event);
    const lifecycle = annotations[event]?.lifecycle;
    if (lifecycle === undefined || lifecycle === 'active') continue;
    violations.push({ event, lifecycle });
  }
  return violations.sort((a, b) => a.event.localeCompare(b.event));
}

/**
 * The unconditionally declared event names for one action, de-duplicated and
 * sorted so a report is stable.
 *
 * Reads `condition` verbatim. An edge with any other condition is dropped from
 * the subject set here and never re-enters it — it is neither required below nor
 * available to satisfy something that is.
 */
/**
 * The emission list the verifier assesses.
 *
 * Nested `actionContract.emissions` is the only subject. Sibling `autoEmits`
 * is never consulted — a populated leftover list must not revive a reasoned
 * `none`, and an absent contract is not filled in from the sibling.
 */
export function verifierDeclaredEmissions(
  contract: Pick<ActionContract, 'emissions'> | undefined,
): readonly AutoEmission[] | undefined {
  if (contract?.emissions.kind === 'declared') {
    return contract.emissions.values;
  }
  return undefined;
}

/**
 * Every event this action declares an edge for, at any condition.
 *
 * This is the lifecycle axis's subject set — see the header. Deliberately wider
 * than {@link unconditionalEmissions}: a conditional edge is not required, but
 * an action that emitted one while its registration says nothing emits it has
 * still drifted from its own declaration.
 */
export function declaredEventNames(
  declared: readonly AutoEmission[] | undefined,
): ReadonlySet<string> {
  const events = new Set<string>();
  for (const emission of declared ?? []) events.add(emission.event);
  return events;
}

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
 * first, so a handler that dropped three emissions reads three.
 *
 * The lifecycle axis is scoped to `declared` first: a landing this action never
 * declared cannot move this action's verdict in either direction.
 */
export function verifyDeclaredEmissions(input: {
  readonly declared: readonly AutoEmission[] | undefined;
  readonly streamId: string | undefined;
  readonly landed: readonly string[];
  readonly annotations?: Readonly<Record<string, EventRegistration>>;
}): EmissionVerdict {
  const required = unconditionalEmissions(input.declared);

  // Out of subject — see the header. Not `ok`: there was nothing to earn a pass with.
  if (required.length === 0) {
    return {
      status: 'not-applicable',
      reason: 'no-unconditional-contract',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }
  if (input.streamId === undefined || input.streamId.length === 0) {
    return {
      status: 'not-applicable',
      reason: 'no-stream',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }

  const landed = new Set(input.landed);
  const missingEvents = required.filter((event) => !landed.has(event));
  // Narrowed to this action's own edges before the lifecycle question is asked.
  // The operation-wide list is what the store returns; it is not what this
  // action answers for.
  const declaredEvents = declaredEventNames(input.declared);
  const lifecycle = lifecycleViolations(
    input.landed.filter((event) => declaredEvents.has(event)),
    input.annotations,
  );

  // Two independent faults, either sufficient. Reported together rather than
  // short-circuited, so one run names everything that is wrong with the call.
  return missingEvents.length === 0 && lifecycle.length === 0
    ? { status: 'ok', missingEvents: [], lifecycleViolations: [], required }
    : { status: 'violated', missingEvents, lifecycleViolations: lifecycle, required };
}

// ─── Run-level summary ──────────────────────────────────────────────────────

/**
 * What a whole run of verdicts adds up to.
 *
 * `determinate` is the count the headline rests on. A `not-applicable` verdict
 * is not a pass — it is a question that was not asked — so a run made entirely
 * of them has checked NOTHING, and reporting that as clean is the exact shape
 * of a guard gone vacuous: green, stable, and covering nothing at all.
 */
export interface EmissionRunSummary {
  /** Every verdict considered. */
  readonly total: number;
  /** Verdicts that actually answered the question: `ok` + `violated`. */
  readonly determinate: number;
  readonly ok: number;
  readonly violated: number;
  /** Everything that answered nothing: out of subject, no stream, unassessed. */
  readonly indeterminate: number;
  /**
   * True only when something was checked AND nothing was wrong. A run with
   * `determinate === 0` is never clean, however many verdicts it produced.
   */
  readonly clean: boolean;
}

/**
 * Fold a run's verdicts into a summary. Pure and total.
 *
 * The determinate count is REPORTED rather than merely computed, because the
 * number is the evidence: "0 violations" out of 400 checked and "0 violations"
 * out of 0 checked print identically, and only one of them is good news.
 */
export function summarizeEmissionRun(
  verdicts: readonly EmissionVerdict[],
): EmissionRunSummary {
  let ok = 0;
  let violated = 0;
  let indeterminate = 0;
  for (const verdict of verdicts) {
    if (verdict.status === 'ok') ok += 1;
    else if (verdict.status === 'violated') violated += 1;
    else indeterminate += 1;
  }
  const determinate = ok + violated;
  return {
    total: verdicts.length,
    determinate,
    ok,
    violated,
    indeterminate,
    clean: determinate > 0 && violated === 0,
  };
}

/**
 * Whether this verdict should FAIL the run, given the config that was resolved
 * — or the absence of one.
 *
 * Total over both arguments. A `not-applicable` verdict never blocks under any
 * mode: it is the record of a question that was not asked, and failing on it
 * would make "we could not check" indistinguishable from "we checked and it was
 * wrong".
 */
export function emissionViolationBlocks(
  verdict: EmissionVerdict,
  config?: Pick<ResolvedProjectConfig, 'events'>,
): boolean {
  return verdict.status === 'violated' && resolveEmissionEnforcement(config) === 'block';
}

/** The error code a blocked indeterminate verdict is returned under. */
export const EMISSION_INDETERMINATE_ERROR_CODE = 'EMISSION_VERIFICATION_INDETERMINATE';

/**
 * Whether an unassessed contract must refuse promotion.
 *
 * Under `block` it does. The dispatch either kept its unconditional promise or
 * it did not, and nobody knows which — reporting success asserts the first on
 * no evidence. Under `advisory` it does not: the operator asked for the finding
 * without the failure, and that choice covers this axis too.
 *
 * Deliberately a SECOND predicate rather than a widened `emissionViolationBlocks`.
 * The two answer different questions and their messages differ in the only way
 * that matters to a caller — one names events that are known missing, the other
 * names none because none were read.
 */
export function emissionIndeterminacyBlocks(
  verdict: EmissionVerdict,
  config?: Pick<ResolvedProjectConfig, 'events'>,
): boolean {
  return verdict.status === 'indeterminate' && resolveEmissionEnforcement(config) === 'block';
}

/** Why the contract went unassessed, in one clause a caller can act on. */
export function describeEmissionIndeterminacy(verdict: EmissionVerdict): string {
  return verdict.cause === 'verification-fault'
    ? 'the emission check faulted after reading the stream'
    : 'the event store would not answer the query';
}

/**
 * The advisory-mode surface. The finding still reaches the caller — a mode that
 * chose not to fail is not a mode that chose not to report.
 */
export function emissionIndeterminacyWarning(
  tool: string,
  action: string,
  verdict: EmissionVerdict,
): string {
  return (
    `${tool}.${action} declares unconditional emissions ` +
    `(${verdict.required.join(', ')}) that could not be verified: ` +
    `${describeEmissionIndeterminacy(verdict)}. The operation's effects are performed; ` +
    'whether its declared events landed is unknown.'
  );
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
  /**
   * Whether this tool's composite handler is a test stub rather than the
   * registered implementation. Declared by the caller instead of sniffed here:
   * the handler map holds stubs and lazily-loaded real handlers alike, so
   * membership cannot tell them apart.
   */
  readonly handlerStubbed?: boolean;
  /**
   * Whether the handler's own result reported success. A handler that refused
   * the work owes no record of having done it.
   */
  readonly handlerSucceeded?: boolean;
  /**
   * A read-only action whose contract reasons that it appends nothing.
   * The append check is skipped: there is no event-append obligation to
   * observe, and querying for one would treat reasoned silence as drift.
   */
  readonly readOnlyAbstention?: boolean;
  /** Registration table for the lifecycle axis. Injectable for tests. */
  readonly annotations?: Readonly<Record<string, EventRegistration>>;
  /**
   * The resolved project config, when one was resolved at all. Absent on the
   * no-`projectRoot` path — see the header; the fallback is stated, not
   * inherited.
   */
  readonly projectConfig?: Pick<ResolvedProjectConfig, 'events'>;
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
 * Failures are LOGGED-AND-SWALLOWED, same posture as the sibling interceptor:
 * this function never throws, so a verifier fault cannot turn a working
 * dispatch into an unhandled one. It resolves `indeterminate`, not `ok` and not
 * `not-applicable` — an unread store is an unanswered question, and what the
 * caller does with an unanswered question is the enforcement mode's decision,
 * not this function's.
 */
export async function runEmissionVerifierInterceptor(
  eventStore: EventStore,
  call: EmissionVerifierCall,
): Promise<EmissionVerdict> {
  const required = unconditionalEmissions(call.declared);
  if (call.handlerSucceeded === false) {
    return {
      status: 'not-applicable',
      reason: 'handler-refused',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }
  // Ordered before the contract check: with no real handler there is no
  // subject, which is a more fundamental absence than having nothing to assess.
  if (call.handlerStubbed === true) {
    return {
      status: 'not-applicable',
      reason: 'handler-stubbed',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }
  if (call.readOnlyAbstention === true) {
    return {
      status: 'not-applicable',
      reason: 'read-only-abstention',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }
  if (required.length === 0) {
    return {
      status: 'not-applicable',
      reason: 'no-unconditional-contract',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }
  const streamId = call.streamId;
  if (streamId === undefined || streamId.length === 0) {
    return {
      status: 'not-applicable',
      reason: 'no-stream',
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  }

  const unassessed = (cause: EmissionIndeterminacyCause, err: unknown): EmissionVerdict => {
    verifierLogger.warn(
      {
        tool: call.tool,
        action: call.action,
        operationId: call.operationId,
        cause,
        err: err instanceof Error ? err.message : String(err),
      },
      'emission verifier swallowed error; the contract was not assessed',
    );
    return {
      status: 'indeterminate',
      cause,
      missingEvents: [],
      lifecycleViolations: [],
      required,
    };
  };

  // The read is fenced on its own so an unanswerable store is distinguishable
  // from a fault in the assessment that followed a successful read.
  let observed: readonly { readonly type: string }[];
  try {
    observed = await eventStore.query(streamId, { operationId: call.operationId });
  } catch (err) {
    return unassessed('store-unavailable', err);
  }

  try {
    const verdict = verifyDeclaredEmissions({
      declared: call.declared,
      streamId,
      landed: observed.map((event) => event.type),
      annotations: call.annotations ?? EVENT_ANNOTATIONS,
    });
    if (verdict.status !== 'violated') return verdict;

    // The finding has to outlive the run that noticed it, so it is written to
    // the log rather than only logged. One report per operation: the
    // idempotency key collapses a racing duplicate into a no-op. Gated on the
    // verdict alone — `violated` already means at least one axis is non-empty,
    // whichever it is, and both ride along regardless of which one fired.
    await eventStore.append(
      streamId,
      {
        type: EMISSION_VIOLATION_EVENT,
        data: {
          action: `${call.tool}.${call.action}`,
          missingEvents: verdict.missingEvents,
          lifecycleViolations: verdict.lifecycleViolations,
          operationId: call.operationId,
        },
      },
      { idempotencyKey: `${EMISSION_VIOLATION_EVENT}:${call.operationId}` },
    );
    // The mode changes how loudly this reads, never whether it was recorded: a
    // finding suppressed to keep an advisory run quiet is a finding lost.
    const enforcement: EmissionEnforcementMode = resolveEmissionEnforcement(call.projectConfig);
    const report = {
      tool: call.tool,
      action: call.action,
      operationId: call.operationId,
      missingEvents: verdict.missingEvents,
      lifecycleViolations: verdict.lifecycleViolations,
      enforcement,
    };
    const message =
      'declared emissions did not land: the handler and its registration have drifted';
    if (enforcement === 'block') verifierLogger.error(report, message);
    else verifierLogger.warn(report, message);
    return verdict;
  } catch (err) {
    // Reached when the finding could not be recorded, or when the comparison
    // itself faulted. Either way the run holds no durable answer, so it reports
    // one it does not have rather than a verdict it cannot stand behind.
    return unassessed('verification-fault', err);
  }
}
