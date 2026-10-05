/**
 * Contract tests for the Claude `RuntimeAdapter` against the port in `src/runtime/agents/adapters/types.ts`.
 * The snapshot suite in `generate-agents.test.ts` pins the output bytes against committed fixtures.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { claudeAdapter, generateClaudeAgentMarkdown } from '../../../../../src/runtime/agents/adapters/claude.js';
import type { AgentSpec } from '../../../../../src/runtime/agents/types.js';
import type { Capability } from '../../../../../src/runtime/agents/capabilities.js';
import {
  IMPLEMENTER,
  FIXER,
  REVIEWER,
  SCAFFOLDER,
} from '../../../../../src/runtime/agents/definitions.js';
import * as PostureMapping from '../../../../../src/workflow/capabilities/posture-mapping.js';

function forceCapabilities(caps: readonly Capability[]): void {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>(caps)),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Return the YAML text between the `---` fences of a generated Claude agent file, without the fences. */
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
      'rendered/agents/implementer.md',
    );
  });

  /** The test asserts the parsed frontmatter, not the raw bytes, because the YAML library selects the quote style of each scalar. */
  it('ClaudeAdapter_LowerImplementer_ProducesNonEmptyMarkdownWithFrontmatter', () => {
    const out = claudeAdapter.lowerSpec(IMPLEMENTER);
    expect(out.contents.length).toBeGreaterThan(0);
    expect(out.contents.startsWith('---\n')).toBe(true);
    const fm = parseYaml(extractFrontmatter(out.contents)) as Record<string, unknown>;
    expect(fm.name).toBe('exarchos-implementer');
    expect(Array.isArray(fm.tools)).toBe(true);
    expect((fm.tools as string[]).length).toBeGreaterThan(0);
    expect(out.contents).toContain('verification ladder');
  });

  it('ClaudeAdapter_LowerAllFourSpecs_AllProduceValidOutput', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      const out = claudeAdapter.lowerSpec(spec);
      expect(out.path).toBe(`rendered/agents/${spec.id}.md`);
      expect(out.contents.length).toBeGreaterThan(0);
      expect(out.contents.startsWith('---\n')).toBe(true);
    }
  });

  it('ClaudeAdapter_ValidateSupport_AllSpecsSucceed', () => {
    for (const spec of [IMPLEMENTER, FIXER, REVIEWER, SCAFFOLDER]) {
      expect(claudeAdapter.validateSupport(spec)).toEqual({ ok: true });
    }
  });

  /**
   * The adapter renders `isolation: worktree` only when the resolved capabilities of the spec hold `isolation:worktree`.
   * The fixer and the scaffolder need that field, so Claude Code starts each of them in an isolated worktree.
   */
  it('claudeAdapter_fixerSpec_rendersWorktreeIsolation', () => {
    const out = claudeAdapter.lowerSpec(FIXER);
    const fm = parseYaml(extractFrontmatter(out.contents)) as Record<string, unknown>;
    expect(fm.isolation).toBe('worktree');
  });

  it('claudeAdapter_scaffolderSpec_rendersWorktreeIsolation', () => {
    const out = claudeAdapter.lowerSpec(SCAFFOLDER);
    const fm = parseYaml(extractFrontmatter(out.contents)) as Record<string, unknown>;
    expect(fm.isolation).toBe('worktree');
  });
});

