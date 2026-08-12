/**
 * Public R-2 primitive surface for the event-store layer (Wave 3, #1314).
 *
 * Wave 4 consumers (`merge-orchestrate.ts`, `execute-merge.ts`, etc.)
 * import the new typed errors + class via this barrel. The `decide`,
 * `withSession`, and `aggregateStream` primitives are methods on
 * {@link AtomicAppender} — Wave 4 obtains the appender via the same
 * `EventStore.getAppender()` accessor production code uses today.
 *
 * This barrel exists per the Wave-3 task prompt requirement to give
 * Wave 4 a single canonical import site for the new types. It is
 * intentionally minimal — every name re-exported here is exported by
 * its own module too, so there is no circular-dependency hazard.
 */

export {
  AtomicAppender,
  type AppendOptions,
  type AppendResult,
  type DecideContext,
  type DecideOptions,
  type DecideResult,
  type EventInput,
  type PublicPersistedEvent,
  type Session,
  type WithSessionOptions,
} from './atomic-appender.js';

export { ConcurrencyError } from './concurrency-error.js';
export type { ConcurrencyErrorOptions } from './concurrency-error.js';

export { StorageBusyError } from './storage-busy-error.js';
export type { StorageBusyErrorOptions } from './storage-busy-error.js';

export {
  InvalidSessionOptionsError,
  SessionClosedError,
} from './session-errors.js';
export type { InvalidSessionOptionsSuggestedFix } from './session-errors.js';

export { EventStore } from './store.js';

export {
  SubscriptionRegistry,
  DEFAULT_FLOOR_MS,
  type SubscribeOptions,
  type SubscriptionClock,
  type SubscriptionEventReader,
  type SubscriptionFilter,
  type SubscriptionHandle,
  type SubscriptionListener,
  type SubscriptionPerf,
  type SubscriptionRegistryOptions,
} from './subscriptions.js';
