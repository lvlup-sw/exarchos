/**
 * Typed effect carriers. Each effect has one typed owner, an idempotency boundary, and a repair or
 * compensation contract. The carrier is a discriminated union with three arms:
 * - `success`: the effect ran and produced a value, with evidence of its record.
 * - `error`: the effect ran and failed, with a structured {@link EffectError}.
 * - `dry-run`: the effect did not run. The carrier reports the {@link EffectPlan}.
 *
 * In dry-run mode, {@link runEffect} returns the plan before it calls the `execute` thunk or
 * records a declared emission. Thus a dry run has no side effect and records no fact.
 */

import { isBuiltInEventType, type EventType } from '../../events/schemas.js';
import {
  deriveReplayIdentity,
  type AuthenticatedRequestContext,
  type ReplayIdentity,
} from '../../contract/request-context.js';
import type { ActionContract, ActionEmission, ReplayPolicy } from '../../registry/action-contract.js';

/**
 * The kind of side effect: five primitives plus `compensation`, the repair effect that a saga runs
 * to undo a partial effect. {@link toEffectError} reads it to derive the failure code.
 *
 * The effect ledger in the architecture layer has its own `EffectClass` with three detection
 * members. The two stay separate, and this module does not import that type. The event catalog,
 * not the effect class or the owner, governs {@link EffectPlan.emits}.
 */
export type EffectClass =
  | 'filesystem'
  | 'process'
  | 'vcs'
  | 'install'
  | 'network'
  | 'compensation';

/**
 * A structured description of an effect failure: a machine-readable `code`, a `message`, and an
 * optional `cause`. The `error` arm carries it, so a failure is a value and not a thrown `unknown`.
 */
export interface EffectError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * When a declared emission is appended, relative to the effect:
 * - `before`: the durable intent, before the effect runs. An interrupted run leaves a record.
 * - `on-success`: the success terminal, after the effect returns.
 * - `on-failure`: the failure terminal, after the effect throws.
 *
 * One run either returns or throws, so exactly one terminal holds.
 */
export type EmissionCondition = 'before' | 'on-success' | 'on-failure';

/**
 * One declared emission: a registered event name and the condition for its append. `event` is an
 * {@link EventType}, so a plan can promise only a fact that the catalog can validate, project, and
 * replay.
 */
export interface EffectEmission {
  readonly event: EventType;
  readonly when: EmissionCondition;
  readonly owner?: string;
  readonly role?: ActionEmission['role'];
}

/**
 * A plan that records no fact, and the reason. This arm makes "records nothing" a different value
 * from "nobody decided". `because` is required, because an abstention without a reason looks like
 * an oversight.
 */
export interface RecordsNothing {
  readonly kind: 'records-nothing';
  readonly because: string;
}

/**
 * A plan that records, with the emissions that it promises. The tuple type is not empty, so
 * `records()` with no argument does not compile. An empty list is an abstention in the wrong arm.
 */
export interface RecordsEmissions {
  readonly kind: 'records';
  readonly emissions: readonly [EffectEmission, ...EffectEmission[]];
}

/**
 * What a plan promises to record. Each {@link EffectPlan} requires it. An effect that cannot say
 * what records it is a state change that the event log does not know about.
 */
export type PlanEmissions = RecordsEmissions | RecordsNothing;

/** Declare the emissions a plan records. At least one, by type. */
export function records(
  first: EffectEmission,
  ...rest: readonly EffectEmission[]
): RecordsEmissions {
  return { kind: 'records', emissions: [first, ...rest] };
}

/** Declare that a plan records nothing, and why. */
export function recordsNothing(because: string): RecordsNothing {
  return { kind: 'records-nothing', because };
}

/**
 * The emissions that a plan declares, flattened across both arms. Consumers read this accessor, so
 * the `kind` check stays in this module.
 */
export function declaredEmissions(plan: EffectPlan): readonly EffectEmission[] {
  return plan.emits.kind === 'records' ? plan.emits.emissions : [];
}

