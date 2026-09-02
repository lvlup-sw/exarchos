/**
 * Scoped observation of durable appends.
 *
 * The event store is the only place that knows an event became durable. Any
 * consumer that wants to reason about what a unit of work actually emitted
 * needs that fact, and the obvious way to get it — have the store call the
 * consumer — inverts the layering: the event store would import the thing
 * that judges it.
 *
 * This module is the seam that keeps the arrow pointing the other way. It is
 * a leaf: it imports nothing but `node:async_hooks`, and the observer is a
 * plain callback over three primitive fields. The store notifies; it never
 * learns who is listening or why.
 *
 * Absent by default. Outside any {@link runWithAppendObserver} scope
 * {@link notifyAppendObserved} is a single `undefined` check, so the append
 * hot path pays nothing for a facility nobody installed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What an observer learns about one append: the fields already resolved at
 * the moment persistence is confirmed. Deliberately narrow — an observer that
 * needs the payload should read the stream, so this seam cannot become a
 * second copy of the event.
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
 * Run `fn` with `observer` installed for the duration of its async subtree.
 *
 * Isolation is per async context, so two scopes running concurrently each see
 * only their own appends — a property the store cannot provide with a module
 * -level variable. A nested scope shadows the outer one for its own subtree.
 *
 * Returns whatever `fn` returns, so an async `fn` can be awaited by the
 * caller; continuations of that promise stay inside the scope.
 */
export function runWithAppendObserver<T>(observer: AppendObserver, fn: () => T): T {
  return appendObserverScope.run(observer, fn);
}

/**
 * Report one durably-persisted event to the observer active in this async
 * context, if any.
 *
 * Callers must invoke this ONLY after the append's durable result exists, and
 * only for an event that genuinely landed — never for a validation or store
 * rejection, and never for an idempotency collapse that persisted nothing.
 *
 * A throwing observer is not caught. Swallowing it would turn every consumer
 * built on this seam into one that reports success when it saw nothing, which
 * is the failure mode the seam exists to rule out.
 */
export function notifyAppendObserved(observation: AppendObservation): void {
  const observer = appendObserverScope.getStore();
  if (observer === undefined) return;
  observer(observation);
}
