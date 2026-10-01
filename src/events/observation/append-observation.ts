/**
 * Scoped observation of durable appends.
 *
 * Only the event store knows that an event became durable. A direct call to a
 * consumer makes the store import the code that judges it. This leaf module keeps
 * the dependency direction: the store notifies and never learns who listens.
 *
 * Outside a {@link runWithAppendObserver} scope, {@link notifyAppendObserved} is
 * one `undefined` check, so the append hot path pays nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What an observer learns about one append when persistence is confirmed. It
 * holds no payload, so it is not a second copy of the event. An observer that
 * needs the payload reads the stream.
 */
export interface AppendObservation {
  /** The persisted event's type. */
  readonly type: string;
  /** The stream the event landed on. */
  readonly streamId: string;
  /** The authoritative sequence the store assigned. */
  readonly sequence: number;
}

/** A callback invoked once per durably-persisted event. */
export type AppendObserver = (observation: AppendObservation) => void;

const appendObserverScope = new AsyncLocalStorage<AppendObserver>();

/**
 * Run `fn` with `observer` installed for its async subtree, and return what `fn` returns.
 *
 * Each async context has its own scope, so concurrent scopes see only their own
 * appends. A nested scope shadows the outer one. The continuations of an async
 * `fn` stay inside the scope.
 */
export function runWithAppendObserver<T>(observer: AppendObserver, fn: () => T): T {
  return appendObserverScope.run(observer, fn);
}

/**
 * Report one durably-persisted event to the observer of this async context, if any.
 *
 * Call it only after the durable result of the append exists, and only for an
 * event that landed. Never call it for a rejection or an idempotency collapse.
 *
 * A throwing observer is not caught, because a caught error lets a consumer
 * report success when it saw nothing.
 */
export function notifyAppendObserved(observation: AppendObservation): void {
  const observer = appendObserverScope.getStore();
  if (observer === undefined) return;
  observer(observation);
}
