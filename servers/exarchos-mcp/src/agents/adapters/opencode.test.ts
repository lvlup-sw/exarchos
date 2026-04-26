// ─── OpenCode adapter contract tests ───────────────────────────────────────
//
// OpenCode agents are Markdown files with YAML frontmatter at
// `.opencode/agents/<name>.md`. The frontmatter shape differs from
// Claude's: `tools` is a boolean object/map (not an array), and the
// agent kind is declared via `mode: subagent`.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { IMPLEMENTER, REVIEWER } from '../definitions.js';
import type { AgentSpec } from '../types.js';
import { OpenCodeAdapter } from './opencode.js';

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

  it('OpenCodeAdapter_LowerReviewer_EmitsReadOnlyTools', () => {
    // REVIEWER declares fs:read + shell:exec + mcp:exarchos (no fs:write).
    const { contents } = OpenCodeAdapter.lowerSpec(REVIEWER);
    const { data } = splitFrontmatter(contents);

    const tools = data.tools as Record<string, boolean>;
    expect(tools.read).toBe(true);
    // fs:write is NOT declared — write/edit must be explicitly false.
    expect(tools.write).toBe(false);
    expect(tools.edit).toBe(false);
  });

  it('OpenCodeAdapter_ValidateSupport_RejectsClaudeOnlyHooks', () => {
    const synthetic: AgentSpec = {
      ...IMPLEMENTER,
      capabilities: [...IMPLEMENTER.capabilities, 'subagent:completion-signal'],
    };
    const result = OpenCodeAdapter.validateSupport(synthetic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:completion-signal/);
      expect(result.fixHint).toBeTruthy();
    }
  });

  it('OpenCodeAdapter_LowerSpec_BodyContainsSpecDescription', () => {
    const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
    const { body } = splitFrontmatter(contents);
    // The lowered markdown body must include the spec's systemPrompt content
    // (or, at minimum, the spec's description so dispatch context is preserved).
    expect(body).toContain(IMPLEMENTER.description);
  });
});
