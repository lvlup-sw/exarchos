/**
 * The post-dispatch emission verifier. An action that declares an emission with
 * `condition: 'always'` promises that the event lands when its handler does the work. After the
 * handler returns, this interceptor reads the store for the operation and reports a difference as
 * `emission.violated`. A miss means that the declaration and the implementation have drifted.
 *
 * {@link RETURN_CLASS_APPLICABILITY} declares which dispatch return classes carry a contract. A
 * conditional edge is not required, and its absence is not a pass, so a conditional-only action
 * resolves `not-applicable`. An event that lands while its registration is `planned` or `retired`
 * is also a violation. That check covers only events that the action declares, because other
 * writers share the operation id.
 *
 * `events.emission-enforcement` decides if a violation blocks, and `block` is the fallback without
 * a project config. `indeterminate` means that the verifier did not assess the contract. Under
 * `block` it refuses promotion like a violation. A `not-applicable` exemption never blocks.
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
import type { ActionContract, AutoEmission } from '../../../registry.js';
import { INFRA_STREAM_IDS } from '../infra-streams.js';
import { logger } from '../../../logger.js';

const verifierLogger = logger.child({ subsystem: 'emission-verifier' });

/** The event type this verifier writes its findings to. */
export const EMISSION_VIOLATION_EVENT = 'emission.violated';

/**
 * The dispatch stream of a call, read from `featureId` or `streamId`. Both name the same stream, so
 * the verifier reads both. It returns `undefined` when the call names neither, which resolves as
 * the declared `no-stream` inapplicability.
 */
