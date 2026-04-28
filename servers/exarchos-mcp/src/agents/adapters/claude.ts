// ─── Claude RuntimeAdapter ──────────────────────────────────────────────────
//
// Lowers a runtime-agnostic `AgentSpec` into a Claude Code agent definition
// file (Markdown with YAML frontmatter).
//
// Output is byte-pinned by the snapshot regression suite in
// `generate-agents.test.ts`, which compares `claudeAdapter.lowerSpec`
// against the committed `agents/*.md` fixtures. If any rendering helper
// below changes behaviour, that test fails with a byte-level diff.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec, AgentValidationRule } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

// ─── Capability → Claude tools translation ─────────────────────────────────
//
// Specs declare runtime-agnostic `capabilities`; Claude consumes a flat
// `tools` array in frontmatter. Translation lives here so the Claude
// adapter is a single, self-contained lowering pass.
//
// Exported because `handler.ts` and `generated-drift.test.ts` re-derive the
// same array when shaping the `agent_spec` MCP response and when asserting
// generated-file drift.
export function deriveClaudeToolsFromCapabilities(spec: AgentSpec): readonly string[] {
  const caps = new Set<string>(spec.capabilities);
  const tools: string[] = [];
  // Reviewer historically used a different ordering: [Read, Grep, Glob, Bash].
  // All other roles used [Read, Write, Edit, Bash, Grep, Glob]. Preserve both
  // verbatim so the snapshot regression test sees zero drift.
  if (spec.id === 'reviewer') {
    if (caps.has('fs:read')) tools.push('Read', 'Grep', 'Glob');
    if (caps.has('shell:exec')) tools.push('Bash');
    return tools;
  }
  if (caps.has('fs:read')) tools.push('Read');
  if (caps.has('fs:write')) tools.push('Write', 'Edit');
  if (caps.has('shell:exec')) tools.push('Bash');
  if (caps.has('fs:read')) tools.push('Grep', 'Glob');
  return tools;
}

// ─── Trigger-to-Matcher Mapping ─────────────────────────────────────────────

const TRIGGER_MAP: Record<string, { hookType: string; matcher: string }> = {
  'pre-write': { hookType: 'PreToolUse', matcher: 'Write|Edit' },
  'pre-edit': { hookType: 'PreToolUse', matcher: 'Edit' },
  'post-test': { hookType: 'PostToolUse', matcher: 'Bash' },
};

// ─── Build Hooks from Rules ─────────────────────────────────────────────────

interface ClaudeHookEntry {
  matcher: string;
  hooks: Array<{ type: string; command: string }>;
}

/**
 * Maps validation rules to the Claude hook format.
 * Rules without a `command` property are skipped.
 */
function buildHooksFromRules(
  rules: readonly AgentValidationRule[],
): Record<string, ClaudeHookEntry[]> {
  const hooks: Record<string, ClaudeHookEntry[]> = {};

  for (const rule of rules) {
    if (!rule.command) continue;

    const mapping = TRIGGER_MAP[rule.trigger];
    if (!mapping) continue;

    const { hookType, matcher } = mapping;

    if (!hooks[hookType]) {
      hooks[hookType] = [];
    }

    hooks[hookType].push({
      matcher,
      hooks: [{ type: 'command', command: rule.command }],
    });
  }

  return hooks;
}

// ─── Generate Agent Markdown ────────────────────────────────────────────────

/**
 * Renders an `AgentSpec` as a Claude Code agent definition file
 * (Markdown with YAML frontmatter + system prompt body). Output is
 * byte-pinned by `generate-agents.test.ts`'s snapshot regression suite.
 *
 * Frontmatter is built as a plain JS object and serialized with
 * `yaml.stringify` (yaml@^2.8.2). This eliminates the previous
 * string-concat path and the `serializeHooksYaml` helper, both of which
 * mishandled embedded quotes, colons, leading whitespace, and shell
 * `$(...)` substitutions in user-supplied scalar values. See #1192
 * Item 2 (and Item 4, which adds quote-bearing hook commands).
 *
 * Exported so `generated-drift.test.ts` can assert per-spec markdown
 * generation in isolation. Production callers should go through the
 * `claudeAdapter.lowerSpec` entry point below.
 */
