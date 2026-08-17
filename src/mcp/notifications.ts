// ─── #1290 — MCP notification handlers ───────────────────────────────────────
//
// Minimal wiring layer for client-emitted notifications that affect
// server-side state. Today the surface is single-purpose
// (`notifications/roots/list_changed` invalidates the resolver's roots
// cache so the next `resolveWorkspace` call refetches). New
// notifications should be added here as discrete handler functions
// so the transport adapter can register them by name; we deliberately
// avoid a generic dispatcher object to keep the contract grep-able.

import type { CapabilityResolver } from '../workflow/capabilities/resolver.js';

/**
 * Handle a `notifications/roots/list_changed` event from the MCP client.
 *
 * The roots set is cached on the {@link CapabilityResolver} after the
 * first `roots/list` round-trip (see `workspace/discovery.ts`). When
 * the client mutates its root set (workspace add/remove in the IDE, for
 * example), it emits `notifications/roots/list_changed`; calling this
 * function from the transport adapter drops the cache so the next
 * discovery call sees the fresh list.
 *
 * Idempotent: invoking it on a cold cache is a no-op. Safe to call
 * unconditionally from the transport layer's notification dispatcher.
 */
export function handleRootsListChanged(resolver: CapabilityResolver): void {
  resolver.invalidateRootsCache();
}
