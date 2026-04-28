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

import type { Capability } from '../agents/capabilities.js';

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

/**
 * Capabilities in the `mcp:exarchos` family. The resolver treats this family
 * as a tiered set: a single tier wins (handshake authoritative) rather than
 * being unioned, so an agent never simultaneously holds the full and readonly
 * tiers.
 */
const MCP_EXARCHOS_FAMILY: ReadonlySet<Capability> = new Set<Capability>([
  'mcp:exarchos',
  'mcp:exarchos:readonly',
]);

function isMcpExarchosFamily(cap: Capability): boolean {
  return MCP_EXARCHOS_FAMILY.has(cap);
}

/**
 * Per ADR ontological-data-fabric §2.8: capability resolution is
 * handshake-authoritative. For the `mcp:exarchos` family, the handshake
 * tier wins over yaml even when narrower. This prevents runtime widening
 * of trust boundaries via stale yaml defaults — if the handshake declares
 * `mcp:exarchos:readonly` while yaml declares `mcp:exarchos` (full), the
 * effective record is `mcp:exarchos:readonly`. Conversely, if the handshake
 * declares the full tier while yaml is narrower, the handshake still wins
 * (the runtime is the source of truth for what is actually mounted).
 *
 * Other capability families (fs:read, fs:write, shell:exec, isolation:*,
 * etc.) merge by union — handshake additions widen the set; yaml-declared
 * caps are preserved.
 *
 * The returned set is frozen to prevent downstream mutation of the trust
 * boundary after resolution.
 */
export function resolveEffectiveCapabilities(
  yamlCaps: readonly Capability[],
  handshakeCaps: readonly Capability[],
): ReadonlySet<Capability> {
  const effective = new Set<Capability>();

  // Non-mcp:exarchos: union (handshake additions widen).
  for (const c of yamlCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }
  for (const c of handshakeCaps) {
    if (!isMcpExarchosFamily(c)) effective.add(c);
  }

  // mcp:exarchos family: handshake authoritative — pick the handshake's
  // declared tier if present; otherwise fall back to yaml's declared tier.
  const handshakeMcp = handshakeCaps.find(isMcpExarchosFamily);
  if (handshakeMcp !== undefined) {
    effective.add(handshakeMcp);
  } else {
    const yamlMcp = yamlCaps.find(isMcpExarchosFamily);
    if (yamlMcp !== undefined) effective.add(yamlMcp);
  }

  return freezeSet(effective);
}

/**
 * Return a frozen Set whose mutators throw. `Object.freeze(set)` alone is
 * insufficient because Set's internal slots ignore the frozen flag — `.add`
 * still mutates. We replace mutators with throwing stubs and freeze the
 * object identity so downstream code cannot widen the trust boundary after
 * resolution.
 */
function freezeSet<T>(set: Set<T>): ReadonlySet<T> {
  const throwImmutable = (): never => {
    throw new TypeError(
      'resolveEffectiveCapabilities returned an immutable set; mutation is forbidden',
    );
  };
  Object.defineProperty(set, 'add', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'delete', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'clear', { value: throwImmutable, writable: false, configurable: false });
  return Object.freeze(set);
}
