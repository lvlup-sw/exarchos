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
 * against the full capability vocabulary. Frozen to prevent runtime mutation.
 */
export const CAPABILITY_KEYS: ReadonlySet<Capability> = Object.freeze(
  new Set(Capability.options),
);
