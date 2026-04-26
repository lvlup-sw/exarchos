// ─── Capability-Declared Agent Spec Tests ──────────────────────────────────
//
// Verifies that agent specs declare runtime-agnostic `capabilities` instead
// of Claude-shaped `tools`. Runtime tool naming belongs in adapters, not in
// the domain registry. See docs/designs/2026-04-25-delegation-runtime-parity.md
// §3.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER, ALL_AGENT_SPECS } from './definitions.js';
import type { AgentSpec } from './types.js';

describe('AgentSpec capability declarations', () => {
  it('AgentSpec_DeclaresCapabilities_NotClaudeTools', () => {
    // IMPLEMENTER must declare capability vocabulary, not Claude tool names.
    expect(IMPLEMENTER.capabilities).toEqual(
      expect.arrayContaining([
        'fs:read',
        'fs:write',
        'shell:exec',
        'mcp:exarchos',
        'isolation:worktree',
      ]),
    );

    // No top-level Claude-shaped `tools` field on the domain spec.
    expect((IMPLEMENTER as unknown as Record<string, unknown>).tools).toBeUndefined();
  });

  it('AgentSpec_AllFourSpecs_DeclareCapabilities', () => {
    for (const spec of ALL_AGENT_SPECS) {
      expect(Array.isArray(spec.capabilities)).toBe(true);
      expect(spec.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('AgentSpec_FixerCapabilities', () => {
    expect(FIXER.capabilities).toEqual(
      expect.arrayContaining([
        'fs:read',
        'fs:write',
        'shell:exec',
        'mcp:exarchos',
      ]),
    );
  });

  it('AgentSpec_ReviewerCapabilities_ReadOnly', () => {
    expect(REVIEWER.capabilities).toEqual(
      expect.arrayContaining(['fs:read', 'mcp:exarchos']),
    );
    // Reviewer is read-only: must not declare write capability.
    expect(REVIEWER.capabilities).not.toContain('fs:write');
  });

  it('AgentSpec_ScaffolderCapabilities', () => {
    expect(SCAFFOLDER.capabilities).toEqual(
      expect.arrayContaining([
        'fs:read',
        'fs:write',
        'shell:exec',
        'mcp:exarchos',
      ]),
    );
  });

  it('AgentSpec_RejectsUnknownCapability_TypecheckFails', () => {
    // @ts-expect-error - 'bogus' is not a valid Capability
    const bad: AgentSpec = {
      id: 'implementer',
      description: 'x',
      systemPrompt: 'x',
      capabilities: ['bogus'],
      model: 'inherit',
      skills: [],
      validationRules: [],
      resumable: false,
    };
    expect(bad).toBeDefined();
  });
});
