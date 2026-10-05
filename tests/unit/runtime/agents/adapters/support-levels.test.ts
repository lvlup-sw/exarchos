/**
 * Cross-adapter tests for the three-state capability support contract.
 * Each `RuntimeAdapter` declares a `supportLevels` map (`native`, `advisory` or `unsupported`) for each value of the `Capability` enum.
 * `validateSupport` and `lowerSpec` must obey that map.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Capability } from '../../../../../src/runtime/agents/capabilities.js';
import { IMPLEMENTER } from '../../../../../src/runtime/agents/definitions.js';
import type { AgentSpec } from '../../../../../src/runtime/agents/types.js';
import type { RuntimeAdapter, SupportLevel } from '../../../../../src/runtime/agents/adapters/types.js';
import { claudeAdapter } from '../../../../../src/runtime/agents/adapters/claude.js';
import { codexAdapter } from '../../../../../src/runtime/agents/adapters/codex.js';
import { OpenCodeAdapter } from '../../../../../src/runtime/agents/adapters/opencode.js';
import { CursorAdapter } from '../../../../../src/runtime/agents/adapters/cursor.js';
import { CopilotAdapter } from '../../../../../src/runtime/agents/adapters/copilot.js';
import * as PostureMapping from '../../../../../src/workflow/capabilities/posture-mapping.js';

/** The five adapters. `CopilotAdapter` is a class, so the list holds an instance. */
const ADAPTERS: ReadonlyArray<{ name: string; adapter: RuntimeAdapter }> = [
  { name: 'claude', adapter: claudeAdapter },
  { name: 'codex', adapter: codexAdapter },
  { name: 'opencode', adapter: OpenCodeAdapter },
  { name: 'cursor', adapter: CursorAdapter },
  { name: 'copilot', adapter: new CopilotAdapter() },
];

/** Each value of the `Capability` zod enum. */
const ALL_CAPABILITIES = Capability.options;

/** Allowed support-level values. */
const VALID_LEVELS: readonly SupportLevel[] = ['native', 'advisory', 'unsupported'];

/**
 * Expected support level of each capability for the non-Claude adapters. Codex, OpenCode, Cursor and Copilot share one matrix.
 * `session:resume` is `advisory`, not `unsupported`, because the implementer resolves to it and each adapter must accept the implementer spec.
 */
const NON_CLAUDE_EXPECTED: Readonly<Record<Capability, SupportLevel>> = {
  'fs:read': 'native',
  'fs:write': 'native',
  'shell:exec': 'native',
  'subagent:spawn': 'native',
  'mcp:exarchos': 'native',
  'mcp:exarchos:readonly': 'native',
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
};

/**
 * Return a copy of the implementer spec, and make `resolveCapabilities` return only `cap`.
 * `AgentSpec` has no `capabilities` field, so the helper mocks the resolver. `afterEach` restores the mock.
 */
function syntheticSpecWith(cap: Capability): AgentSpec {
  vi.spyOn(PostureMapping, 'resolveCapabilities').mockReturnValue(
    Object.freeze(new Set<Capability>([cap])),
  );
  return { ...IMPLEMENTER };
}

afterEach(() => {
  vi.restoreAllMocks();
});

/** Parse Markdown YAML frontmatter into `{ data, body }`. */
function parseFrontmatter(contents: string): { data: Record<string, unknown>; body: string } {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error('No YAML frontmatter delimiters found');
  return {
    data: parseYaml(match[1]) as Record<string, unknown>,
    body: match[2] ?? '',
  };
}