/**
 * The typed plan for one effect. `owner` is the accountable owner, `idempotent` tells whether a
 * re-run is safe, and `compensation` names how to undo a partial effect, when one is necessary.
 * The `dry-run` carrier returns the plan as is, so a dry run fully describes the withheld effect.
 */
export interface EffectPlan {
  readonly effectClass: EffectClass;
  readonly owner: string;
  readonly description: string;
  readonly idempotent: boolean;
  readonly compensation?: string;
  /**
   * What the effect records: a set of emissions, each with its condition. The shape follows the
   * ledger of the mutation owner, an intent before the effect and one of two terminals after it.
   * Thus a verifier can tell "the intent landed" from "a terminal landed".
   *
   * It is required. An effect that records nothing declares {@link recordsNothing} with a reason.
   * Nothing here is inferred from `effectClass` or `owner`.
   */
  readonly emits: PlanEmissions;
}

/**
 * The fields that a caller supplies when a contract is present. It omits `idempotent`, so a caller
 * cannot pass a value that disagrees with `replay`.
 */
export type EffectPlanInput = Omit<EffectPlan, 'idempotent'>;

/** `safe-repeat` is the only replay that is safe to re-run. */
export function idempotentFromReplay(replay: ReplayPolicy): boolean {
  return replay.kind === 'safe-repeat';
}

/**
 * Builds an {@link EffectPlan} from the replay and emission blocks of a contract. Only
 * `safe-repeat` gives `idempotent: true`. When `emissions` is present, the event, owner, and role
 * come from that nested list, and events outside the catalog are skipped. `when` comes from the
 * sibling plan and never from `condition`. Actions without a contract build {@link EffectPlan}
 * directly.
 */
export function effectPlanFromContract(
  fields: EffectPlanInput,
  contract: Pick<ActionContract, 'replay'> & Partial<Pick<ActionContract, 'emissions'>>,
): EffectPlan {
  return {
    ...fields,
    idempotent: idempotentFromReplay(contract.replay),
    emits:
      contract.emissions === undefined
        ? fields.emits
        : planEmissionsFromContract(fields.emits, contract.emissions),
  };
}

function whenFromSibling(
  sibling: PlanEmissions,
  event: string,
  index: number,
): EmissionCondition {
  if (sibling.kind !== 'records') return 'on-success';
  const byEvent = sibling.emissions.find((emission) => emission.event === event);
  if (byEvent !== undefined) return byEvent.when;
  const byIndex = sibling.emissions[index];
  if (byIndex !== undefined) return byIndex.when;
  return sibling.emissions[0]?.when ?? 'on-success';
}

function planEmissionsFromContract(
  sibling: PlanEmissions,
  emissions: ActionContract['emissions'],
): PlanEmissions {
  if (emissions.kind === 'none') {
    return recordsNothing(emissions.because);
  }
  const mapped: EffectEmission[] = [];
  for (const [index, emission] of emissions.values.entries()) {
    if (!isBuiltInEventType(emission.event)) continue;
    mapped.push({
      event: emission.event as EventType,
      when: whenFromSibling(sibling, emission.event, index),
      owner: emission.owner,
      role: emission.role,
    });
  }
  const first = mapped[0];
  if (first === undefined) {
    return recordsNothing('nested contract named no catalog emissions');
  }
  return records(first, ...mapped.slice(1));
}

/**
 * Claim-required identity: the existing effect-idempotency key plus the
 * existing subject/request replay identity. No additional claim key is minted.
 */
export function replayIdentityFromEffectKey(
  ctx: AuthenticatedRequestContext,
  effectKey: EffectIdempotencyKey,
  payload: unknown,
): ReplayIdentity {
  return deriveReplayIdentity(ctx, effectKey.value, payload);
}

