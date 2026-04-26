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
});
