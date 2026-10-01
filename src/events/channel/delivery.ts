/**
 * Observable delivery algebra.
 *
 * Post-append hooks and channel pushes are deliveries: attempts to hand a payload
 * to a transport that can fail. A failed `required` delivery must never be
 * swallowed. A `best-effort` failure becomes a typed `failed` outcome. A
 * `required` failure throws a {@link RequiredDeliveryError}.
 *
 * `tools/conformance/src/delivery-safety.ts` rejects empty `catch` blocks and
 * empty `.catch()` handlers on required delivery paths.
 */

/** Whether a delivery MUST succeed (`required`) or can fail quietly (`best-effort`). */
export type DeliveryRequirement = 'required' | 'best-effort';

/**
 * A delivery failure with its `channel`, its `requirement`, and the original
 * `cause`. A required delivery throws it. A best-effort delivery returns it in
 * the `failed` outcome.
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
 * The error thrown when a required delivery fails. It is a subclass, so a caller
 * can use `instanceof` to find the one failure that it must not ignore.
 */
export class RequiredDeliveryError extends DeliveryError {
  constructor(channel: string, cause: unknown) {
    super(channel, 'required', cause);
    this.name = 'RequiredDeliveryError';
  }
}

/**
 * The result of a delivery attempt.
 *   - `delivered`: the transport accepted the payload.
 *   - `skipped`: the caller did not attempt the delivery. It carries a `reason`.
 *   - `failed`: a best-effort transport threw. It carries the typed error.
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
 * - The transport succeeds: return `delivered`.
 * - A best-effort transport throws: return a `failed` outcome with a {@link DeliveryError}.
 * - A required transport throws: throw a {@link RequiredDeliveryError}.
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