/**
 * The emissions that a plan declares for one condition, in declaration order. Thus a consumer that
 * appends the intent cannot reach a terminal. A verifier can ask if the intent landed separately
 * from a terminal.
 */
export function emissionsWhen(
  plan: EffectPlan,
  when: EmissionCondition,
): readonly EffectEmission[] {
  return declaredEmissions(plan).filter((emission) => emission.when === when);
}

/**
 * The effect carrier: a discriminated union over `kind`. Consumers switch on
 * `kind` and the compiler enforces exhaustiveness, so a new arm cannot be
 * silently ignored.
 */
export type EffectOutcome<T> =
  | { readonly kind: 'success'; readonly value: T; readonly evidence: EmissionEvidence }
  | { readonly kind: 'error'; readonly error: EffectError }
  | { readonly kind: 'dry-run'; readonly plan: EffectPlan };

/**
 * Constructs a `success` carrier. Evidence is required, so a value of `T` from a success carrier
 * means that the append happened.
 */
export function succeeded<T>(value: T, evidence: EmissionEvidence): EffectOutcome<T> {
  return { kind: 'success', value, evidence };
}

/** Construct an `error` carrier from a structured {@link EffectError}. */
export function failed<T>(error: EffectError): EffectOutcome<T> {
  return { kind: 'error', error };
}

/** Construct a `dry-run` carrier from the withheld {@link EffectPlan}. */
export function plannedDryRun<T>(plan: EffectPlan): EffectOutcome<T> {
  return { kind: 'dry-run', plan };
}

/** Narrow to the `success` arm. */
export function isSuccess<T>(
  outcome: EffectOutcome<T>,
): outcome is { readonly kind: 'success'; readonly value: T; readonly evidence: EmissionEvidence } {
  return outcome.kind === 'success';
}

/** Narrow to the `error` arm. */
export function isError<T>(
  outcome: EffectOutcome<T>,
): outcome is { readonly kind: 'error'; readonly error: EffectError } {
  return outcome.kind === 'error';
}

/** Narrow to the `dry-run` arm. */
export function isDryRun<T>(
  outcome: EffectOutcome<T>,
): outcome is { readonly kind: 'dry-run'; readonly plan: EffectPlan } {
  return outcome.kind === 'dry-run';
}

/**
 * Execution mode. `dry-run` is a distinct variant, not a boolean flag, so a
 * caller must consciously opt into withholding the effect.
 */
export type EffectMode =
  | { readonly kind: 'live' }
  | { readonly kind: 'dry-run' };

/** Canonical live mode. */
export const LIVE: EffectMode = { kind: 'live' };
/** Canonical dry-run mode. */
export const DRY_RUN: EffectMode = { kind: 'dry-run' };

/** Coerce an unknown thrown value into a structured {@link EffectError}. */
export function toEffectError(plan: EffectPlan, cause: unknown): EffectError {
  const message =
    cause instanceof Error ? cause.message : `effect '${plan.description}' failed`;
  return {
    code: `${plan.effectClass.toUpperCase()}_EFFECT_FAILED`,
    message,
    cause,
  };
}

/** Module-private capability brand: unnameable elsewhere, therefore unforgeable. */
const EMISSION_RECORDER_BRAND: unique symbol = Symbol('exarchos.effect.emissionRecorder');

/** Module-private evidence brand. Only {@link emissionRecorder} mints one. */
const EMISSION_RECEIPT_BRAND: unique symbol = Symbol('exarchos.effect.emissionReceipt');

/**
 * The module-private brand for the evidence of a committed value. It is separate from the receipt
 * brand, because evidence has two arms and only one is a receipt. Without it, a hand-built replay
 * witness can buy a committed value.
 */
const EMISSION_EVIDENCE_BRAND: unique symbol = Symbol('exarchos.effect.emissionEvidence');

/**
 * Evidence that one declared emission was recorded. The capability mints it after its sink
 * returns, so a sink that throws gives no receipt. The carrier counts only receipts that it minted.
 */
