/**
 * Contract tests for the OpenCode `RuntimeAdapter`. OpenCode agents are Markdown with YAML frontmatter at `.opencode/agents/<name>.md`.
 * Unlike the Claude format, `tools` is a boolean map, and `mode: subagent` declares the agent kind.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { IMPLEMENTER, REVIEWER } from '../../../../../src/runtime/agents/definitions.js';
import type { Capability } from '../../../../../src/runtime/agents/capabilities.js';
import { OpenCodeAdapter } from '../../../../../src/runtime/agents/adapters/opencode.js';
import * as PostureMapping from '../../../../../src/workflow/capabilities/posture-mapping.js';

function forceCapabilities(caps: readonly Capability[]): void {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>(caps)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Split a markdown string with `---`-delimited frontmatter into parsed parts. */
function splitFrontmatter(contents: string): {
  data: Record<string, unknown>;
  body: string;
} {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    throw new Error('contents missing YAML frontmatter');
  }
  const data = parseYaml(match[1]) as Record<string, unknown>;
  return { data, body: match[2] };
}

describe('OpenCodeAdapter', () => {
  it('OpenCodeAdapter_RuntimeIdentifier_IsOpencode', () => {
    expect(OpenCodeAdapter.runtime).toBe('opencode');
  });

  it('OpenCodeAdapter_AgentFilePath_ReturnsOpencodeAgentsPath', () => {
    expect(OpenCodeAdapter.agentFilePath('implementer')).toBe(
      '.opencode/agents/implementer.md',
    );
  });

  it('OpenCodeAdapter_LowerImplementer_EmitsModeSubagentFrontmatter', () => {
    const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
    const { data } = splitFrontmatter(contents);

    expect(data.mode).toBe('subagent');
    expect(data.description).toBe(IMPLEMENTER.description);

    const tools = data.tools as Record<string, boolean>;
    expect(tools.write).toBe(true);
    expect(tools.read).toBe(true);
    expect(tools.bash).toBe(true);
    expect(tools.edit).toBe(true);
  });

  /** The reviewer does not resolve to `fs:write`, so `write` and `edit` must be explicitly `false`, not absent. */
  it('OpenCodeAdapter_LowerReviewer_EmitsReadOnlyTools', () => {
    const { contents } = OpenCodeAdapter.lowerSpec(REVIEWER);
    const { data } = splitFrontmatter(contents);

    const tools = data.tools as Record<string, boolean>;
    expect(tools.read).toBe(true);
    expect(tools.write).toBe(false);
    expect(tools.edit).toBe(false);
  });

  it('OpenCodeAdapter_ValidateSupport_RejectsClaudeOnlyHooks', () => {
    forceCapabilities([
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
      'session:resume',
      'subagent:completion-signal',
    ]);
    const result = OpenCodeAdapter.validateSupport(IMPLEMENTER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:completion-signal/);
      expect(result.fixHint).toBeTruthy();
    }
  });

  /**
   * The readonly tier must still enable the `exarchos` server in the `mcp` map.
   * The dispatch layer limits the tier to the read-only actions.
   */
  it('OpenCodeAdapter_LowerSpec_Readonly_GrantsExarchosTool', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
    const { data } = splitFrontmatter(contents);

    const mcp = data.mcp as Record<string, true> | undefined;
    expect(mcp).toBeDefined();
    expect(mcp?.exarchos).toBe(true);
  });

  /**
   * The body must hold the spec description and the system prompt.
   * `## Task` and `{{taskDescription}}` are anchors from the implementer prompt.
   * They fail a render that drops the prompt but keeps the description.
   */
  it('OpenCodeAdapter_LowerSpec_BodyContainsSpecDescriptionAndSystemPromptSentinels', () => {
    const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
    const { body } = splitFrontmatter(contents);
    expect(body).toContain(IMPLEMENTER.description);
    expect(body).toContain('## Task');
    expect(body).toContain('{{taskDescription}}');
  });

  it('OpenCodeAdapter_RenderAgentSpec_CallsResolveCapabilitiesNotSpecField', () => {
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities');
    OpenCodeAdapter.lowerSpec(IMPLEMENTER);
    expect(spy).toHaveBeenCalled();
    const calledWithSpecPair = spy.mock.calls.some(
      (args) => args[0] === IMPLEMENTER.posture && args[1] === IMPLEMENTER.id,
    );
    expect(calledWithSpecPair).toBe(true);
  });
});
