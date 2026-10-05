/**
 * Handlers for MCP client notifications that change server state. Each
 * notification gets its own named function, which the transport adapter registers.
 * There is no generic dispatcher object, so a search finds each handler.
 */

import type { CapabilityResolver } from '../workflow/capabilities/resolver.js';

/**
 * Handles `notifications/roots/list_changed` from the MCP client. The
 * {@link CapabilityResolver} caches the roots after the first `roots/list` call.
 * This handler drops that cache, so the next discovery call gets the new list. On
 * an empty cache it does nothing.
 */
export function handleRootsListChanged(resolver: CapabilityResolver): void {
  resolver.invalidateRootsCache();
}
