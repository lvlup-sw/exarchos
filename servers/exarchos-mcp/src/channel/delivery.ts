/**
 * P04-01 — Observable delivery algebra.
 *
 * Post-append hooks and channel pushes are *deliveries*: an attempt to hand a
 * payload to a transport that can fail. The audit's exit criterion is that a
 * **required** delivery which fails cannot be silently swallowed. This module
 * makes the delivery contract explicit and typed so that is structurally true:
 *
 *   - Every delivery declares a {@link DeliveryRequirement} — `required` or
 *     `best-effort`. The requirement is a value, not a convention.
 *   - A `best-effort` failure is captured into a typed `failed` {@link
 *     DeliveryOutcome} carrier. The error becomes an inspectable value; it is
 *     NOT discarded by an empty `catch`.
 *   - A `required` failure THROWS a typed {@link RequiredDeliveryError} that
 *     propagates. There is no code path in {@link deliver} that returns a
 *     non-failed outcome for a required transport that threw, so a caller cannot
 *     accidentally treat a swallowed required failure as success.
 *
 * The static companion check {@link ../architecture/delivery-safety.js} rejects
 * the *syntactic* ways a required path could still swallow (empty `catch {}`,
 * empty `.catch(() => {})`), closing the loop on both the value and source
 * levels.
 */

/** Whether a delivery MUST succeed (`required`) or may fail quietly (`best-effort`). */
export type DeliveryRequirement = 'required' | 'best-effort';

/**
 * A structured delivery failure. Carries the `channel` it targeted, the
 * `requirement` under which it failed, and the original `cause`. Thrown for
 * required deliveries; carried in the `failed` outcome for best-effort ones.
 */
export class DeliveryError extends Error {
  readonly channel: string;
  readonly requirement: DeliveryRequirement;
  override readonly cause: unknown;

  constructor(
    channel: string,
    requirement: DeliveryRequirement,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`delivery to "${channel}" (${requirement}) failed: ${detail}`);
    this.name = 'DeliveryError';
    this.channel = channel;
    this.requirement = requirement;
    this.cause = cause;
  }
}

/**
 * The error thrown when a *required* delivery fails. A distinct subclass so a
 * caller can `instanceof`-narrow the one failure it is not allowed to ignore,
 * and so the type of {@link deliver} for a required requirement is "resolve to a
 * non-failing outcome, or reject with THIS".
 */
export class RequiredDeliveryError extends DeliveryError {
  constructor(channel: string, cause: unknown) {
    super(channel, 'required', cause);
    this.name = 'RequiredDeliveryError';
  }
}

/**
 * The result of a delivery attempt.
 *   - `delivered` — the transport accepted the payload.
 *   - `skipped`   — the delivery was intentionally not attempted (e.g. a
 *                   below-threshold notification); carries a `reason`.
 *   - `failed`    — a best-effort transport threw; carries the typed error so
 *                   the failure is observable rather than swallowed. (A required
 *                   failure never produces this arm — it throws instead.)
 */
export type DeliveryOutcome =
  | { readonly kind: 'delivered'; readonly channel: string }
  | { readonly kind: 'skipped'; readonly channel: string; readonly reason: string }
  | { readonly kind: 'failed'; readonly error: DeliveryError };

/** A transport that hands `payload` to a sink and rejects on failure. */
export type DeliveryTransport<P> = (payload: P) => Promise<void>;

/** Inputs to a single {@link deliver} attempt. */
export interface DeliveryRequest<P> {
  readonly channel: string;
  readonly requirement: DeliveryRequirement;
  readonly payload: P;
  readonly transport: DeliveryTransport<P>;
}

/** Construct a `delivered` outcome. */
export function delivered(channel: string): DeliveryOutcome {
  return { kind: 'delivered', channel };
}

/** Construct a `skipped` outcome with the reason it was not attempted. */
export function skipped(channel: string, reason: string): DeliveryOutcome {
  return { kind: 'skipped', channel, reason };
}

/** Narrow to the `failed` arm. */
export function isFailedDelivery(
  outcome: DeliveryOutcome,
): outcome is { readonly kind: 'failed'; readonly error: DeliveryError } {
  return outcome.kind === 'failed';
}

/**
 * Attempt a delivery under its declared requirement.
 *
 * - The transport succeeds → `delivered`.
 * - The transport throws and `requirement === 'best-effort'` → a `failed`
 *   carrier holding a {@link DeliveryError}. The error is returned, never
 *   discarded — the caller decides whether to log, retry, or ignore it, but it
 *   cannot be lost to an empty catch.
 * - The transport throws and `requirement === 'required'` → a {@link
 *   RequiredDeliveryError} is thrown and propagates to the caller. There is no
 *   branch that turns a required throw into a `delivered`/`skipped` outcome, so
 *   a required failure is structurally impossible to swallow inside this
 *   function.
 */
export async function deliver<P>(
  request: DeliveryRequest<P>,
): Promise<DeliveryOutcome> {
  try {
    await request.transport(request.payload);
    return delivered(request.channel);
  } catch (cause) {
    if (request.requirement === 'required') {
      throw new RequiredDeliveryError(request.channel, cause);
    }
    return { kind: 'failed', error: new DeliveryError(request.channel, 'best-effort', cause) };
  }
}
