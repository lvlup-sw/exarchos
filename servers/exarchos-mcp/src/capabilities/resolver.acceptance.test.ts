// ─── Acceptance test: AgentPosture spec → EffectiveCapabilities ────────────
//
// DR-6 acceptance criterion of #1259 (durable event-store substrate):
//   "capabilities/resolver.ts exposes resolvePosture(spec, runtime) returning
//    EffectiveCapabilities. Posture-to-capabilities mapping documented in
//    capabilities/posture-mapping.ts ... Resolver continues to merge yaml ⊕
//    handshake; handshake declarations override resolved capabilities."
//
// This is the bundle-level acceptance test for T29..T34/T59. It is RED until
// every other RED→GREEN pair lands. It deliberately does NOT exercise the
// override-priority case — that is T59's concern. Here we only assert union
// + posture-derived inclusion.

import { describe, it, expect } from 'vitest';
import { resolvePosture } from './resolver.js';
import type { Capability } from '../agents/capabilities.js';

describe('Capability_PostureSpec_ResolverDerivesEffectiveCapabilities (DR-6)', () => {
  it('derives effective capabilities from posture unioned with handshake declarations', () => {
    const spec = {
      id: 'implementer' as const,
      posture: 'task-isolated' as const,
    };
    const runtime = {
      capabilities: ['mcp:exarchos'] as readonly Capability[],
    };

    const effective = resolvePosture(spec, runtime);

    // Posture-derived caps from posture-mapping table for `task-isolated`.
    expect(effective.has('fs:read')).toBe(true);
    expect(effective.has('fs:write')).toBe(true);
    expect(effective.has('isolation:worktree')).toBe(true);

    // Handshake-declared cap is unioned in.
    expect(effective.has('mcp:exarchos')).toBe(true);
  });
});