export interface EmissionReceipt {
  readonly [EMISSION_RECEIPT_BRAND]: true;
  readonly event: EventType;
  readonly when: EmissionCondition;
}

/**
 * This run recorded the plan's declarations, and here are the receipts.
 *
 * The ordinary arm: one minted receipt per declared emission, collected across
 * the intent and the terminal that actually fired.
 */
export interface RecordedEvidence {
  readonly [EMISSION_EVIDENCE_BRAND]: true;
  readonly kind: 'recorded';
  readonly receipts: readonly EmissionReceipt[];
}

/**
 * Evidence that a previous run recorded the terminal, and this run replays it. A replayed effect
 * performs nothing and mints nothing. The owner read the earlier append from its own ledger, so a
 * new receipt makes a false claim about which run wrote the fact.
 */
export interface ReplayedEvidence {
  readonly [EMISSION_EVIDENCE_BRAND]: true;
  readonly kind: 'replayed';
  /** The terminal a previous run recorded, as read from the ledger. */
  readonly event: EventType;
  /** How the caller knows it landed. Named so a reader can audit the claim. */
  readonly source: string;
}

/**
 * Evidence that the record of a committed value exists, from this run or an earlier one. The
 * `success` arm carries it.
 *
 * The brand stops an object literal from becoming evidence, but the two arms are not equally
 * strong. {@link emissionRecorder} needs a sink that {@link runEffect} awaits before it mints a
 * receipt. {@link replayedEvidence} takes two strings and does no IO, so any importer can mint
 * one. Use the witness only to replay a terminal that the owner read from its own ledger. Review
 * enforces this rule, not the type or the runtime gate.
 */
export type EmissionEvidence = RecordedEvidence | ReplayedEvidence;

/**
 * The only construction path for replay evidence. It is exported, because the owner that replays
 * is in another module. It is branded, so an object literal cannot buy a committed value.
 */
export function replayedEvidence(event: EventType, source: string): ReplayedEvidence {
  return { [EMISSION_EVIDENCE_BRAND]: true, kind: 'replayed', event, source };
}

/** Mint evidence from receipts this run collected. Module-private on purpose. */
function recordedEvidence(receipts: readonly EmissionReceipt[]): RecordedEvidence {
  return { [EMISSION_EVIDENCE_BRAND]: true, kind: 'recorded', receipts };
}

/**
 * Where a fact lands, which the owner decides. It is the argument of {@link emissionRecorder},
 * because each owner already has a sink. A sink alone does not satisfy the port. The owner must
 * wrap it.
 */
export type EmissionSink = (
  emission: EffectEmission,
  plan: EffectPlan,
) => void | Promise<void>;

/**
 * The branded capability that records a declared emission. A function type accepts `() => {}`, so
 * a no-op recorder can buy a committed value. Only {@link emissionRecorder} can set the
 * module-private brand. The method is `record`, not `append`: this module holds no store, and the
 * sink of the owner appends.
 *
 * A recorder failure is not an effect failure. It propagates and does not enter the `error` arm,
 * because an owner that cannot write the ledger must not continue.
 */
export interface EmissionRecorder {
  readonly [EMISSION_RECORDER_BRAND]: true;
  record(emission: EffectEmission, plan: EffectPlan): Promise<EmissionReceipt>;
}

/**
 * The only construction path for the capability. An owner wraps the sink that it has. A sink, a
 * lambda of the same arity, and an object literal with a `record` method cannot name the brand.
 * So none of them satisfies the type.
 */
export function emissionRecorder(sink: EmissionSink): EmissionRecorder {
  return {
    [EMISSION_RECORDER_BRAND]: true,
    async record(emission, plan) {
      await sink(emission, plan);
      return { [EMISSION_RECEIPT_BRAND]: true, event: emission.event, when: emission.when };
    },
  };
}

