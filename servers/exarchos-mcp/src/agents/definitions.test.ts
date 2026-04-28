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
      expect.arrayContaining(['fs:read', 'mcp:exarchos:readonly']),
    );
    // Reviewer is read-only: must not declare write capability. The
    // mutating-MCP trust boundary is now capability-enforced via the
    // `mcp:exarchos:readonly` tier (T03/T04) rather than prompt-enforced.
    expect(REVIEWER.capabilities).not.toContain('fs:write');
  });

  it('REVIEWER_Capabilities_UsesReadonlyMCP', () => {
    // T11: REVIEWER migrates from `mcp:exarchos` to `mcp:exarchos:readonly`.
    // The dispatch-layer gate (T04) only fires when the readonly tier is
    // present AND the full tier is NOT — so we must drop `mcp:exarchos`.
    expect(REVIEWER.capabilities).toContain('mcp:exarchos:readonly');
    expect(REVIEWER.capabilities).not.toContain('mcp:exarchos');
  });

  it('REVIEWER_SystemPrompt_LacksForbiddenActionsBlock', () => {
    // T11: with the dispatch-layer gate enforcing the trust boundary
    // structurally, the prose-layer "Forbidden MCP Actions" block is
    // redundant and removed.
    expect(REVIEWER.systemPrompt).not.toContain('Forbidden MCP Actions');
    expect(REVIEWER.systemPrompt).not.toContain('You MUST NOT call any other MCP action');
    expect(REVIEWER.systemPrompt).not.toContain('exarchos_event append/batch_append');
  });

  it('REVIEWER_SystemPrompt_PreservesNonForbiddenSections', () => {
    // The deletion must be scoped — other systemPrompt sections survive.
    expect(REVIEWER.systemPrompt).toContain('## Review Scope');
    expect(REVIEWER.systemPrompt).toContain('## Design Requirements');
    expect(REVIEWER.systemPrompt).toContain('## Review Protocol');
    expect(REVIEWER.systemPrompt).toContain('## Completion Report');
    expect(REVIEWER.systemPrompt).toContain('{{reviewScope}}');
    expect(REVIEWER.systemPrompt).toContain('{{designRequirements}}');
    expect(REVIEWER.systemPrompt).toContain('READ-ONLY access');
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

  // Issue #1192 Item 4 (T26): every spec with a post-test validationRule must
  // anchor its command to the git toplevel. Bare `npm run test:run` would
  // execute against whatever shell cwd the agent has drifted to — anchoring
  // via $(git rev-parse --show-toplevel) ensures the worktree is what's tested.
  it('Hooks_PostTestCommand_IsGitToplevelAnchored', () => {
    const all = [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER];
    for (const spec of all) {
      const postTestRules = (spec.validationRules ?? []).filter(
        (r) => r.trigger === 'post-test' && typeof r.command === 'string',
      );
      for (const rule of postTestRules) {
        expect(rule.command, `${spec.id} post-test command must anchor to git toplevel`).toContain(
          '$(git rev-parse --show-toplevel)',
        );
      }
    }
  });
});
