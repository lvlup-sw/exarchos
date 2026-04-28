// ─── Cursor RuntimeAdapter contract tests ──────────────────────────────────
//
// Cursor 2.5+ ships native sub-agents defined as Markdown with YAML
// frontmatter at `.cursor/agents/<name>.md`. The adapter lowers an
// AgentSpec into that file format and validates capability support.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CursorAdapter } from './cursor.js';
import { IMPLEMENTER, REVIEWER } from '../definitions.js';
import type { AgentSpec } from '../types.js';

/** Split a Markdown-with-YAML-frontmatter document into frontmatter + body. */
function splitFrontmatter(contents: string): { data: Record<string, unknown>; body: string } {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter found');
  const data = parseYaml(match[1]) as Record<string, unknown>;
  return { data, body: match[2] };
}

describe('CursorAdapter', () => {
  it('CursorAdapter_RuntimeIdentifier_IsCursor', () => {
    expect(CursorAdapter.runtime).toBe('cursor');
  });

  it('CursorAdapter_AgentFilePath_ReturnsCursorAgentsPath', () => {
    expect(CursorAdapter.agentFilePath('implementer')).toBe('.cursor/agents/implementer.md');
    expect(CursorAdapter.agentFilePath('reviewer')).toBe('.cursor/agents/reviewer.md');
  });

  it('CursorAdapter_LowerImplementer_EmitsCursor25Frontmatter', () => {
    const { path, contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    expect(path).toBe('.cursor/agents/implementer.md');

    const { data } = splitFrontmatter(contents);
    expect(data.name).toBe('implementer');
    expect(typeof data.description).toBe('string');
    expect(data.model).toBe('inherit');
    expect(data.readonly).toBe(false);
    expect(data.is_background).toBe(false);
  });

  it('CursorAdapter_LowerReviewer_EmitsReadonlyTrue', () => {
    const { contents } = CursorAdapter.lowerSpec(REVIEWER);
    const { data } = splitFrontmatter(contents);
    expect(data.name).toBe('reviewer');
    expect(data.readonly).toBe(true);
    expect(data.is_background).toBe(false);
  });

  it('CursorAdapter_ValidateSupport_RejectsClaudeOnlyHooks', () => {
    const synthetic: AgentSpec = {
      ...IMPLEMENTER,
      capabilities: [...IMPLEMENTER.capabilities, 'subagent:completion-signal'],
    };
    const result = CursorAdapter.validateSupport(synthetic);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:completion-signal/);
      expect(typeof result.fixHint).toBe('string');
    }
  });

  it('CursorAdapter_LowerSpec_BodyContainsSpecDescription', () => {
    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { body } = splitFrontmatter(contents);
    // The body should be the spec's systemPrompt body — assert a substring
    // from IMPLEMENTER.systemPrompt is present.
    expect(body).toContain('TDD implementer agent');
  });

  // ─── Item 1, T09: mcp:exarchos:readonly capability wiring ──────────────
  //
  // A spec that grants only `mcp:exarchos:readonly` (no `mcp:exarchos`)
  // must still appear as MCP-enabled in the cursor agent definition so
  // that the Cursor runtime knows to enable the exarchos MCP server for
  // this agent. The mutating-action gate is enforced server-side
  // (see core/dispatch.ts), not at the cursor adapter layer — the
  // adapter's job is just to grant the tool.
  //
  // Mirrors T08 (Copilot) per the PR-#1192 Item 1 plan.
  // ────────────────────────────────────────────────────────────────────────
  it('CursorAdapter_LowerSpec_Readonly_GrantsExarchosTool', () => {
    const spec: AgentSpec = {
      ...IMPLEMENTER,
      capabilities: ['fs:read', 'mcp:exarchos:readonly'],
    };
    const { contents } = CursorAdapter.lowerSpec(spec);
    const { data } = splitFrontmatter(contents);
    // Exarchos MCP server must be granted in the cursor frontmatter so the
    // runtime enables the server for this agent. The shape mirrors
    // OpenCode's `mcp: { exarchos: true }` (see opencode.ts buildFrontmatter).
    expect(data.mcp).toBeDefined();
    expect((data.mcp as Record<string, unknown>).exarchos).toBe(true);
  });

  it('CursorAdapter_LowerSpec_Full_GrantsExarchosTool', () => {
    // The full `mcp:exarchos` capability also grants the exarchos MCP
    // server (the readonly tier is the more-restrictive sibling).
    const spec: AgentSpec = {
      ...IMPLEMENTER,
      capabilities: ['fs:read', 'mcp:exarchos'],
    };
    const { contents } = CursorAdapter.lowerSpec(spec);
    const { data } = splitFrontmatter(contents);
    expect(data.mcp).toBeDefined();
    expect((data.mcp as Record<string, unknown>).exarchos).toBe(true);
  });

  it('CursorAdapter_LowerSpec_NoMcpCapability_OmitsMcpField', () => {
    // Specs that declare neither MCP capability must NOT emit an `mcp`
    // grant in the cursor frontmatter — leaking the grant would broaden
    // the trust boundary for fs/shell-only agents.
    const spec: AgentSpec = {
      ...IMPLEMENTER,
      capabilities: ['fs:read', 'fs:write'],
    };
    const { contents } = CursorAdapter.lowerSpec(spec);
    const { data } = splitFrontmatter(contents);
    expect(data.mcp).toBeUndefined();
  });
});