/**
 * A runtime brand check for the boundary that the type system does not govern: an untyped caller,
 * a `JSON.parse` round trip, or a cast. It enforces the same claim as the compile-time proof.
 */
function isEmissionRecorder(candidate: unknown): candidate is EmissionRecorder {
  if (typeof candidate !== 'object' || candidate === null) return false;
  if (!(EMISSION_RECORDER_BRAND in candidate)) return false;
  return candidate[EMISSION_RECORDER_BRAND] === true;
}

/** The same check for the evidence, so a forged recorder's return is caught too. */
function isEmissionReceipt(candidate: unknown): candidate is EmissionReceipt {
  if (typeof candidate !== 'object' || candidate === null) return false;
  if (!(EMISSION_RECEIPT_BRAND in candidate)) return false;
  return candidate[EMISSION_RECEIPT_BRAND] === true;
}

/**
 * Thrown when the declared record of a plan has no evidence. It is thrown and not returned as an
 * `error` carrier, because a missing record is an owner wiring fault and not an effect failure. A
 * caller that reads `error.code` must not confuse the two.
 */
export class UnrecordedEmissionError extends Error {
  readonly code = 'EMISSION_NOT_RECORDED';
  constructor(
    readonly plan: EffectPlan,
    readonly when: EmissionCondition,
    readonly appended: number,
    readonly declared: number,
  ) {
    super(
      `effect '${plan.description}' (owner ${plan.owner}) declares ${declared} '${when}' ` +
        `emission(s) but evidenced ${appended}; a committed value requires the record. ` +
        'Pass a recorder built by emissionRecorder().',
    );
    this.name = 'UnrecordedEmissionError';
  }
}

/**
 * Records each emission that a plan declares for one condition, in order, and returns the
 * receipts. A condition with no declaration records nothing, which is normal for an intent-only
 * plan at its terminal. When a condition declares, the run continues only with one minted receipt
 * per declared emission. Otherwise it throws.
 */
async function recordEmissions(
  plan: EffectPlan,
  when: EmissionCondition,
  recorder: EmissionRecorder | undefined,
): Promise<readonly EmissionReceipt[]> {
  const declared = emissionsWhen(plan, when);
  if (declared.length === 0) return [];
  if (!isEmissionRecorder(recorder)) {
    throw new UnrecordedEmissionError(plan, when, 0, declared.length);
  }
  const receipts: EmissionReceipt[] = [];
  for (const emission of declared) {
    const receipt: unknown = await recorder.record(emission, plan);
    if (!isEmissionReceipt(receipt)) break;
    receipts.push(receipt);
  }
  if (receipts.length !== declared.length) {
    throw new UnrecordedEmissionError(plan, when, receipts.length, declared.length);
  }
  return receipts;
}

/**
 * Runs an effect through its typed owner and returns a typed carrier. In dry-run mode it returns
 * the plan first, so it never calls `execute` or `record`.
 *
 * In live mode it refuses to run unless `recorder` is a real {@link EmissionRecorder}, also for a
 * plan that records nothing. The check comes before the thunk, so the effect does not change the
 * world before the refusal. Then the intent fires, the thunk runs, and exactly one terminal fires.
 * A thrown value from the thunk becomes an `error` carrier. Only the thunk is inside the `try`.
 * The success carrier needs the terminal receipts, so the code builds it after the terminal record.
 */
export async function runEffect<T>(
  mode: EffectMode,
  plan: EffectPlan,
  execute: () => Promise<T>,
  recorder: EmissionRecorder,
): Promise<EffectOutcome<T>> {
  if (mode.kind === 'dry-run') {
    return plannedDryRun(plan);
  }
  if (!isEmissionRecorder(recorder)) {
    throw new UnrecordedEmissionError(plan, 'before', 0, declaredEmissions(plan).length);
  }
  const intentReceipts = await recordEmissions(plan, 'before', recorder);

  let ran: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: EffectError };
  let terminal: EmissionCondition;
  try {
    ran = { ok: true, value: await execute() };
    terminal = 'on-success';
  } catch (cause) {
    ran = { ok: false, error: toEffectError(plan, cause) };
    terminal = 'on-failure';
  }

  const terminalReceipts = await recordEmissions(plan, terminal, recorder);
  return ran.ok
    ? succeeded(ran.value, recordedEvidence([...intentReceipts, ...terminalReceipts]))
    : failed(ran.error);
}

