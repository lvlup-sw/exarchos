/**
 * Contract tests for the Copilot `RuntimeAdapter`. The adapter emits Markdown with YAML frontmatter at `.github/agents/<name>.agent.md`.
 * The Copilot CLI format declares `tools` as an array of names, and its loader reads only the `.agent.md` extension.
 * Format reference:
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { AgentSpec } from '../../../../../src/runtime/agents/types.js';
import type { Capability } from '../../../../../src/runtime/agents/capabilities.js';
import { CopilotAdapter } from '../../../../../src/runtime/agents/adapters/copilot.js';
import * as PostureMapping from '../../../../../src/workflow/capabilities/posture-mapping.js';

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

/**
 * Minimal `AgentSpec` fixture for the implementer. The fixture has no `capabilities` field.
 * `resolveCapabilities` derives the capabilities from `posture` and `id`.
 */
const IMPLEMENTER_FIXTURE: AgentSpec = {
  id: 'implementer',
  description: 'TDD implementer agent',
  systemPrompt: 'You are a TDD implementer.\n\nFollow Red-Green-Refactor.',
  posture: 'task-isolated',
  model: 'inherit',
  isolation: 'worktree',
  skills: [],
  validationRules: [],
  resumable: true,
  memoryScope: 'project',
  mcpServers: ['exarchos'],
};

/**
 * Make `resolveCapabilities` return a specific capability set until `afterEach` restores the mocks.
 * Tests use it for a capability mix that no posture gives, such as a mix with an unsupported capability.
 */
function forceCapabilities(caps: readonly Capability[]): void {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>(caps)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CopilotAdapter', () => {
  const adapter = new CopilotAdapter();

  it('CopilotAdapter_RuntimeIdentifier_IsCopilot', () => {
    expect(adapter.runtime).toBe('copilot');
  });

  /** The path is at project scope, so the repo versions the agent definitions. */
  it('CopilotAdapter_AgentFilePath_ReturnsCopilotAgentsPath', () => {
    expect(adapter.agentFilePath('implementer')).toBe('.github/agents/implementer.agent.md');
  });

  /** The Copilot loader reads only the `.agent.md` extension, not plain `.md`. */
  it('CopilotAdapter_AgentFilePath_HasAgentMdExtension', () => {
    for (const name of ['implementer', 'fixer', 'reviewer', 'scaffolder']) {
      expect(adapter.agentFilePath(name).endsWith('.agent.md')).toBe(true);
    }
  });

  /**
   * `tools` must be an array of names, not the boolean map of the OpenCode format.
   * The capabilities of the implementer include `fs:read`, `fs:write` and `shell:exec`, which map to `read`, `write` and `shell`.
   */
  it('CopilotAdapter_LowerImplementer_EmitsToolsArray', () => {
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { data } = parseFrontmatter(contents);

    expect(Array.isArray(data.tools)).toBe(true);
    const tools = data.tools as unknown[];
    for (const entry of tools) {
      expect(typeof entry).not.toBe('boolean');
    }
    expect(tools).toContain('read');
    expect(tools).toContain('write');
    expect(tools).toContain('shell');
  });

  /**
   * The Copilot CLI registers MCP servers outside the agent file, and its loader ignores an MCP block in the frontmatter.
   * Thus the `mcp__exarchos` tool entry is the only gate for the server.
   */
  it('CopilotAdapter_LowerImplementer_OmitsMcpFrontmatterBlock', () => {
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { data } = parseFrontmatter(contents);

    expect(data).not.toHaveProperty('mcp');
    expect(data).not.toHaveProperty('mcp-servers');
    expect(data.tools).toContain('mcp__exarchos');
  });

  /**
   * The readonly tier must lower to the same `mcp__exarchos` tool entry as `mcp:exarchos`.
   * The dispatch layer limits the tier per action.
   */
  it('CopilotAdapter_LowerSpec_Readonly_GrantsExarchosTool', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { data } = parseFrontmatter(contents);

    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools).toContain('mcp__exarchos');
  });

  it('CopilotAdapter_ValidateSupport_RejectsClaudeOnlyHooks', () => {
    forceCapabilities([
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
      'session:resume',
      'subagent:start-signal',
    ]);
    const result = adapter.validateSupport(IMPLEMENTER_FIXTURE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:start-signal/);
      expect(result.fixHint.length).toBeGreaterThan(0);
    }

    forceCapabilities([
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
      'session:resume',
      'team:agent-teams',
    ]);
    const teamsResult = adapter.validateSupport(IMPLEMENTER_FIXTURE);
    expect(teamsResult.ok).toBe(false);
  });

  /** The Markdown body is the system prompt of the spec. */
  it('CopilotAdapter_LowerSpec_BodyContainsSpecDescription', () => {
    const { contents } = adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    const { body } = parseFrontmatter(contents);
    expect(body).toContain('TDD implementer');
    expect(body).toContain('Red-Green-Refactor');
  });

  it('CopilotAdapter_RenderAgentSpec_CallsResolveCapabilitiesNotSpecField', () => {
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities');
    adapter.lowerSpec(IMPLEMENTER_FIXTURE);
    expect(spy).toHaveBeenCalled();
    const calledWithSpecPair = spy.mock.calls.some(
      (args) =>
        args[0] === IMPLEMENTER_FIXTURE.posture && args[1] === IMPLEMENTER_FIXTURE.id,
    );
    expect(calledWithSpecPair).toBe(true);
  });
});
