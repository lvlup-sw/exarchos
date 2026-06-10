// ─── Cursor RuntimeAdapter contract tests ──────────────────────────────────
//
// Cursor 2.5+ ships native sub-agents defined as Markdown with YAML
// frontmatter at `.cursor/agents/<name>.md`. The adapter lowers an
// AgentSpec into that file format and validates capability support.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CursorAdapter } from './cursor.js';
import { IMPLEMENTER, REVIEWER, SCAFFOLDER } from '../definitions.js';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import * as PostureMapping from '../../capabilities/posture-mapping.js';

/** Spy that forces `resolveCapabilities` to a hand-picked set for one test. */
function forceCapabilities(caps: readonly Capability[]): void {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>(caps)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
    forceCapabilities([
      'fs:read',
      'fs:write',
      'shell:exec',
      'mcp:exarchos',
      'isolation:worktree',
      'session:resume',
      'subagent:completion-signal',
    ]);
    const result = CursorAdapter.validateSupport(IMPLEMENTER);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/subagent:completion-signal/);
      expect(typeof result.fixHint).toBe('string');
    }
  });

  it('CursorAdapter_LowerSpec_BodyContainsSpecDescription', () => {
    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { body } = splitFrontmatter(contents);
    expect(body).toContain('implementer agent on the verification ladder');
  });

  // ─── Item 1, T09: mcp:exarchos:readonly capability wiring ──────────────
  //
  // A spec that grants only `mcp:exarchos:readonly` (no `mcp:exarchos`)
  // must still appear as MCP-enabled in the cursor agent definition so
  // that the Cursor runtime knows to enable the exarchos MCP server for
  // this agent. The mutating-action gate is enforced server-side
  // (see core/dispatch.ts), not at the cursor adapter layer.
  // ────────────────────────────────────────────────────────────────────────
  it('CursorAdapter_LowerSpec_Readonly_GrantsExarchosTool', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { data } = splitFrontmatter(contents);
    expect(data.mcp).toBeDefined();
    expect((data.mcp as Record<string, unknown>).exarchos).toBe(true);
  });

  it('CursorAdapter_LowerSpec_Full_GrantsExarchosTool', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos']);
    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { data } = splitFrontmatter(contents);
    expect(data.mcp).toBeDefined();
    expect((data.mcp as Record<string, unknown>).exarchos).toBe(true);
  });

  it('CursorAdapter_LowerSpec_NoMcpCapability_OmitsMcpField', () => {
    forceCapabilities(['fs:read', 'fs:write']);
    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { data } = splitFrontmatter(contents);
    expect(data.mcp).toBeUndefined();
  });

  // ─── Item 7, T29: advisory worktree-isolation strip ─────────────────────
  //
  // Cursor declares `isolation:worktree` as `advisory`. IMPLEMENTER and
  // SCAFFOLDER specs include hard "STOP if pwd doesn't contain `.worktrees/`"
  // startup guards which assume the runtime enforces worktree isolation.
  // Cursor doesn't, so the rendered Cursor agent must not carry the hard
  // guard (it would always trip in normal use). The strip is conservative:
  // it pattern-matches the known guard subsections and silently no-ops if
  // the prose is absent.
  // ────────────────────────────────────────────────────────────────────────

  it('CursorAdapter_LowerSpec_StripsHygieneButRetainsVerification_ForAdvisoryIsolation', () => {
    // CodeRabbit #1213/#2: the lighter `## Worktree Verification` startup
    // STOP block is retained for cursor (advisory isolation still benefits
    // from a sanity check), while the heavier `## Worktree Hygiene`
    // per-command rule block IS stripped (its rules are unworkable when
    // the runtime doesn't actually place the agent inside `.worktrees/`).
    expect(IMPLEMENTER.systemPrompt).toMatch(/## Worktree Verification/);
    expect(IMPLEMENTER.systemPrompt).toMatch(/## Worktree Hygiene/);
    expect(IMPLEMENTER.systemPrompt).toMatch(/STOP and report error/);

    const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
    const { body } = splitFrontmatter(contents);

    // Verification block is RETAINED.
    expect(body).toMatch(/## Worktree Verification/);
    expect(body).toMatch(/STOP and report error/);
    // Hygiene block is STRIPPED.
    expect(body).not.toMatch(/## Worktree Hygiene/);

    expect(body).toContain('implementer agent on the verification ladder');
    expect(body).toContain('## Task');
    // vls1-b5 (task 028): the static '## TDD Protocol' block became the
    // tier-conditional '## Verification' note (verification-ladder reframe).
    expect(body).toContain('## Verification');
    expect(body).toContain('## Completion Report');
  });

  it('CursorAdapter_LowerSpec_RetainsVerificationBlock_FromScaffolder', () => {
    // Same retention contract for SCAFFOLDER: verification stays, hygiene
    // (if any) goes.
    expect(SCAFFOLDER.systemPrompt).toMatch(/## Worktree Verification/);
    expect(SCAFFOLDER.systemPrompt).toMatch(/STOP and report error/);

    const { contents } = CursorAdapter.lowerSpec(SCAFFOLDER);
    const { body } = splitFrontmatter(contents);

    expect(body).toMatch(/## Worktree Verification/);
    expect(body).toMatch(/STOP and report error/);
    expect(body).not.toMatch(/## Worktree Hygiene/);

    expect(body).toContain('scaffolder agent');
    expect(body).toContain('## Task');
    expect(body).toContain('## Protocol');
    expect(body).toContain('## Completion Report');
  });

  it('CursorAdapter_LowerSpec_GuardStrip_IsConservativeNoOp_WhenProseAbsent', () => {
    const synthetic: AgentSpec = {
      ...IMPLEMENTER,
      systemPrompt: 'Just a plain prompt with no worktree guard sections.\n',
    };
    const { contents } = CursorAdapter.lowerSpec(synthetic);
    const { body } = splitFrontmatter(contents);
    expect(body).toContain('Just a plain prompt with no worktree guard sections.');
  });

  it('CursorAdapter_LowerSpec_DoesNotMutateSourceSpec', () => {
    const before = IMPLEMENTER.systemPrompt;
    CursorAdapter.lowerSpec(IMPLEMENTER);
    expect(IMPLEMENTER.systemPrompt).toBe(before);
    expect(IMPLEMENTER.systemPrompt).toMatch(/## Worktree Verification/);
  });

  // ─── #1333 β-04: adapter routes capability rendering through resolver ────

  it('CursorAdapter_RenderAgentSpec_CallsResolveCapabilitiesNotSpecField', () => {
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities');
    CursorAdapter.lowerSpec(IMPLEMENTER);
    expect(spy).toHaveBeenCalled();
    const calledWithSpecPair = spy.mock.calls.some(
      (args) => args[0] === IMPLEMENTER.posture && args[1] === IMPLEMENTER.id,
    );
    expect(calledWithSpecPair).toBe(true);
  });
});