/**
 * A durable idempotency key, always scoped to the stream that claims it. `value` is the composed
 * text that a store call claims. `stream` and `key` stay alongside it, so a consumer can read
 * either one without a parse. The claims table key `(streamId, idempotencyKey)` stops a collision
 * across streams. This type also stops a bare key string from drifting to the wrong stream.
 */
export interface EffectIdempotencyKey {
  readonly stream: string;
  readonly key: string;
  readonly value: string;
}

/**
 * The only construction path for an {@link EffectIdempotencyKey}. It rejects a missing or blank
 * stream at construction, not at the store call that later claims the key.
 */
export function effectIdempotencyKey(stream: string, key: string): EffectIdempotencyKey {
  if (typeof stream !== 'string' || stream.trim().length === 0) {
    throw new TypeError(
      'effectIdempotencyKey requires a non-empty stream — an idempotency key ' +
        'built without its stream dimension cannot be constructed.',
    );
  }
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new TypeError('effectIdempotencyKey requires a non-empty key.');
  }
  return { stream, key, value: `${stream}:${key}` };
}

/**
 * Compiles only when `T` is exactly `true`. The proof aliases live in a `src/` file, because the
 * root `tsconfig.json` includes only `src/**`, and `tests/tsconfig.json` excludes the unit tier.
 */
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;
/** Set equality, wrapped in tuples so neither side distributes. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * A bare no-op lambda is not an {@link EmissionRecorder}. Falsifier: remove the brand property, or
 * widen the port to a function type, and this alias stops being `true`.
 * @proof
 */
export type _EffectCarrier_NoOpLambda_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<() => void, EmissionRecorder>
>;

/**
 * A lambda with the {@link EmissionSink} signature is not an {@link EmissionRecorder} either. So the
 * correct arity does not get past the brand.
 * @proof
 */
export type _EffectCarrier_PortShapedLambda_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<EmissionSink, EmissionRecorder>
>;

/**
 * An object literal with a `record` method of the declared signature is not an
 * {@link EmissionRecorder}. No external declaration can name the module-private brand.
 * @proof
 */
export type _EffectCarrier_UnbrandedRecordMethod_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<
    { record(emission: EffectEmission, plan: EffectPlan): Promise<EmissionReceipt> },
    EmissionRecorder
  >
>;

/**
 * A plain object that names the event and the condition is not an {@link EmissionReceipt}. So a
 * description of a record that nobody wrote cannot satisfy the commit gate.
 * @proof
 */
export type _EffectCarrier_PlainRecord_IsNotAnEmissionReceipt = Expect<
  IsNotAssignable<{ readonly event: EventType; readonly when: EmissionCondition }, EmissionReceipt>
>;

/**
 * The `recorder` parameter of `runEffect` is exactly the minted capability. With the negative
 * proofs above, only a value from {@link emissionRecorder} can fill it. The runtime gate then
 * refuses a committed value until each declared emission has a minted receipt.
 *
 * Falsifier: widen the parameter to a function type, or to `EmissionRecorder | undefined`. This
 * alias does not catch a default built from {@link emissionRecorder} around a sink that writes
 * nothing. A behavior test covers that case: an omitted recorder must refuse to commit.
 * @proof
 */
export type _EffectCarrier_CommittedValue_IsUnreachableWithoutTheCapability = Expect<
  MutuallyAssignable<Parameters<typeof runEffect>[3], EmissionRecorder>
>;

/**
 * The capability returns evidence, not `void`. With a `void` return the carrier has nothing to
 * count, and a no-op passes the gate.
 * @proof
 */
