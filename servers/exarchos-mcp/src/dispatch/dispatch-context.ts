// ─── Dispatch-boundary Correlation Context (#1291) ──────────────────────────
//
// Three-field correlation primitive minted at the dispatch entry point.
// Replaces the prior single-field `operationId` (#1270) with the canonical
// observability triple:
//
//   operationId   — unique per dispatch boundary crossing (every `dispatch()`
//                    call mints a fresh one; idempotent retries reuse via
//                    the existing AppendOptions.idempotencyKey contract).
//   correlationId — chain-stable identifier that crosses dispatch boundaries
//                    unchanged. When dispatch receives an incoming
//                    `correlationId` (e.g. a HATEOAS next_actions follow-up
//                    from an upstream dispatch), it threads through. When
//                    nothing upstream sets it, the new context self-binds
//                    `correlationId === operationId` so every emitted
//                    event has a non-undefined correlation anchor.
//   causationId   — immediate cause: the upstream event id (or undefined
//                    for chain roots). Survives ONE hop; callers update
//                    it as they emit each follow-on event.
//
// This module is intentionally side-effect free and has no transitive deps
// beyond `node:crypto`. The wiring `DispatchContext` interface in
// `core/dispatch.ts` is a separate concern (a startup-time wiring container
// for storage / capability resolver / etc.); this module's value is the
// per-call correlation packet that gets carried forward through the
// AsyncLocalStorage stamping path inside `event-store/store.ts`.
//
// Threading strategy: rather than re-typing 98 `eventStore.append` callsites
// to take an explicit `DispatchContext` argument (a refactor that would
// crater the test suite for limited gain, and which is observably
// equivalent to the AsyncLocalStorage approach), dispatch wraps the handler
// invocation in `runWithDispatchContext()`. The event store reads the
// current context at append time and stamps the three IDs onto the event
// when the caller has not already supplied them. The result the outcome
// test pins: a multi-event dispatch produces events that all share the
// same `operationId`.

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

/** UUID-shaped string (v4). Branded against accidental string concatenation. */
export type UUID = string;

/**
 * Three-field correlation context minted at the dispatch boundary.
 *
 * INVARIANTS:
 *   - `operationId` is always a freshly-minted UUID per dispatch.
 *   - `correlationId` is either inherited from the incoming context
 *     verbatim, or self-bound to `operationId` when no upstream chain
 *     exists. Never undefined.
 *   - `causationId` is the immediate upstream event id, or undefined
 *     for chain roots.
 */
export interface DispatchContext {
  readonly operationId: UUID;
  readonly correlationId: UUID;
  readonly causationId?: UUID;
}

/**
 * Optional incoming correlation packet. Callers crossing a dispatch
 * boundary from a HATEOAS next_actions follow-up (or a CLI flag, or an
 * MCP request that carries a `_meta` correlation block) pass these so
 * the chain stays intact.
 */
export interface IncomingCorrelation {
  readonly correlationId?: UUID;
  readonly causationId?: UUID;
}

/**
 * Mint a dispatch context.
 *
 * @param incoming Optional upstream correlation. When present:
 *   - `correlationId` is inherited verbatim (chain continuity).
 *   - `causationId` is inherited verbatim (one-hop cause).
 *   When absent, the operation is the chain root: `correlationId` self-binds
 *   to `operationId`, and `causationId` is undefined.
 */
export function mintDispatchContext(
  incoming?: IncomingCorrelation,
): DispatchContext {
  const operationId = randomUUID();
  const correlationId = incoming?.correlationId ?? operationId;
  const ctx: DispatchContext = incoming?.causationId !== undefined
    ? { operationId, correlationId, causationId: incoming.causationId }
    : { operationId, correlationId };
  return ctx;
}

// ─── Async-context plumbing (T19) ───────────────────────────────────────────
//
// `runWithDispatchContext(ctx, fn)` runs `fn` inside an AsyncLocalStorage
// scope so any `eventStore.append(...)` call performed transitively during
// the dispatch can read the active context via `getDispatchContext()` and
// stamp the three correlation IDs onto the persisted event.
//
// This is the load-bearing primitive for the "every emit site threads
// correlation" requirement without requiring an explicit arg refactor at
// 98 callsites.

const dispatchContextStorage = new AsyncLocalStorage<DispatchContext>();

/**
 * Run `fn` with the given dispatch context active. Inside the callback,
 * `getDispatchContext()` returns `ctx`. Outside (or in concurrent
 * unrelated tasks) it returns `undefined`. Async continuations preserve
 * the context.
 */
export function runWithDispatchContext<T>(
  ctx: DispatchContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return dispatchContextStorage.run(ctx, fn);
}

/**
 * Read the active dispatch context. Returns `undefined` outside of any
 * `runWithDispatchContext` scope — callers (notably `EventStore.append`)
 * MUST treat undefined as "no active dispatch; do not stamp". A test that
 * appends an event without a dispatch wrapper continues to land
 * un-stamped events, preserving backward compatibility.
 */
export function getDispatchContext(): DispatchContext | undefined {
  return dispatchContextStorage.getStore();
}
