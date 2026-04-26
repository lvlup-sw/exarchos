// ─── Cross-adapter three-state capability support tests ───────────────────
//
// Asserts that every RuntimeAdapter declares a typed `supportLevels` map
// (`'native' | 'advisory' | 'unsupported'`) covering every value of the
// `Capability` enum, and that `validateSupport` and `lowerSpec` consult
// the map rather than ad-hoc constants.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4 (Task 4f
// retrofit — replaces the divergent per-adapter policy with a shared
// three-state contract).
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { Capability } from '../capabilities.js';
import { IMPLEMENTER } from '../definitions.js';
import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, SupportLevel } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { OpenCodeAdapter } from './opencode.js';
import { CursorAdapter } from './cursor.js';
import { CopilotAdapter } from './copilot.js';

/** Adapter registry. The CopilotAdapter is a class — instantiate it. */
const ADAPTERS: ReadonlyArray<{ name: string; adapter: RuntimeAdapter }> = [
  { name: 'claude', adapter: claudeAdapter },
  { name: 'codex', adapter: codexAdapter },
  { name: 'opencode', adapter: OpenCodeAdapter },
  { name: 'cursor', adapter: CursorAdapter },
  { name: 'copilot', adapter: new CopilotAdapter() },
];

/** Every value of the Capability enum (zod source of truth). */
const ALL_CAPABILITIES = Capability.options;

/** Allowed support-level values. */
const VALID_LEVELS: readonly SupportLevel[] = ['native', 'advisory', 'unsupported'];

/**
 * Expected support-level classification for each non-Claude adapter.
 * Codex / OpenCode / Cursor / Copilot share the same matrix per the
 * convergence in Task 4f.
 */
// Note on `session:resume`: the Task 4f matrix initially classified this
// as `unsupported` for non-Claude adapters, but the regression-safety
// gate (Test 6) requires every adapter to accept the canonical
// IMPLEMENTER spec — and IMPLEMENTER declares `session:resume`.
// Resolution: classify as `advisory` (silently tolerated, no first-class
// primitive). This matches the prior Copilot adapter's behavior and
// keeps the IMPLEMENTER spec validating cleanly across all five
// adapters. See task report for the divergence note.
const NON_CLAUDE_EXPECTED: Readonly<Record<Capability, SupportLevel>> = {
  'fs:read': 'native',
  'fs:write': 'native',
  'shell:exec': 'native',
  'subagent:spawn': 'native',
  'mcp:exarchos': 'native',
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
};

/** A spec with exactly one capability, used to probe validateSupport. */
function syntheticSpecWith(cap: Capability): AgentSpec {
  return {
    ...IMPLEMENTER,
    capabilities: [cap],
  };
}

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
  // 1. Exhaustive map: every adapter declares every capability.
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

  // 2. Claude is the reference runtime: every capability is `native`.
  it('SupportLevels_ClaudeNativeForAll_NoUnsupported', () => {
    for (const cap of ALL_CAPABILITIES) {
      expect(claudeAdapter.supportLevels[cap]).toBe('native');
    }
  });

  // 3. Non-Claude adapters share the convergence matrix.
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

  // 4. Advisory capabilities validate as ok:true when sole capability.
  describe('ValidateSupport_AdvisoryCapability_ReturnsOkTrue', () => {
    const nonClaude = ADAPTERS.filter((a) => a.name !== 'claude');
    for (const { name, adapter } of nonClaude) {
      it(`${name} accepts spec with only isolation:worktree`, () => {
        const result = adapter.validateSupport(syntheticSpecWith('isolation:worktree'));
        expect(result.ok).toBe(true);
      });
    }
  });

  // 5. Unsupported capabilities validate as ok:false with reason+fixHint.
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

  // 6. Regression-safety gate: every adapter accepts the canonical
  //    IMPLEMENTER spec end-to-end. This is the gate that prevents Task 5
  //    composition root from build-erroring on session:resume etc.
  describe('ValidateSupport_CanonicalImplementerSpec_AllAdaptersAccept', () => {
    for (const { name, adapter } of ADAPTERS) {
      it(`${name} accepts IMPLEMENTER`, () => {
        const result = adapter.validateSupport(IMPLEMENTER);
        expect(result.ok).toBe(true);
      });
    }
  });

  // 7. Advisory caps are silently tolerated — not emitted as a tool entry
  //    in lowered output (frontmatter / tools array / boolean map).
  describe('LowerSpec_AdvisoryCapability_NotEmittedAsTool', () => {
    it('opencode does not include isolation:worktree in tools map', () => {
      const { contents } = OpenCodeAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      const tools = data.tools as Record<string, unknown>;
      expect(tools).not.toHaveProperty('isolation:worktree');
      expect(tools).not.toHaveProperty('worktree');
    });

    it('cursor does not include isolation:worktree in frontmatter', () => {
      const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      // Cursor frontmatter has no tools field, but assert no advisory key
      // leaked into frontmatter at all.
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

    it('codex does not emit isolation:worktree as a top-level TOML key', () => {
      const { contents } = codexAdapter.lowerSpec(IMPLEMENTER);
      // Top-level TOML keys appear as `key = ...` at line start. Capability
      // listings inside developer_instructions multi-line strings are
      // documentation, not tool/frontmatter entries.
      expect(contents).not.toMatch(/^isolation:worktree\s*=/m);
      expect(contents).not.toMatch(/^worktree\s*=/m);
    });
  });

  // 8. Native caps ARE emitted (each in their runtime-specific tool name).
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

    it('cursor reflects fs:write via readonly=false', () => {
      // Cursor has no per-capability tool array — its closest analogue is
      // the `readonly` flag, which is `false` exactly when fs:write is
      // declared (i.e. native). Verify the IMPLEMENTER (which declares
      // fs:write) lowers to readonly=false.
      const { contents } = CursorAdapter.lowerSpec(IMPLEMENTER);
      const { data } = parseFrontmatter(contents);
      expect(data.readonly).toBe(false);
    });
  });
});
