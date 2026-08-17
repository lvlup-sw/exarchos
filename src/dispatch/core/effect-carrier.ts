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
 * without ever invoking the `execute` thunk. A caller can therefore prove, by
 * construction, that a dry-run planned no observable side effect.
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
 * Run an effect through its typed owner and return a typed carrier.
 *
 * The dry-run guarantee is structural: when `mode.kind === 'dry-run'`, the
 * `execute` thunk is **never invoked** — the function returns the {@link
 * EffectPlan} directly. There is no code path in dry-run mode that reaches
 * `execute()`, so a dry-run provably performs no real effect. In `live` mode the
 * thunk runs; a thrown value is captured into an `error` carrier rather than
 * propagating, so `runEffect` never rejects for an effect failure.
 */
export async function runEffect<T>(
  mode: EffectMode,
  plan: EffectPlan,
  execute: () => Promise<T>,
): Promise<EffectOutcome<T>> {
  if (mode.kind === 'dry-run') {
    return plannedDryRun(plan);
  }
  try {
    return succeeded(await execute());
  } catch (cause) {
    return failed(toEffectError(plan, cause));
  }
}