describe('SupportLevels (cross-adapter contract)', () => {
  describe('SupportLevels_AllAdaptersDeclareEveryCapability_ExhaustiveMap', () => {
    for (const { name, adapter } of ADAPTERS) {
      for (const cap of ALL_CAPABILITIES) {
        it(`${name} declares supportLevels[${cap}] as a valid SupportLevel`, () => {
          const level = adapter.supportLevels[cap];
          expect(level).toBeDefined();
          expect(VALID_LEVELS).toContain(level);
        });
      }
    }
  });

  /** Claude is the reference runtime, so each capability is `native`. */
  it('SupportLevels_ClaudeNativeForAll_NoUnsupported', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(claudeAdapter.supportLevels[cap]).toBe('native');
    }
  });

  describe('SupportLevels_NonClaudeAdaptersHaveCorrectClassification', () => {
    const nonClaude = ADAPTERS.filter((a) => a.name !== 'claude');
    for (const { name, adapter } of nonClaude) {
      for (const cap of ALL_CAPABILITIES) {
        it(`${name}.supportLevels[${cap}] = ${NON_CLAUDE_EXPECTED[cap]}`, () => {
          expect(adapter.supportLevels[cap]).toBe(NON_CLAUDE_EXPECTED[cap]);
        });
      }
    }
  });

  describe('ValidateSupport_AdvisoryCapability_ReturnsOkTrue', () => {
    const nonClaude = ADAPTERS.filter((a) => a.name !== 'claude');
    for (const { name, adapter } of nonClaude) {
      it(`${name} accepts spec with only isolation:worktree`, () => {
        const result = adapter.validateSupport(syntheticSpecWith('isolation:worktree'));
        expect(result.ok).toBe(true);
      });
    }
  });

  describe('ValidateSupport_UnsupportedCapability_ReturnsOkFalse', () => {
    const nonClaude = ADAPTERS.filter((a) => a.name !== 'claude');
    for (const { name, adapter } of nonClaude) {
      it(`${name} rejects spec with team:agent-teams`, () => {
        const result = adapter.validateSupport(syntheticSpecWith('team:agent-teams'));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toMatch(/team:agent-teams/);
          expect(typeof result.fixHint).toBe('string');
          expect(result.fixHint.length).toBeGreaterThan(0);
        }
      });
    }
  });

  /** Each adapter must accept the implementer spec. If one rejects it, the agent generator reports a validation error. */
  describe('ValidateSupport_CanonicalImplementerSpec_AllAdaptersAccept', () => {
    for (const { name, adapter } of ADAPTERS) {
      it(`${name} accepts IMPLEMENTER`, () => {
        const result = adapter.validateSupport(IMPLEMENTER);
        expect(result.ok).toBe(true);
      });
    }
  });

  /** An adapter accepts an advisory capability but emits no tool entry for it. */
  describe('LowerSpec_AdvisoryCapability_NotEmittedAsTool', () => {
    it('opencode does not include isolation:worktree in tools map', () => {
      const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      const tools = data.tools as Record<string, unknown>;
      expect(tools).not.toHaveProperty('isolation:worktree');
      expect(tools).not.toHaveProperty('worktree');
    });

    /** The Cursor frontmatter has no tools field, so the test searches the full frontmatter for the capability name. */
    it('cursor does not include isolation:worktree in frontmatter', () => {
      const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      expect(JSON.stringify(data)).not.toContain('isolation:worktree');
    });

    it('copilot does not include isolation:worktree in tools array', () => {
      const adapter = new CopilotAdapter();
      const { contents } = adapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      const tools = data.tools as string[];
      expect(tools).not.toContain('isolation:worktree');
      expect(tools).not.toContain('worktree');
    });

    /** The test matches only a TOML key at the start of a line. The capability list in `developer_instructions` is prose, not a tool entry. */
    it('codex does not emit isolation:worktree as a top-level TOML key', () => {
      const { contents } = codexAdapter.lowerSpec(IMPLEMENTER);
      expect(contents).not.toMatch(/^isolation:worktree\s*=/m);
      expect(contents).not.toMatch(/^worktree\s*=/m);
    });
  });

  /** Each adapter emits a native capability under the tool name of its runtime. */
  describe('LowerSpec_NativeCapability_EmittedAsTool', () => {
    it('claude emits Read, Write, Bash for fs:read/fs:write/shell:exec', () => {
      const { contents } = claudeAdapter.lowerSpec(IMPLEMENTER);
      expect(contents).toMatch(/Read/);
      expect(contents).toMatch(/Write/);
      expect(contents).toMatch(/Bash/);
    });

    it('opencode emits read/write/bash booleans true', () => {
      const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      const tools = data.tools as Record<string, boolean>;
      expect(tools.read).toBe(true);
      expect(tools.write).toBe(true);
      expect(tools.bash).toBe(true);
    });

    it('copilot emits read, write, shell in tools array', () => {
      const adapter = new CopilotAdapter();
      const { contents } = adapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      const tools = data.tools as string[];
      expect(tools).toContain('read');
      expect(tools).toContain('write');
      expect(tools).toContain('shell');
    });

    it('codex includes fs:read/fs:write/shell:exec in developer_instructions', () => {
      const { contents } = codexAdapter.lowerSpec(IMPLEMENTER);
      expect(contents).toContain('fs:read');
      expect(contents).toContain('fs:write');
      expect(contents).toContain('shell:exec');
    });

    /** Cursor has no tool array. Its `readonly` flag is `false` when the spec resolves to `fs:write`. */
    it('cursor reflects fs:write via readonly=false', () => {
      const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      expect(data.readonly).toBe(false);
    });
  });
});
