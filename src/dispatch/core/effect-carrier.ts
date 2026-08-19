/**
 * P04-01 — Typed effect carriers (effect algebra).
 *
 * The unified remediation plan (PROGRAM-04) requires that **every effect has one
 * typed owner, idempotency boundary, and repair or compensation contract**. This
 * module is the value-level half of that mandate: a discriminated union that
 * carries the result of executing an effect through a typed owner, with a
 * first-class **dry-run** arm.
 *
 * Three arms, exhaustively:
 *   - `success` — the effect ran and produced a value;
 *   - `error`   — the effect ran and failed, carrying a structured {@link EffectError};
 *   - `dry-run` — the effect was NOT run; the carrier reports the {@link EffectPlan}
 *                 that *would* have executed.
 *
 * Dry-run is load-bearing, not cosmetic: {@link runEffect} in dry-run mode is
 * structurally incapable of performing the real effect — it returns the plan
 * without ever invoking the `execute` thunk, and it appends none of the plan's
 * declared emissions either. A caller can therefore prove, by construction,
 * that a dry-run planned no observable side effect and recorded no fact.
 */

import type { EventType } from '../../events/schemas.js';

/**
 * Which vocabulary governs which claim.
 *
 * Three vocabularies meet on an {@link EffectPlan}. They answer three different
 * questions, they are kept SEPARATE deliberately, and none of the three governs
 * what a plan emits — worth stating before anyone reaches for one of them to
 * explain the emission field.
 *
 *   1. {@link EffectClass} below answers WHAT KIND of side effect ran. Six
 *      domain-level members, read in exactly one place: {@link toEffectError},
 *      which derives the failure code from it.
 *
 *   2. The architecture layer's effect ledger declares a DIFFERENT type that is
 *      also spelled `EffectClass`, with three members (`filesystem`, `process`,
 *      `network`). That one is a DETECTION vocabulary: its members are exactly
 *      the primitives a static scan of import specifiers can find, and its
 *      census claims totality over them. Those three names recur among the six
 *      here, but the six are not an extension of that axis — `vcs` and
 *      `install` are compositions of the primitives and `compensation` is a
 *      role rather than a primitive. Folding the two together would either make
 *      the census un-derivable or force this carrier to describe a git mutation
 *      as `process`. They stay distinct, and this module does not import the
 *      ledger's type: the layer table admits no `dispatch` → `architecture`
 *      edge, which is the same separation expressed as a build rule.
 *
 *   3. {@link EffectPlan.owner} answers WHO IS ACCOUNTABLE. Free-form on
 *      purpose rather than an enum, because it is the same accountability axis
 *      the ledger's ownership rules use, and those name an owner by module path
 *      (`install/atomic-promotion`) as readily as by role
 *      (`vcs-mutation-owner`). An enum here would have to be re-agreed with
 *      that census every time a module moves.
 *
 * {@link EffectPlan.emits} answers WHAT IS RECORDED and resolves against NONE
 * of the three. Its authority is the event catalog: every declared `event` is
 * an {@link EventType}, so a name the catalog has not registered is a compile
 * error here. Emission is not a function of effect kind — two `vcs` effects can
 * record different ledgers, and an effect of any class may record nothing — and
 * it is not a function of owner either, since one owner writes several.
 */

/**
 * The five effect primitives the plan enumerates, plus `compensation` (the
 * repair effect a saga runs to undo a partial effect). Every ledger occurrence
 * and every carrier names exactly one.
 */
export type EffectClass =
  | 'filesystem'
  | 'process'
  | 'vcs'
  | 'install'
  | 'network'
  | 'compensation';

/**
 * A structured, throw-free description of an effect failure. Mirrors the
 * codebase convention ({@link ../utils/process.js} `SpawnError`, VCS
 * `UnsupportedOperationError`): a machine-readable `code` plus a human `message`
 * and an optional `cause`. Carried by the `error` arm so failures are values,
 * never bare `unknown` throws.
 */
export interface EffectError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * When, relative to the effect, a declared emission is appended.
 *
 *   - `before`     — the durable INTENT, appended BEFORE the effect runs, so an
 *                    interrupted run leaves a record to converge on;
 *   - `on-success` — the success TERMINAL, appended after the effect returns;
 *   - `on-failure` — the failure TERMINAL, appended after the effect throws.
 *
 * The two terminals are mutually exclusive by construction: one execution
 * either returns or throws, so exactly one terminal condition holds.
 */