export function dispatchStreamId(args: Record<string, unknown>): string | undefined {
  for (const key of ['featureId', 'streamId'] as const) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * The stream where the declared emissions and postconditions of a call are observed. A reserved
 * infrastructure stream in the contract wins over the call arguments. The argument names the
 * subject of the call, but the declaration names where the records go. Any other stream resource
 * names an argument. It returns `undefined` when neither names a stream.
 */
export function observationStreamId(
  args: Record<string, unknown>,
  contract: ActionContract | undefined,
): string | undefined {
  const resources = contract?.touches.resources;
  if (resources !== undefined && resources.kind === 'declared') {
    for (const resource of resources.values) {
      if (resource.kind === 'stream' && INFRA_STREAM_IDS.has(resource.selector)) {
        return resource.selector;
      }
    }
  }
  return dispatchStreamId(args);
}

/**
 * The classes of `dispatch()` return site, by the state of the handler at return. Applicability is
 * declared over this axis. A refusal before a handler owes nothing. A handler that returns an
 * unsuccessful result is `handler-refused`, because its records describe work that did not happen.
 * `condition: 'always'` means "when this action does its work", not "on each call".
 */
export const DISPATCH_RETURN_CLASSES = [
  /** Returned before a handler ran: a refusal, a gate, or a validation. */
  'pre-handler',
  /** The handler ran to completion, and dispatch returns its result. */
  'handler-completing',
  /** The handler, or code around it, threw. The catch arm returns. */
  'handler-threw',
] as const;

export type DispatchReturnClass = (typeof DISPATCH_RETURN_CLASSES)[number];

/** Why a given dispatch carries no emission contract this interceptor can assess. */
export const EMISSION_INAPPLICABILITY_REASONS = [
  /** No handler ran, so no handler promised anything. */
  'handler-did-not-run',
  /** The handler threw. Its declared emissions describe completion, not a throw. */
  'handler-threw',
  /** The action declares emissions, but every one of them is conditional. */
  'no-unconditional-contract',
  /** No stream id on the call, so there is nowhere for the events to have landed. */
  'no-stream',
  /**
   * The handler ran and returned an unsuccessful result. Its declared emissions record work that it
   * did, and a refusal did no work. So their absence is correct, not drift.
   */
  'handler-refused',
  /**
   * A test stub stands in for the registered composite handler, so the party that made the promise
   * did not run. A stub held to the contract reports drift that exists only in the fixture.
   */
  'handler-stubbed',
  /**
   * A read-only action states with a reason that it appends nothing. The verifier does not query
   * the store for events that the action promised not to write.
   */
  'read-only-abstention',
] as const;

export type EmissionInapplicabilityReason =
  (typeof EMISSION_INAPPLICABILITY_REASONS)[number];

/**
 * Why a dispatch with an assessable contract stayed unassessed. Each member names a fault in the
 * verifier or its dependencies, not a handler decision. A handler refusal is decided first, so a
 * business failure does not arrive here.
 */
export const EMISSION_INDETERMINACY_CAUSES = [
  /** The store did not answer the query. The verifier read no events. */
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
 * The applicability declaration, total over {@link DispatchReturnClass}. The structural bypass
 * assertion reads this table. A class marked applicable must reach the interceptor. A class marked
 * inapplicable is exempt, and the reason is on record.
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

/**
 * `not-applicable` and `indeterminate` are separate. The first is a benign absence of subject. The
 * second is a subject that exists but was not assessed, and only it can refuse promotion.
 */
export type EmissionVerificationStatus =
  | 'ok'
  | 'violated'
  | 'not-applicable'
  | 'indeterminate';

/**
 * The lifecycle values that say nothing emits the event. It excludes `active`, which agrees with a
 * runtime emission. The type derives by subtraction, so the two cannot drift.
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
 * The landed events whose registration says that nothing emits them. It is pure. An unregistered
 * event yields nothing, because a separate diagnostic owns that question. It judges exactly the
 * landings that it receives, and {@link verifyDeclaredEmissions} picks them for an action.
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
 * The emission list that the verifier assesses: the nested `actionContract.emissions` only. It does
 * not read the sibling `autoEmits`, so a leftover list cannot revive a reasoned `none` or fill an
 * absent contract.
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
 * Each event that this action declares an edge for, at any condition. This is the subject set of
 * the lifecycle check. It is wider than {@link unconditionalEmissions}: a conditional edge that
 * lands while its registration says nothing emits it is still drift.
 */
export function declaredEventNames(
  declared: readonly AutoEmission[] | undefined,
): ReadonlySet<string> {
  const events = new Set<string>();
  for (const emission of declared ?? []) events.add(emission.event);
  return events;
}

/**
 * The unconditionally declared event names of one action, deduplicated and sorted for a stable
 * report. A conditional edge is not required, and it cannot satisfy a required edge.
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
 * Compares the unconditional promises of the action with what landed. It is pure, does not throw,
 * and reports each miss. A call with no unconditional edge is `not-applicable`, not `ok`, because
 * nothing earned a pass. The lifecycle check covers only the landings that the action declares, so
 * a write by another party cannot move this verdict. The two faults are independent, and the
 * verdict reports both.
 */
export function verifyDeclaredEmissions(input: {
  readonly declared: readonly AutoEmission[] | undefined;
  readonly streamId: string | undefined;
  readonly landed: readonly string[];
  readonly annotations?: Readonly<Record<string, EventRegistration>>;
}): EmissionVerdict {
  const required = unconditionalEmissions(input.declared);

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
  const declaredEvents = declaredEventNames(input.declared);
  const lifecycle = lifecycleViolations(
    input.landed.filter((event) => declaredEvents.has(event)),
    input.annotations,
  );

  return missingEvents.length === 0 && lifecycle.length === 0
    ? { status: 'ok', missingEvents: [], lifecycleViolations: [], required }
    : { status: 'violated', missingEvents, lifecycleViolations: lifecycle, required };
}

/**
 * The summary of a run of verdicts. A `not-applicable` verdict is not a pass, so a run of only
 * those checked nothing and is not clean. `determinate` counts the verdicts that answered.
 * `notApplicable` counts a benign absence of subject. `indeterminate` counts a subject that the
 * verifier did not assess.
 */
export interface EmissionRunSummary {
  /** Every verdict considered. */
  readonly total: number;
  /** Verdicts that actually answered the question: `ok` + `violated`. */
  readonly determinate: number;
  readonly ok: number;
  readonly violated: number;
  /** Benign absence of subject: no unconditional contract, or no stream to read. */
  readonly notApplicable: number;
  /** A subject that existed but was not assessed. */
  readonly indeterminate: number;
  /**
   * True only when something was checked AND nothing was wrong. A run with
   * `determinate === 0` is never clean, however many verdicts it produced.
   */
  readonly clean: boolean;
}

/**
 * Folds the verdicts of a run into a summary. It is pure. It reports the determinate count,
 * because "0 violations" out of 400 checks and out of 0 checks print the same.
 */
export function summarizeEmissionRun(
  verdicts: readonly EmissionVerdict[],
): EmissionRunSummary {
  let ok = 0;
  let violated = 0;
  let notApplicable = 0;
  let indeterminate = 0;
  for (const verdict of verdicts) {
    if (verdict.status === 'ok') ok += 1;
    else if (verdict.status === 'violated') violated += 1;
    else if (verdict.status === 'not-applicable') notApplicable += 1;
    else indeterminate += 1;
  }
  const determinate = ok + violated;
  return {
    total: verdicts.length,
    determinate,
    ok,
    violated,
    notApplicable,
    indeterminate,
    clean: determinate > 0 && violated === 0,
  };
}

/**
 * True when this verdict must fail the run under the resolved config, or under the fallback without
 * one. Only a `violated` verdict under `block` blocks. A `not-applicable` verdict never blocks,
 * because it records a question that nobody asked.
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
 * True when an unassessed contract must refuse promotion. Under `block` it does, because a success
 * claims a kept promise without evidence. Under `advisory` it does not. It is separate from
 * {@link emissionViolationBlocks}, because only that message names known missing events.
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

export interface EmissionVerifierCall {
  /** The composite tool the action is registered under. */
  readonly tool: string;
  /** The dispatched action name. */
  readonly action: string;
  /** The dispatch operation being assessed — the join key for the finding. */
  readonly operationId: string;
  /** The stream to observe, when the call has one. */
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
   * A read-only action whose contract states that it appends nothing. The verifier skips the append
   * check, because a query treats a reasoned silence as drift.
   */
  readonly readOnlyAbstention?: boolean;
  /** Registration table for the lifecycle axis. Injectable for tests. */
  readonly annotations?: Readonly<Record<string, EventRegistration>>;
  /**
   * The resolved project config, when one exists. It is absent when no `projectRoot` was supplied,
   * and the verifier then uses the stated fallback.
   */
  readonly projectConfig?: Pick<ResolvedProjectConfig, 'events'>;
}

/**
 * Runs the post-dispatch emission verifier for one call. `dispatch()` calls it after the handler
 * returns and before it returns the result. A refused, stubbed, or read-only abstaining handler, a
 * missing unconditional contract, and a missing stream resolve `not-applicable` with no query.
 *
 * It never throws. A failed store read resolves `indeterminate` with `store-unavailable`. A fault
 * after the read, or a failed write of the finding, resolves `verification-fault`. A violation is
 * appended as `emission.violated` in each mode, once per operation through an idempotency key.
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
    return unassessed('verification-fault', err);
  }
}
