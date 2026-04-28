// ─── Claude adapter contract tests ──────────────────────────────────────────
//
// Asserts the Claude `RuntimeAdapter` implementation conforms to the port
// defined in `./types.ts`. Byte-level output regression is enforced separately
// by the snapshot suite in `generate-agents.test.ts` (pinned to the committed
// `agents/*.md` fixtures), which is the canonical contract Claude users
// depend on.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { claudeAdapter, generateClaudeAgentMarkdown } from './claude.js';
import type { AgentSpec } from '../types.js';
import {
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
} from '../definitions.js';

// Extracts the `---\n…\n---` YAML frontmatter block (without the
// surrounding fences) from a generated Claude agent file. Returns the
// raw YAML text so callers can `parseYaml` it and assert round-trip
// fidelity against the input spec.
function extractFrontmatter(contents: string): string {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error('No YAML frontmatter delimiters found');
  return match[1];
}

describe('Claude adapter', () => {
  it('ClaudeAdapter_RuntimeIdentifier_IsClaude', () => {
    expect(claudeAdapter.runtime).toBe('claude');
  });

  it('ClaudeAdapter_AgentFilePath_ReturnsAgentsPath', () => {
    expect(claudeAdapter.agentFilePath('implementer')).toBe(
      'agents/implementer.md',
    );
  });

  it('ClaudeAdapter_LowerImplementer_ProducesNonEmptyMarkdownWithFrontmatter', () => {
    const out = claudeAdapter.lowerSpec(IMPLEMENTER);
    expect(out.contents.length).toBeGreaterThan(0);
    expect(out.contents.startsWith('---\n')).toBe(true);
    // Parse the frontmatter rather than asserting on raw bytes — the
    // YAML library may render scalars unquoted/quoted/plain depending
    // on content. The contract is the parsed value, not the byte form.
    const fm = parseYaml(extractFrontmatter(out.contents)) as Record<string, unknown>;
    expect(fm.name).toBe('exarchos-implementer');
    expect(Array.isArray(fm.tools)).toBe(true);
    expect((fm.tools as string[]).length).toBeGreaterThan(0);
    // Body should include some implementer description text.
    expect(out.contents).toContain('TDD');
  });

  it('ClaudeAdapter_LowerAllFourSpecs_AllProduceValidOutput', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      const out = claudeAdapter.lowerSpec(spec);
      expect(out.path).toBe(`agents/${spec.id}.md`);
      expect(out.contents.length).toBeGreaterThan(0);
      expect(out.contents.startsWith('---\n')).toBe(true);
    }
  });

  it('ClaudeAdapter_ValidateSupport_AllSpecsSucceed', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      expect(claudeAdapter.validateSupport(spec)).toEqual({ ok: true });
    }
  });
});

