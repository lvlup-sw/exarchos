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

/**
 * The port a declared emission is appended through.
 *
 * A plain function taking the emission and the plan that declared it. Where the
 * fact actually lands is the caller's business, not this module's.
 *
 * An appender failure is NOT an effect failure: it propagates rather than being
 * captured into the `error` arm. Recording the intent is the precondition for
 * running the effect at all, so an owner that cannot write the ledger must not
 * proceed as though it had.
 */
export type EmissionAppender = (
  emission: EffectEmission,
  plan: EffectPlan,
) => void | Promise<void>;

/** The default appender: records nothing, so an undeclared plan is inert. */
const NO_EMISSION: EmissionAppender = () => undefined;

/** Append every emission a plan declares for one condition, in order. */
async function appendEmissions(
  plan: EffectPlan,
  when: EmissionCondition,
  append: EmissionAppender,
): Promise<void> {
  for (const emission of emissionsWhen(plan, when)) {
    await append(emission, plan);
  }
}

/**
 * Run an effect through its typed owner and return a typed carrier.
 *
 * The dry-run guarantee is structural: when `mode.kind === 'dry-run'`, the
 * `execute` thunk is **never invoked** and `append` is **never called** — the
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
 * the `try`, so a terminal append cannot be mistaken for the effect failing.
 *
 * A plan declaring no emissions, or a caller passing no appender, appends
 * nothing and leaves the three-arm carrier exactly as it is.
 */
export async function runEffect<T>(
  mode: EffectMode,
  plan: EffectPlan,
  execute: () => Promise<T>,
  append: EmissionAppender = NO_EMISSION,
): Promise<EffectOutcome<T>> {
  if (mode.kind === 'dry-run') {
    return plannedDryRun(plan);
  }
  await appendEmissions(plan, 'before', append);

  let outcome: EffectOutcome<T>;
  let terminal: EmissionCondition;
  try {
    outcome = succeeded(await execute());
    terminal = 'on-success';
  } catch (cause) {
    outcome = failed(toEffectError(plan, cause));
    terminal = 'on-failure';
  }

  await appendEmissions(plan, terminal, append);
  return outcome;
}