/**
 * Tests for YAML-hostile field values: embedded quotes, colons, leading whitespace, and `$(...)` in a hook command.
 * A round-trip test renders a synthetic `AgentSpec`, parses the frontmatter with a YAML parser, and expects the input value back.
 */
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

  /** One line of the description starts with whitespace. A block-scalar renderer that strips indentation fails this test. */
  it('Description_WithLeadingWhitespaceMultiline_RoundTripsThroughYamlParse', () => {
    const description = 'First line of the description.\n  Indented continuation line.\nFinal line.';
    const spec = withOverrides(IMPLEMENTER, { description });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.description).toBe(description);
  });

  /** The hook command holds a `$(...)` substitution and embedded double quotes. */
  it('HookCommand_WithSubshellAndQuotes_RoundTripsThroughYamlParse', () => {
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

  /**
   * The command anchors to the git toplevel, so it puts a `$(...)` substitution inside embedded double quotes.
   * The frontmatter must parse, and the one PostToolUse hook must hold the same command string.
   */
  it('ClaudeAdapter_HookCommand_WithSubshell_RendersValidYaml', () => {
    const command = 'npm --prefix "$(git rev-parse --show-toplevel)" run test:run';
    const spec = withOverrides(IMPLEMENTER, {
      validationRules: [
        { trigger: 'post-test', rule: 'All tests must pass', command },
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
    expect(hooks.PostToolUse).toHaveLength(1);
    expect(hooks.PostToolUse[0].hooks[0].command).toBe(command);
  });

  /**
   * A `pre-write` rule with a command renders a PreToolUse hook that matches each file-write tool.
   * Thus an agent cannot bypass the worktree-boundary guard with `MultiEdit` or `NotebookEdit`.
   */
  it('ClaudeAdapter_PreWriteRuleWithCommand_RendersWorktreeBoundaryDenyHook', () => {
    const command = 'exarchos verify-worktree-boundary';
    const spec = withOverrides(IMPLEMENTER, {
      validationRules: [{ trigger: 'pre-write', rule: 'Writes must stay in the worktree', command }],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, Array<{
      matcher: string;
      hooks: Array<{ type: string; command: string }>;
    }>>;
    expect(hooks.PreToolUse).toBeDefined();
    expect(hooks.PreToolUse[0].matcher).toBe('Write|Edit|MultiEdit|NotebookEdit');
    expect(hooks.PreToolUse[0].hooks[0].command).toBe(command);
  });

  /** A rule without a command is guidance only, so it must not render a hook. */
  it('ClaudeAdapter_PreWriteRuleWithoutCommand_RendersNoHook', () => {
    const spec = withOverrides(IMPLEMENTER, {
      validationRules: [{ trigger: 'pre-write', rule: 'Test file must exist before implementation' }],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect((parsed.hooks as Record<string, unknown> | undefined)?.PreToolUse).toBeUndefined();
  });

  /** `Server:Restart` is not a real Claude tool name. It proves that the renderer escapes the entries of a scalar list. */
  it('DisallowedTool_WithEmbeddedColon_RoundTripsThroughYamlParse', () => {
    const spec = withOverrides(IMPLEMENTER, {
      disallowedTools: ['Agent', 'Server:Restart'],
    });
    const md = generateClaudeAgentMarkdown(spec);
    const parsed = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(parsed.disallowedTools).toEqual(['Agent', 'Server:Restart']);
  });
});

/**
 * A Claude agent file grants an MCP server as a whole (`mcpServers: ["exarchos"]`), and it has no per-action allowlist.
 * Thus a spec whose only MCP tier is `mcp:exarchos:readonly` must still get the `exarchos` server grant.
 * `enforceReadonlyGate` in `src/dispatch/core/dispatch.ts` limits that tier to the read-only actions at dispatch time.
 */
describe('ClaudeAdapter_LowerSpec_McpReadonlyTier', () => {
  it('ClaudeAdapter_LowerSpec_ReadonlyMaps_To_ExarchosMcpServerGrant', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    const md = generateClaudeAgentMarkdown(IMPLEMENTER);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toEqual(['exarchos']);
  });

  it('ClaudeAdapter_LowerSpec_FullMcpCap_StillEmitsExarchosServerGrant', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos']);
    const md = generateClaudeAgentMarkdown(IMPLEMENTER);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toEqual(['exarchos']);
  });

  /** With no MCP tier, the frontmatter has no `mcpServers` field. This proves that the grant depends on the capability. */
  it('ClaudeAdapter_LowerSpec_NoMcpCap_OmitsMcpServersField', () => {
    forceCapabilities(['fs:read']);
    const md = generateClaudeAgentMarkdown(IMPLEMENTER);
    const fm = parseYaml(extractFrontmatter(md)) as Record<string, unknown>;
    expect(fm.mcpServers).toBeUndefined();
  });

  /** Claude is the reference runtime. `validateSupport` rejects only an `unsupported` capability, so it accepts the readonly tier. */
  it('ClaudeAdapter_ValidateSupport_ReadonlyTier_IsNative', () => {
    forceCapabilities(['fs:read', 'mcp:exarchos:readonly']);
    expect(claudeAdapter.validateSupport(IMPLEMENTER)).toEqual({ ok: true });
  });
});

/**
 * The Claude render path must call `resolveCapabilities(spec.posture, spec.id)`.
 * A second source of capabilities in the adapter can drift from the resolver.
 */
describe('ClaudeAdapter capability rendering routes through resolver (#1333 β-04)', () => {
  it('ClaudeAdapter_RenderAgentSpec_CallsResolveCapabilitiesNotSpecField', () => {
    const spy = vi.spyOn(PostureMapping, 'resolveCapabilities');
    claudeAdapter.lowerSpec(IMPLEMENTER);
    expect(spy).toHaveBeenCalled();
    const calledWithSpecPair = spy.mock.calls.some(
      (args) => args[0] === IMPLEMENTER.posture && args[1] === IMPLEMENTER.id,
    );
    expect(calledWithSpecPair).toBe(true);
  });
});