export type _EffectCarrier_Record_YieldsAMintedReceipt = Expect<
  MutuallyAssignable<Awaited<ReturnType<EmissionRecorder['record']>>, EmissionReceipt>
>;

/**
 * The constructor mints the capability, so the negative proofs reject only the unbranded case.
 * Without this alias, a narrowed {@link EmissionRecorder} that nothing can produce lets each proof
 * pass.
 * @proof
 */
export type _EffectCarrier_Constructor_MintsTheCapability = Expect<
  ReturnType<typeof emissionRecorder> extends EmissionRecorder ? true : false
>;

/**
 * A plan without an emission declaration is not an {@link EffectPlan}, so an omitted record is a
 * build failure. Falsifier: make `emits` optional, and this alias stops being `true`.
 * @proof
 */
export type _EffectCarrier_PlanWithoutEmissions_IsNotAnEffectPlan = Expect<
  IsNotAssignable<
    {
      readonly effectClass: EffectClass;
      readonly owner: string;
      readonly description: string;
      readonly idempotent: boolean;
    },
    EffectPlan
  >
>;

/**
 * The abstention is a legal declaration, so the proof above rejects only the omission. Without
 * this alias, an `emits` that nothing can satisfy lets the proof above pass.
 * @proof
 */
export type _EffectCarrier_RecordsNothing_IsALegalDeclaration = Expect<
  ReturnType<typeof recordsNothing> extends PlanEmissions ? true : false
>;

/**
 * A `records` arm with no emissions cannot be built, so an abstention cannot hide in the declaring
 * arm. Falsifier: widen `emissions` to `readonly EffectEmission[]`, and this alias goes false.
 * @proof
 */
export type _EffectCarrier_EmptyEmissionList_IsNotADeclaringArm = Expect<
  IsNotAssignable<{ readonly kind: 'records'; readonly emissions: readonly [] }, RecordsEmissions>
>;

/**
 * The success arm without evidence is not an outcome. So `T` comes only from a value that says the
 * append happened. Falsifier: make `evidence` optional on the success arm, and this alias stops
 * being `true`.
 * @proof
 */
export type _EffectCarrier_SuccessWithoutEvidence_IsNotAnOutcome = Expect<
  IsNotAssignable<{ readonly kind: 'success'; readonly value: number }, EffectOutcome<number>>
>;

/**
 * A plain object that names the replayed event is not {@link EmissionEvidence}, so the replay arm
 * cannot get around the commit gate. Falsifier: remove the brand from the evidence arms, and this
 * alias goes false.
 * @proof
 */
export type _EffectCarrier_PlainWitness_IsNotEmissionEvidence = Expect<
  IsNotAssignable<
    { readonly kind: 'replayed'; readonly event: EventType; readonly source: string },
    EmissionEvidence
  >
>;

/**
 * The witness constructor mints the brand, so the proof above rejects only the forgery.
 * @proof
 */
export type _EffectCarrier_ReplayConstructor_MintsEvidence = Expect<
  ReturnType<typeof replayedEvidence> extends EmissionEvidence ? true : false
>;

/**
 * A contract-bound plan input cannot carry an independent `idempotent` flag.
 * Falsifier: add `idempotent` back onto {@link EffectPlanInput}.
 * @proof
 */
export type _EffectCarrier_ContractPlanInput_OmitsIdempotent = Expect<
  'idempotent' extends keyof EffectPlanInput ? false : true
>;

/**
 * The contract emission `condition` is not an {@link EmissionCondition}, so a copy onto `when`
 * does not compile. The two clocks stay separate. Falsifier: widen {@link EmissionCondition} to
 * include `always` or `conditional`.
 * @proof
 */
export type _EffectCarrier_ContractCondition_IsNotEmissionWhen = Expect<
  IsNotAssignable<'always' | 'conditional', EmissionCondition>
>;