// ─── Adversarial YAML field tests ──────────────────────────────────────────
//
// The Claude adapter renders agent files as Markdown with YAML frontmatter.
// A safe renderer must escape any character that would otherwise change
// YAML semantics (embedded quotes, leading colons, leading whitespace,
// shell `$(…)` substitutions inside hook commands, etc).
//
// These tests construct synthetic AgentSpecs with YAML-hostile field
// values, render them, parse the resulting frontmatter back through a
// real YAML parser, and assert that the parsed value matches the
// original input. This is a round-trip contract: render → parse must be
// the identity for the field under test.
//
// Item 4 of #1192 (worktree-anchored hooks) introduces hook command
// strings containing `$(git rev-parse --show-toplevel)` and embedded
// double quotes — exactly the inputs the current concat renderer
// mangles. These tests pin the contract that must hold before that work
// can land.
describe('ClaudeAdapter_GenerateMarkdown_HandlesYamlSpecialChars', () => {
  function withOverrides(spec: AgentSpec, overrides: Partial<AgentSpec>): AgentSpec {
    return { ...spec, ...overrides };
  }

  it('Description_WithEmbeddedDoubleQuotes_RoundTripsThroughYamlParse', () => {
    const description = 'Use "X" pattern when refactoring legacy modules';
    const spec = withOverrides(IMPLEMENTER, { description });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.description).toBe(description);
  });

  it('Description_WithEmbeddedColon_RoundTripsThroughYamlParse', () => {
    const description = 'Use for: thing handling and related concerns';
    const spec = withOverrides(IMPLEMENTER, { description });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.description).toBe(description);
  });

  it('Description_WithLeadingWhitespaceMultiline_RoundTripsThroughYamlParse', () => {
    // Multi-line description where one line begins with whitespace —
    // exposes naive `description: |` block-scalar renderers that
    // strip indentation.
    const description = 'First line of the description.\n  Indented continuation line.\nFinal line.';
    const spec = withOverrides(IMPLEMENTER, { description });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.description).toBe(description);
  });

  it('HookCommand_WithSubshellAndQuotes_RoundTripsThroughYamlParse', () => {
    // The exact failure mode Item 4 will trigger: a hook command that
    // contains both `$(...)` and embedded double quotes.
    const command = 'cd "$(git rev-parse --show-toplevel)" && npm run test:run';
    const spec = withOverrides(IMPLEMENTER, {
      validationRules: [
        { trigger: 'post-test', rule: 'run tests', command },
      ],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>>;
    expect(hooks).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(command);
  });

  it('ClaudeAdapter_HookCommand_WithSubshell_RendersValidYaml', () => {
    // #1192 Item 4, T24 — regression guard for the exact hook-command
    // shape T25 will introduce: `npm --prefix "$(git rev-parse
    // --show-toplevel)" run test:run`. This combines a `$(...)` shell
    // substitution with embedded double quotes inside a YAML scalar —
    // the precise input the pre-T02 string-concat renderer mangled.
    //
    // T25 anchors hook commands to the git toplevel so they survive
    // sub-agent worktree `cd`s (see CLAUDE.md "Worktree Hygiene"). That
    // anchoring is only safe if this rendered scalar parses back to the
    // identity. Locking the property here lets T25 land without needing
    // to re-prove YAML safety in the same change.
    const command = 'npm --prefix "$(git rev-parse --show-toplevel)" run test:run';
    const spec = withOverrides(IMPLEMENTER, {
      validationRules: [
        { trigger: 'post-test', rule: 'All tests must pass', command },
      ],
    });
    const md = generateClaudeAgentMarkdown(spec);
    // 1. The frontmatter must parse without throwing.
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    // 2. The hook command must round-trip byte-for-byte.
    const hooks = parsed.hooks as Record<string, Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>>;
    expect(hooks).toBeDefined();
    expect(hooks.PostToolUse).toBeDefined();
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(command);
  });

  it('DisallowedTool_WithEmbeddedColon_RoundTripsThroughYamlParse', () => {
    // Synthetic case: a tool name with a colon. Not a realistic Claude
    // tool name, but it proves the renderer escapes scalar list entries
    // rather than emitting them raw — the same primitive Item 4's hook
    // commands rely on.
    const spec = withOverrides(IMPLEMENTER, {
      disallowedTools: ['Agent', 'Server:Restart'],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.disallowedTools).toEqual(['Agent', 'Server:Restart']);
  });
});

// ─── mcp:exarchos:readonly capability wiring (#1192 Item 1, T06) ──────────
//
// The readonly capability tier is enforced server-side at dispatch time
// (see `READ_ONLY_ACTIONS` + `enforceReadonlyGate` in core/dispatch.ts,
// task T04). Claude Code's frontmatter only grants/denies MCP servers at
// the whole-server granularity (`mcpServers: ["exarchos"]`) — there is no
// per-action allowlist surface in the agent file format. Therefore an
// agent whose ONLY mcp tier is `mcp:exarchos:readonly` must still receive
// the `mcpServers: ["exarchos"]` grant in frontmatter; the dispatch-layer
// gate handles per-action enforcement at runtime.
//
// Without this wiring, a spec carrying only `mcp:exarchos:readonly` would
// render frontmatter that omits the exarchos server entirely, leaving the
// agent unable to invoke even the read-only action subset.
describe('ClaudeAdapter_LowerSpec_McpReadonlyTier', () => {
  function withOverrides(spec: AgentSpec, overrides: Partial<AgentSpec>): AgentSpec {
    return { ...spec, ...overrides };
  }

  it('ClaudeAdapter_LowerSpec_ReadonlyMaps_To_ExarchosMcpServerGrant', () => {
    // Spec holds `mcp:exarchos:readonly` (and NOT `mcp:exarchos`).
    // Expect the adapter to still emit the `exarchos` server entry so
    // the agent can reach the dispatch-layer readonly gate at all.
    const spec = withOverrides(IMPLEMENTER, {
      capabilities: ['fs:read', 'mcp:exarchos:readonly'],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toEqual(['exarchos']);
  });

  it('ClaudeAdapter_LowerSpec_FullMcpCap_StillEmitsExarchosServerGrant', () => {
    // Sanity: pre-existing behavior unchanged for `mcp:exarchos`.
    const spec = withOverrides(IMPLEMENTER, {
      capabilities: ['fs:read', 'mcp:exarchos'],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toEqual(['exarchos']);
  });

  it('ClaudeAdapter_LowerSpec_NoMcpCap_OmitsMcpServersField', () => {
    // Sanity: when neither tier is present, `mcpServers` is not emitted
    // at all (so the readonly wiring is provably gated on capability,
    // not unconditional).
    const spec = withOverrides(IMPLEMENTER, {
      capabilities: ['fs:read'],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toBeUndefined();
  });

  it('ClaudeAdapter_ValidateSupport_ReadonlyTier_IsNative', () => {
    // Claude is the reference runtime — every capability is `native`.
    // The readonly tier was added to the Capability enum in T03; if the
    // claude support map weren't refreshed, validateSupport would reject
    // a spec that uses it.
    const spec = withOverrides(IMPLEMENTER, {
      capabilities: ['fs:read', 'mcp:exarchos:readonly'],
    });
    expect(claudeAdapter.validateSupport(spec)).toEqual({ ok: true });
  });
});
