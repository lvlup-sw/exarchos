/**
 * Public primitive surface of the event-store layer: the appender, its typed
 * errors, the store, and the subscription registry.
 *
 * The `decide`, `withSession`, and `aggregateStream` primitives are methods on
 * {@link AtomicAppender}. Get the appender from `EventStore.getAppender()`.
 * Every name here is also exported by its own module.
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
