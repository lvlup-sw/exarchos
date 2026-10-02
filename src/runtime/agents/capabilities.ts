import { z } from 'zod';

export const Capability = z.enum([
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'subagent:completion-signal',
  'subagent:start-signal',
  'mcp:exarchos',
  'mcp:exarchos:readonly',
  'isolation:worktree',
  'team:agent-teams',
  'session:resume',
]);

export type Capability = z.infer<typeof Capability>;

/**
 * Replaces `add`, `delete` and `clear` with stubs that throw, then freezes the set. `Object.freeze` alone
 * does not stop a `Set` from changing, because its entries live in internal slots.
 */
function freezeCapabilityKeys(set: Set<Capability>): ReadonlySet<Capability> {
  const throwImmutable = (): never => {
    throw new TypeError('CAPABILITY_KEYS is immutable; mutation is forbidden');
  };
  Object.defineProperty(set, 'add', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'delete', { value: throwImmutable, writable: false, configurable: false });
  Object.defineProperty(set, 'clear', { value: throwImmutable, writable: false, configurable: false });
  return Object.freeze(set);
}

/** The full capability vocabulary, for callers that list or validate capabilities. It cannot change at runtime. */
export const CAPABILITY_KEYS: ReadonlySet<Capability> = freezeCapabilityKeys(
  new Set(Capability.options),
);
