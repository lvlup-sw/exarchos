/**
 * Capability resolver (T017, DR-14)
 *
 * Stub for runtime capability detection. Real runtime handshake wiring is a
 * follow-up task; this module provides only an in-memory lookup surface.
 *
 * Consumers should depend on the {@link CapabilityResolver} interface rather
 * than the concrete factory so that the resolver can be swapped for a real
 * handshake-based implementation later.
 */

export interface CapabilityResolver {
  has(capability: string): boolean;
  list(): readonly string[];
}

export function createInMemoryResolver(
  capabilities: Iterable<string>,
): CapabilityResolver {
  const set = new Set(capabilities);
  return {
    has(capability) {
      return set.has(capability);
    },
    list() {
      return [...set];
    },
  };
}

export const ANTHROPIC_NATIVE_CACHING = 'anthropic_native_caching' as const;