export type EmissionCondition = 'before' | 'on-success' | 'on-failure';

/**
 * One declared emission: a registered event name plus the condition under which
 * it is appended.
 *
 * `event` is an {@link EventType}, so this module names no event of its own —
 * a plan can only promise to record a fact the catalog already knows how to
 * validate, project and replay.
 */
export interface EffectEmission {
  readonly event: EventType;
  readonly when: EmissionCondition;
}

/**
 * The typed plan for a single effect. It encodes the three things the plan
 * mandates for every effect:
 *   - `owner`        — the single typed owner accountable for the effect;
 *   - `idempotent`   — the idempotency boundary (safe to re-run?);
 *   - `compensation` — the repair/compensation contract (how a partial effect is
 *                      undone), or `undefined` when the effect needs none.
 *
 * The `dry-run` carrier returns this verbatim, so a dry-run is a full, typed
 * account of the effect that was withheld.
 */
export interface EffectPlan {
  readonly effectClass: EffectClass;
  readonly owner: string;
  readonly description: string;
  readonly idempotent: boolean;
  readonly compensation?: string;
  /**
   * What running this effect records — a SET of emissions, each carrying the
   * condition under which it fires, not a single event name.
   *
   * The shape follows the ledger the mutation owner already writes: an intent
   * before the effect and one of two terminals after it. A lone `emits: string`
   * cannot express that, and a downstream verifier reading one would be unable
   * to tell "the intent landed" from "a terminal landed" — the exact
   * distinction that says whether an interrupted run needs convergence.
   *
   * Optional, so a plan that records nothing stays a legal plan and every
   * construction site that predates the emission axis still compiles. An
   * undeclared `emits` means "this plan promises no record", never "the record
   * is inferred from `effectClass` or `owner`"; see the vocabulary note above.
   */
  readonly emits?: readonly EffectEmission[];
}

/**
 * The emissions a plan declares for one condition, in declaration order.
 *
 * Selecting by condition is the whole point of the set: a consumer appending
 * the intent cannot reach a terminal, and a verifier can ask "did the intent
 * land?" separately from "did a terminal land?".
 */
export function emissionsWhen(
  plan: EffectPlan,
  when: EmissionCondition,
): readonly EffectEmission[] {
  return (plan.emits ?? []).filter((emission) => emission.when === when);
}

/**
 * The effect carrier: a discriminated union over `kind`. Consumers switch on
 * `kind` and the compiler enforces exhaustiveness, so a new arm cannot be
 * silently ignored.
 */
export type EffectOutcome<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'error'; readonly error: EffectError }
  | { readonly kind: 'dry-run'; readonly plan: EffectPlan };

