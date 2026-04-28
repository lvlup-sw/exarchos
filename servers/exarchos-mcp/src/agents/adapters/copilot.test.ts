// ─── Copilot RuntimeAdapter contract tests ─────────────────────────────────
//
// Verifies the Copilot adapter emits a Markdown file with YAML frontmatter
// at `.github/agents/<name>.agent.md` (project-scope). The Copilot CLI
// custom-agent format uses a `tools:` ARRAY (not OpenCode's boolean map)
// and the literal `.agent.md` extension (distinct from plain `.md`).
//
// References:
//   - docs/designs/2026-04-25-delegation-runtime-parity.md §4
//   - docs/research/2026-04-25-delegation-platform-agnosticity.md §3 (Copilot row)
//   - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import { CopilotAdapter } from './copilot.js';

/** Split a Markdown-with-frontmatter document into `{ data, body }`. */
function parseFrontmatter(contents: string): { data: Record<string, unknown>; body: string } {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) {
    throw new Error('No YAML frontmatter delimiters found');
  }
  const data = parseYaml(match[1]) as Record<string, unknown>;
  const body = match[2] ?? '';
  return { data, body };
}

/** Minimal `AgentSpec` fixture for the canonical implementer. */
const IMPLEMENTER_FIXTURE: AgentSpec = {
  id: 'implementer',
  description: 'TDD implementer agent',
  systemPrompt: 'You are a TDD implementer.\n\nFollow Red-Green-Refactor.',
  capabilities: [
    'fs:read',
    'fs:write',
    'shell:exec',
    'mcp:exarchos',
    'isolation:worktree',
    'session:resume',
  ],
  model: 'inherit',
  isolation: 'worktree',
  skills: [],
  validationRules: [],
  resumable: true,
  memoryScope: 'project',
  mcpServers: ['exarchos'],
};

describe('CopilotAdapter', () => {
  const adapter = new CopilotAdapter();

  it('CopilotAdapter_RuntimeIdentifier_IsCopilot', () => {
    expect(adapter.runtime).toBe('copilot');
  });

  it('CopilotAdapter_AgentFilePath_ReturnsCopilotAgentsPath', () => {
    // Project-scope default: `.github/agents/<name>.agent.md`. User-scope
    // (`~/.copilot/agents/`) is also valid per Copilot CLI docs, but project
    // scope makes the agent definitions versioned with the repo, which is
    // what Exarchos's plugin-distribution model requires.
    expect(adapter.agentFilePath('implementer')).toBe('.github/agents/implementer.agent.md');
  });

  it('CopilotAdapter_AgentFilePath_HasAgentMdExtension', () => {
    // Copilot CLI requires the literal `.agent.md` extension; plain `.md`
    // is not picked up by the custom-agent loader.
    for (const name of ['implementer', 'fixer', 'reviewer', 'scaffolder']) {
      expect(adapter.agentFilePath(name).endsWith('.agent.md')).toBe(true);
    }
  });

  it('CopilotAdapter_LowerImplementer_EmitsToolsArray', () => {
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { data } = parseFrontmatter(contents);

    expect(Array.isArray(data.tools)).toBe(true);
    // Specifically NOT a boolean map (that would be the OpenCode shape).
    // Distinguish array from plain record: arrays are also typeof 'object',
    // so guard on Array.isArray, then assert no entry is a boolean.
    const tools = data.tools as unknown[];
    for (const entry of tools) {
      expect(typeof entry).not.toBe('boolean');
    }
    // Copilot tool names — derived from the capability→copilot binding
    // documented at the top of `copilot.ts`. Implementer requires fs:read,
    // fs:write, shell:exec → `read`, `write`, `shell`.
    expect(tools).toContain('read');
    expect(tools).toContain('write');
    expect(tools).toContain('shell');
  });

  it('CopilotAdapter_LowerImplementer_OmitsMcpFrontmatterBlock', () => {
    // The Copilot CLI loader does not honor an `mcp:` (or `mcp-servers:`)
    // block in custom-agent frontmatter when shaped as `{ enabled: true }`
    // — MCP servers are registered out-of-band (`gh mcp add` / shared
    // `mcp.json`) and per-agent gating is the `mcp__<server>` tool entry.
    // Locks the regression fix; previously the adapter emitted a spurious
    // `mcp: { exarchos: { enabled: true } }` block that was silently ignored.
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { data } = parseFrontmatter(contents);

    expect(data).not.toHaveProperty('mcp');
    expect(data).not.toHaveProperty('mcp-servers');
    // The `mcp__exarchos` tool entry remains the sole gating mechanism.
    expect(data.tools).toContain('mcp__exarchos');
  });

  it('CopilotAdapter_ValidateSupport_RejectsClaudeOnlyHooks', () => {
    const specWithStartHook: AgentSpec = {
      ...IMPLEMENTER_FIXTURE,
      capabilities: [...IMPLEMENTER_FIXTURE.capabilities, 'subagent:start-signal'],
    };
    const result = adapter.validateSupport(specWithStartHook);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:start-signal/);
      expect(result.fixHint.length).toBeGreaterThan(0);
    }

    const specWithTeams: AgentSpec = {
      ...IMPLEMENTER_FIXTURE,
      capabilities: [...IMPLEMENTER_FIXTURE.capabilities, 'team:agent-teams'],
    };
    const teamsResult = adapter.validateSupport(specWithTeams);
    expect(teamsResult.ok).toBe(false);
  });

  it('CopilotAdapter_LowerSpec_BodyContainsSpecDescription', () => {
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { body } = parseFrontmatter(contents);
    // The full system prompt should be the Markdown body so the Copilot
    // custom-agent runtime sees the same instructions as Claude/Codex.
    expect(body).toContain('TDD implementer');
    expect(body).toContain('Red-Green-Refactor');
  });
});
