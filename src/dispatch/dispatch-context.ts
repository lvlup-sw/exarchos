/**
 * The per-call correlation context that the dispatch entry point mints:
 * - `operationId`: a new UUID for each `dispatch()` call.
 * - `correlationId`: stable across dispatch boundaries. It comes from upstream, or else it equals
 *   `operationId`.
 * - `causationId`: the upstream event id for one hop, or undefined for a chain root.
 * Dispatch runs the handler inside `runWithDispatchContext()`. At append time the event store reads
 * the active context and stamps the ids that the caller did not supply. Thus the events of one
 * dispatch share one `operationId` with no explicit context argument at each append call.
 * The wiring `DispatchContext` in `dispatch/core/dispatch.ts` is a different type.
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallerAuthorizationSnapshot } from './caller-identity.js';

/** A UUID-shaped string (v4). */
export type UUID = string;

/** The correlation context for one dispatch. `correlationId` is never undefined. */
export interface DispatchContext {
  readonly operationId: UUID;
  readonly correlationId: UUID;
  readonly causationId?: UUID;
  readonly authorization?: CallerAuthorizationSnapshot;
}

/** The upstream correlation that a caller passes across a dispatch boundary to keep the chain. */
export interface IncomingCorrelation {
  readonly correlationId?: UUID;
  readonly causationId?: UUID;
}

/**
 * Mints a dispatch context.
 *
 * @param incoming The upstream correlation. Its ids are copied unchanged. When it is absent, the
 *   operation is a chain root: `correlationId` equals `operationId`, and `causationId` is undefined.
 */
export function mintDispatchContext(
  incoming?: IncomingCorrelation,
  authorization?: CallerAuthorizationSnapshot,
): DispatchContext {
  const operationId = randomUUID();
  const correlationId = incoming?.correlationId ?? operationId;
  const ctx: DispatchContext = {
    operationId,
    correlationId,
    ...(incoming?.causationId !== undefined
      ? { causationId: incoming.causationId }
      : {}),
    ...(authorization !== undefined ? { authorization } : {}),
  };
  return ctx;
}

/**
 * Mints a context from an untrusted action request. It takes only the correlation ids from `_meta`.
 * The caller authorization comes only from the separate `authorization` snapshot.
 */
export function mintDispatchContextFromRequest(
  request: Readonly<Record<string, unknown>>,
  authorization?: CallerAuthorizationSnapshot,
): DispatchContext {
  const meta = request._meta;
  let correlationId: string | undefined;
  let causationId: string | undefined;
  if (typeof meta === 'object' && meta !== null) {
    const record = meta as Readonly<Record<string, unknown>>;
    if (typeof record.correlationId === 'string') {
      correlationId = record.correlationId;
    }
    if (typeof record.causationId === 'string') {
      causationId = record.causationId;
    }
  }
  const incoming: IncomingCorrelation = {
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(causationId !== undefined ? { causationId } : {}),
  };
  return mintDispatchContext(incoming, authorization);
}

const dispatchContextStorage = new AsyncLocalStorage<DispatchContext>();

/**
 * Runs `fn` with the dispatch context active. Inside `fn` and its async continuations,
 * `getDispatchContext()` returns `ctx`. Outside, it returns `undefined`.
 */
export function runWithDispatchContext<T>(
  ctx: DispatchContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return dispatchContextStorage.run(ctx, fn);
}

/**
 * Reads the active dispatch context, or `undefined` outside a `runWithDispatchContext` scope.
 * A caller such as `EventStore.append` must not stamp ids when the result is undefined.
 */
export function getDispatchContext(): DispatchContext | undefined {
  return dispatchContextStorage.getStore();
}
