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
 * Canonical source for tests and adapters that need to enumerate or validate
 * against the full capability vocabulary. Mutators are replaced with
 * throwing stubs so runtime widening of the trust boundary is impossible —
 * `Object.freeze(set)` alone is insufficient because Set internal slots
 * ignore the frozen flag and `.add()` still mutates.
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

export const CAPABILITY_KEYS: ReadonlySet<Capability> = freezeCapabilityKeys(
  new Set(Capability.options),
);
