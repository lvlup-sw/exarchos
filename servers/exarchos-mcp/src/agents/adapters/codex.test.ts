// ─── Codex RuntimeAdapter contract tests ───────────────────────────────────
//
// Codex consumes custom-agent definitions from `.codex/agents/<name>.toml`.
// Required fields: `name`, `description`, `developer_instructions`. The
// adapter also exposes a `customAgentResolutionWorks` flag — Codex upstream
// issues #15250/#14579 mean named-agent dispatch from tool sessions is
// unreliable, so the flag is `false` by default until upstream lands a fix.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4 and
// docs/research/2026-04-25-delegation-platform-agnosticity.md §3.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import { codexAdapter, tomlBasicString } from './codex.js';

const baseSpec: AgentSpec = {
  id: 'implementer',
  description: 'TDD implementer that writes failing tests then code.',
  systemPrompt: 'You are a TDD implementer agent. Follow Red-Green-Refactor.',
  capabilities: [
    'fs:read',
    'fs:write',
    'shell:exec',
    'mcp:exarchos',
    'isolation:worktree',
  ] as readonly Capability[],
  model: 'inherit',
  skills: [],
  validationRules: [],
  resumable: false,
};

describe('CodexAdapter', () => {
  it('CodexAdapter_RuntimeIdentifier_IsCodex', () => {
    expect(codexAdapter.runtime).toBe('codex');
  });

  it('CodexAdapter_AgentFilePath_ReturnsCodexAgentsPath', () => {
    expect(codexAdapter.agentFilePath('implementer')).toBe(
      '.codex/agents/implementer.toml',
    );
  });

  it('CodexAdapter_LowerImplementer_EmitsValidTOML', () => {
    const { path, contents } = codexAdapter.lowerSpec(baseSpec);

    expect(path).toBe('.codex/agents/implementer.toml');

    // Top-level keys present (TOML `key = "..."` format at line starts).
    expect(contents).toMatch(/^name\s*=\s*"implementer"\s*$/m);
    expect(contents).toMatch(/^description\s*=\s*".+"\s*$/m);
    expect(contents).toMatch(/^developer_instructions\s*=\s*"""/m);
  });

  it('CodexAdapter_DeveloperInstructions_IncludesSpecBodyAndCapabilityDescriptions', () => {
    const { contents } = codexAdapter.lowerSpec(baseSpec);

    // Spec body (systemPrompt) appears verbatim in developer_instructions.
    expect(contents).toContain('Red-Green-Refactor');
    // Capabilities are enumerated in the rendered instructions.
    expect(contents).toContain('fs:read');
    expect(contents).toContain('fs:write');
    expect(contents).toContain('shell:exec');
    expect(contents).toContain('mcp:exarchos');
    expect(contents).toContain('isolation:worktree');
  });

  it('CodexAdapter_ValidateSupport_RejectsClaudeOnlyCapabilities', () => {
    const teamsSpec: AgentSpec = {
      ...baseSpec,
      capabilities: ['fs:read', 'team:agent-teams'] as readonly Capability[],
    };

    const result = codexAdapter.validateSupport(teamsSpec);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('team:agent-teams');
      expect(result.fixHint.length).toBeGreaterThan(0);
    }
  });

  it('CodexAdapter_FallbackFlag_DefaultsToFalse', () => {
    expect(codexAdapter.customAgentResolutionWorks).toBe(false);
  });
});

describe('tomlBasicString', () => {
  it('TomlBasicString_EscapesBackspace', () => {
    expect(tomlBasicString('a\bb')).toBe('"a\\bb"');
  });

  it('TomlBasicString_EscapesFormfeed', () => {
    expect(tomlBasicString('a\fb')).toBe('"a\\fb"');
  });

  it('TomlBasicString_EscapesAllControlChars_InOrder', () => {
    // Asserts no double-escaping bugs and stable order with a cocktail input.
    const input = 'q"\\\b\f\n\r\tx';
    const got = tomlBasicString(input);
    expect(got).toBe('"q\\"\\\\\\b\\f\\n\\r\\tx"');
  });
});