export function generateClaudeAgentMarkdown(spec: AgentSpec): string {
  // Build the frontmatter as a plain JS object so the YAML library
  // owns scalar escaping. Field ordering is preserved to minimise the
  // snapshot diff against the committed fixtures.
  const frontmatter: Record<string, unknown> = {};

  frontmatter.name = `exarchos-${spec.id}`;
  frontmatter.description = spec.description;

  // Lower capabilities to Claude's flat `tools` array.
  frontmatter.tools = [...deriveClaudeToolsFromCapabilities(spec)];
  frontmatter.model = spec.model;

  if (spec.color) {
    frontmatter.color = spec.color;
  }

  if (spec.disallowedTools && spec.disallowedTools.length > 0) {
    frontmatter.disallowedTools = [...spec.disallowedTools];
  }

  // Isolation: derive from capabilities so the spec has a single source
  // of truth. `spec.isolation` is preserved on the type as advisory
  // metadata, but the rendered frontmatter is driven by capabilities to
  // avoid the support-validation/render split that produced two
  // disagreeing answers.
  if (spec.capabilities.includes('isolation:worktree')) {
    frontmatter.isolation = 'worktree';
  }

  if (spec.memoryScope) {
    frontmatter.memory = spec.memoryScope;
  }

  if (spec.maxTurns !== undefined) {
    frontmatter.maxTurns = spec.maxTurns;
  }

  // mcpServers: derive from `mcp:exarchos*` capabilities for the same
  // single-source-of-truth reason as isolation above. Only `exarchos`
  // is wired today; if/when additional MCP servers become first-class
  // capabilities, extend this list with parallel checks.
  //
  // Both `mcp:exarchos` (full) and `mcp:exarchos:readonly` (restricted
  // tier — #1192 Item 1, T03) map to the same `mcpServers` grant.
  // Claude Code's frontmatter only exposes whole-server allow/deny;
  // there is no per-action allowlist surface in the agent file format,
  // so per-action enforcement for the readonly tier happens server-side
  // at dispatch time via `READ_ONLY_ACTIONS` / `enforceReadonlyGate`
  // in `core/dispatch.ts` (T04). Granting the server here is the
  // necessary precondition for that gate to fire — without the grant,
  // a readonly-only spec would be unable to invoke even the read-only
  // action subset.
  if (
    spec.capabilities.includes('mcp:exarchos') ||
    spec.capabilities.includes('mcp:exarchos:readonly')
  ) {
    frontmatter.mcpServers = ['exarchos'];
  }

  if (spec.skills.length > 0) {
    frontmatter.skills = spec.skills.map((s) => s.name);
  }

  const hooks = buildHooksFromRules(spec.validationRules);
  if (Object.keys(hooks).length > 0) {
    frontmatter.hooks = hooks;
  }

  // `lineWidth: 0` disables auto-wrapping so long descriptions don't
  // get folded into multi-line block scalars on every render (the
  // snapshot suite would then drift on any cosmetic length change).
  //
  // `defaultStringType: 'PLAIN'` lets the YAML library decide per-scalar:
  // safe values render unquoted (matches the prior renderer's intent
  // for things like `name: exarchos-implementer`), values containing
  // YAML-significant characters get auto-quoted, and multi-line strings
  // become block scalars. This is the safest default and produces the
  // smallest semantic diff against the previous hand-rolled output.
  const yamlText = stringifyYaml(frontmatter, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });

  return `---\n${yamlText}---\n\n${spec.systemPrompt}\n`;
}

// ─── Adapter ────────────────────────────────────────────────────────────────

/**
 * Claude is the reference runtime: every capability the spec model
 * defines today is `native`. Mirrored in `runtimes/claude.yaml`.
 */
const CLAUDE_SUPPORT_LEVELS = buildSupportMap('native');

export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',
  supportLevels: CLAUDE_SUPPORT_LEVELS,

  agentFilePath(agentName: string): string {
    return `agents/${agentName}.md`;
  },

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    return {
      path: `agents/${spec.id}.md`,
      contents: generateClaudeAgentMarkdown(spec),
    };
  },

  validateSupport(spec: AgentSpec): ValidationResult {
    for (const cap of spec.capabilities) {
      if (CLAUDE_SUPPORT_LEVELS[cap] === 'unsupported') {
        return {
          ok: false,
          reason: `Claude runtime does not support capability '${cap}'`,
          fixHint: `Remove '${cap}' from the spec's capabilities, or dispatch this agent to a different runtime.`,
        };
      }
    }
    return { ok: true };
  },
};