/** Construct a `success` carrier. */
export function succeeded<T>(value: T): EffectOutcome<T> {
  return { kind: 'success', value };
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
): outcome is { readonly kind: 'success'; readonly value: T } {
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

// ─── The emission port: a capability, not a callback ─────────────────────────
//
// The port is a BRANDED CAPABILITY, not a bare function type. A bare function
// type is satisfied by `() => {}`, and that is the hole: an owner could hand the
// carrier a do-nothing recorder, watch the effect run, and get a committed value
// back as though the fact had been recorded. Recording is the PRECONDITION for
// the effect, so the two must not be separable that way — the committed value
// has to be unreachable without the record, not merely discouraged without it.
//
// Two brands close it, both module-private `unique symbol`s. Nothing outside
// this file can name either property, so neither the capability nor its receipt
// has any construction path but the one below, and an arbitrary lambda or object
// literal does not satisfy the types. The compile-time proofs at the foot of the
// module state that as a claim `tsc` verifies.
//
// Why a brand over a store-derived constructor: this module deliberately does
// not know where a fact lands (see {@link EmissionSink}), and the owners that
// will adopt this record through their OWN typed helpers rather than through a
// raw store handle. A constructor taking a store would hard-wire the carrier to
// one store shape and still leave those owners without an adoptable path; a
// constructor taking their existing sink gives them one and does the closing
// just as completely, because the brand — not the argument — is the tooth.
//
// ── Why the verb is `record` and not `append` ────────────────────────────────
// `append` is this package's EVENT-STORE verb: every other `.append(…)` in
// `src/` is a store call, `store.append(streamId, event)`. This module holds no
// store, constructs no event, and has exactly one runtime-free `import type` —
// it hands an emission to the owner's sink and the OWNER appends. Naming the
// capability's method `append` therefore claimed an operation the module's own
// {@link EmissionSink} doc explicitly disclaims, while the rest of its
// vocabulary already said `record` ({@link UnrecordedEmissionError},
// `EMISSION_NOT_RECORDED`, "a plan that records nothing").
//
// It also mis-described the call to a reader, and to the ownership census that
// scans for direct evidence emitters: reading a `recorder.append(emission, plan)`
// hand-off as a store append, the census took the plan for the event, found no
// `type`, and reported an unresolvable emitter in a module that cannot reach a
// store. The fix is the accurate verb, not an acknowledgement row — the census
// keeps full coverage here, so a real store append added to this module later is
// still caught.

/** Module-private capability brand: unnameable elsewhere, therefore unforgeable. */
const EMISSION_RECORDER_BRAND: unique symbol = Symbol('exarchos.effect.emissionRecorder');

/** Module-private evidence brand. Only {@link emissionRecorder} mints one. */
const EMISSION_RECEIPT_BRAND: unique symbol = Symbol('exarchos.effect.emissionReceipt');

/**
 * Evidence that one declared emission was recorded.
 *
 * Minted by the capability AFTER its sink returns, so a sink that throws yields
 * no receipt. This is what makes the commit gate causal rather than nominal: the
 * carrier counts receipts it minted itself instead of trusting that whatever it
 * was handed did something.
 */
export interface EmissionReceipt {
  readonly [EMISSION_RECEIPT_BRAND]: true;
  readonly event: EventType;
  readonly when: EmissionCondition;
}

/**
 * Where a fact actually lands — the owner's business, not this module's.
 *
 * This is the shape the port used to BE. It is kept, as the constructor's
 * argument, because it is the shape every prospective owner already has; what
 * changed is that supplying one is no longer the same act as satisfying the
 * port. Wrapping is now explicit, which is precisely the step a no-op cannot
 * fake its way past.
 */
export type EmissionSink = (
  emission: EffectEmission,
  plan: EffectPlan,
) => void | Promise<void>;

/**
 * The capability a declared emission is recorded through.
 *
 * A recorder failure is NOT an effect failure: it propagates rather than being
 * captured into the `error` arm. Recording the intent is the precondition for
 * running the effect at all, so an owner that cannot write the ledger must not
 * proceed as though it had.
 */
export interface EmissionRecorder {
  readonly [EMISSION_RECORDER_BRAND]: true;
  record(emission: EffectEmission, plan: EffectPlan): Promise<EmissionReceipt>;
}

/**
 * The ONLY construction path for the capability.
 *
 * Deliberately the whole surface: an owner wraps the sink it already has and
 * gets something the carrier will accept. Nothing else will do — not the sink
 * itself, not a lambda of the right arity, not an object literal carrying a
 * `record` method, because none of the three can name the brand.
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
 * Runtime brand check, for the boundary the type system does not govern: an
 * untyped caller, a `JSON.parse` round trip, or a deliberate cast can all put a
 * shape here that `tsc` would have rejected. The compile-time proof and this
 * guard are the same claim enforced on both sides of that boundary.
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
 * Raised when a plan's declared record could not be evidenced.
 *
 * Thrown, not returned as an `error` carrier, for the reason the port itself
 * propagates: an unrecordable fact is a wiring fault in the owner, not a failure
 * of the effect, and reporting it through the effect's own failure channel would
 * let a caller reading `error.code` mistake one for the other.
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
 * Record every emission a plan declares for one condition, in order, and return
 * the receipts.
 *
 * A plan declaring nothing for the condition records nothing and needs no
 * capability — that is what keeps a plan with no `emits` inert. Once a plan does
 * declare, though, the run may only continue on evidence: one minted receipt per
 * declared emission. Anything less throws.
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
 * Run an effect through its typed owner and return a typed carrier.
 *
 * The dry-run guarantee is structural: when `mode.kind === 'dry-run'`, the
 * `execute` thunk is **never invoked** and `record` is **never called** — the
 * function returns the {@link EffectPlan} directly, ahead of every other
 * statement. There is no code path in dry-run mode that reaches either, so a
 * dry-run provably performs no real effect and records no fact. Declaring
 * emissions on a plan does not weaken that: a withheld effect must leave the
 * ledger as silent as it leaves the disk.
 *
 * In `live` mode the intent fires, then the thunk runs, then exactly one
 * terminal fires — whichever condition the outcome met. A thrown value from the
 * thunk is captured into an `error` carrier rather than propagating, so
 * `runEffect` never rejects for an effect failure. Only the thunk sits inside
 * the `try`, so a terminal record cannot be mistaken for the effect failing.
 *
 * A plan declaring no emissions records nothing, needs no capability, and leaves
 * the three-arm carrier exactly as it is. A plan that DOES declare gets the
 * commit gate: the effect is refused up front unless a real
 * {@link EmissionRecorder} was supplied — so the thunk does not run either — and
 * the `return` below is reached only after the terminal record produced one
 * minted receipt per declared emission. There is no path from a no-op to a
 * committed value; the record is not merely expected, it is on the way.
 */
export async function runEffect<T>(
  mode: EffectMode,
  plan: EffectPlan,
  execute: () => Promise<T>,
  recorder?: EmissionRecorder,
): Promise<EffectOutcome<T>> {
  if (mode.kind === 'dry-run') {
    return plannedDryRun(plan);
  }
  // Refused BEFORE the thunk, not at the terminal: an owner that cannot record
  // must not perform the effect at all, and a plan whose only emission is a
  // terminal would otherwise mutate the world before discovering that.
  const declaredCount = plan.emits?.length ?? 0;
  if (declaredCount > 0 && !isEmissionRecorder(recorder)) {
    throw new UnrecordedEmissionError(plan, 'before', 0, declaredCount);
  }
  await recordEmissions(plan, 'before', recorder);

  let outcome: EffectOutcome<T>;
  let terminal: EmissionCondition;
  try {
    outcome = succeeded(await execute());
    terminal = 'on-success';
  } catch (cause) {
    outcome = failed(toEffectError(plan, cause));
    terminal = 'on-failure';
  }

  await recordEmissions(plan, terminal, recorder);
  return outcome;
}

// ─── Idempotency key: the stream dimension is part of construction ──────────
//
// `storage/sqlite/schema.ts` declares `PRIMARY KEY (streamId, idempotencyKey)`
// on the claims table, so two streams reusing the same key TEXT already cannot
// collide once a claim lands — that guarantee needs no help from this type and
// predates it.
//
// What the composite primary key does NOT close: nothing stops a caller from
// building "the key" as a bare string with no stream in view at all, and
// handing it to a store call that supplies the stream on a separate argument.
// The two can drift — a copy-pasted key built for one stream, threaded through
// code that appends to another — and nothing notices, because a bare string
// carries no stream of its own to disagree with. This type closes that by
// making the stream part of what gets BUILT, not merely part of where the
// result later gets filed: a key that has not named its stream cannot exist,
// so there is nothing to thread anywhere, correctly or otherwise.

/**
 * A durable idempotency key, always scoped to the stream it will be claimed
 * against. `value` is the composed text a store call claims; `stream` and
 * `key` are kept alongside it so a consumer can read either dimension back
 * without re-parsing the composition.
 */
export interface EffectIdempotencyKey {
  readonly stream: string;
  readonly key: string;
  readonly value: string;
}

/**
 * The ONLY construction path for an {@link EffectIdempotencyKey}.
 *
 * Rejects a missing or blank stream HERE, at construction, rather than
 * downstream at whichever store call eventually claims the key. By the time a
 * store call runs, a caller that built the text by hand has already made the
 * omission unrecoverable — the fix belongs at the one place a key comes into
 * existence, not at every place one might later be spent.
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

// ─── Compile-time proofs (verified by `npm run typecheck`) ───────────────────
//
// These exported type aliases live in a NON-TEST source file on purpose. The
// root `tsconfig.json` includes only `src/**`, and `tests/tsconfig.json` excludes
// the unit and integration tiers outright, so the same assertions written in the
// co-located test would be checked by NOTHING — not by the build, which never
// sees the file, and not by vitest, which strips types before running it. The
// `_OutputSchema*` aliases in `output-schema-declaration.ts` and the
// `_RegistrationValidate_*` aliases in `events/registration-validate.ts` are the
// precedent. `Expect<T extends true>` is a compile error unless T is exactly
// `true`.
type Expect<T extends true> = T;
type IsNotAssignable<A, B> = A extends B ? false : true;
/** Set equality, wrapped in tuples so neither side distributes. */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * **The hole, closed.** A bare no-op lambda is not an {@link EmissionRecorder}.
 * This is the whole point: the port used to be a function type, so `() => {}`
 * satisfied it and a caller could buy a committed value with nothing.
 *
 * Falsifier: drop the brand property from the interface, or widen the port back
 * to a function type, and this alias stops being `true`.
 * @proof
 */
export type _EffectCarrier_NoOpLambda_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<() => void, EmissionRecorder>
>;

/**
 * …and neither is a lambda of the RIGHT shape. {@link EmissionSink} is exactly
 * the signature this port used to have, which makes this the sharpest statement
 * of the change: every value that satisfied the old port fails the new one, so
 * the closure cannot be sidestepped by getting the arity right.
 * @proof
 */
export type _EffectCarrier_PortShapedLambda_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<EmissionSink, EmissionRecorder>
>;

/**
 * Nor an object literal carrying a `record` method of the exact declared
 * signature. Structural typing is what would otherwise let a hand-rolled stub
 * back in through the object form once the lambda form was closed; the brand is
 * module-private, so no external declaration can name it.
 * @proof
 */
export type _EffectCarrier_UnbrandedRecordMethod_IsNotAnEmissionRecorder = Expect<
  IsNotAssignable<
    { record(emission: EffectEmission, plan: EffectPlan): Promise<EmissionReceipt> },
    EmissionRecorder
  >
>;

/**
 * The evidence is unforgeable on the same terms. A plain object naming the event
 * and the condition is not an {@link EmissionReceipt}, so the commit gate cannot
 * be satisfied by a value that merely describes a record never written.
 * @proof
 */
export type _EffectCarrier_PlainRecord_IsNotAnEmissionReceipt = Expect<
  IsNotAssignable<{ readonly event: EventType; readonly when: EmissionCondition }, EmissionReceipt>
>;

/**
 * **The unreachability proof.** `runEffect`'s recorder parameter is EXACTLY the
 * minted capability (or nothing at all — the inert case, for a plan that
 * declares no emissions and therefore has no record to be missing). Read with
 * the three negative proofs above, this is the chain: the only value that can
 * occupy that parameter is one {@link emissionRecorder} produced, and the
 * runtime gate then refuses a committed value until that capability has minted a
 * receipt per declared emission.
 *
 * Falsifier: widen the parameter back to a function type — {@link EmissionSink}
 * or anything else a lambda satisfies — and the two sides stop matching. That is
 * the regression this alias exists to catch, and it is the one a test could not:
 * a widened parameter changes no runtime behavior until someone exploits it.
 *
 * What it does NOT catch, stated so the guarantee is not read wider than it is:
 * re-introducing a DEFAULT built from this module's own constructor — a real
 * capability wrapping a sink that goes nowhere — leaves this alias `true`,
 * because such a default is well-typed by construction. Nothing at the type
 * level can tell that sink from a durable one. The runtime half covers it: the
 * behavior test asserts that an OMITTED recorder refuses to commit, which a
 * defaulted no-op would turn red.
 * @proof
 */
export type _EffectCarrier_CommittedValue_IsUnreachableWithoutTheCapability = Expect<
  MutuallyAssignable<Parameters<typeof runEffect>[3], EmissionRecorder | undefined>
>;

/**
 * The capability yields EVIDENCE, not `void`. This is the type-level half of the
 * commit gate: widen `record` back to a `void` return and the carrier would have
 * nothing to count, so the gate would degrade to "we called something" — which
 * is what a no-op passes.
 * @proof
 */
export type _EffectCarrier_Record_YieldsAMintedReceipt = Expect<
  MutuallyAssignable<Awaited<ReturnType<EmissionRecorder['record']>>, EmissionReceipt>
>;

/**
 * …and the negatives are not vacuous: the constructor really does mint the
 * capability, so the aliases above reject the unbranded case rather than
 * rejecting everything. Without this line, narrowing {@link EmissionRecorder} to
 * something nothing can produce would leave every proof here passing.
 * @proof
 */
export type _EffectCarrier_Constructor_MintsTheCapability = Expect<
  ReturnType<typeof emissionRecorder> extends EmissionRecorder ? true : false
>;
