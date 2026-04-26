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

/**
 * Maps validation rules to the Claude hook format.
 * Rules without a `command` property are skipped.
 */
function buildHooksFromRules(
  rules: readonly AgentValidationRule[],
): Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> {
  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};

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

// ─── YAML Serialization Helpers ─────────────────────────────────────────────

function serializeHooksYaml(
  hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>>,
  indent: number,
): string {
  const pad = ' '.repeat(indent);
  let yaml = '';

  for (const [hookType, hookList] of Object.entries(hooks)) {
    yaml += `${pad}${hookType}:\n`;
    for (const hookEntry of hookList) {
      yaml += `${pad}  - matcher: "${hookEntry.matcher}"\n`;
      yaml += `${pad}    hooks:\n`;
      for (const h of hookEntry.hooks) {
        yaml += `${pad}      - type: ${h.type}\n`;
        yaml += `${pad}        command: "${h.command}"\n`;
      }
    }
  }

  return yaml;
}

// ─── Generate Agent Markdown ────────────────────────────────────────────────

/**
 * Renders an `AgentSpec` as a Claude Code agent definition file
 * (Markdown with YAML frontmatter + system prompt body). Output is
 * byte-pinned by `generate-agents.test.ts`'s snapshot regression suite.
 *
 * Exported so `generated-drift.test.ts` can assert per-spec markdown
 * generation in isolation. Production callers should go through the
 * `claudeAdapter.lowerSpec` entry point below.
 */
export function generateClaudeAgentMarkdown(spec: AgentSpec): string {
  let frontmatter = '---\n';

  // Required fields
  frontmatter += `name: exarchos-${spec.id}\n`;

  // Description: multi-line uses YAML block scalar, single-line uses quoted string
  if (spec.description.includes('\n')) {
    frontmatter += 'description: |\n';
    for (const line of spec.description.split('\n')) {
      frontmatter += `  ${line}\n`;
    }
  } else {
    frontmatter += `description: "${spec.description}"\n`;
  }

  // Lower capabilities to Claude's flat `tools` array.
  const derivedTools = deriveClaudeToolsFromCapabilities(spec);
  frontmatter += `tools: [${derivedTools.map(t => `"${t}"`).join(', ')}]\n`;
  frontmatter += `model: ${spec.model}\n`;

  // Optional: color
  if (spec.color) {
    frontmatter += `color: ${spec.color}\n`;
  }

  // Optional: disallowedTools
  if (spec.disallowedTools && spec.disallowedTools.length > 0) {
    frontmatter += `disallowedTools: [${spec.disallowedTools.map(t => `"${t}"`).join(', ')}]\n`;
  }

  // Optional: isolation
  if (spec.isolation) {
    frontmatter += `isolation: ${spec.isolation}\n`;
  }

  // Optional: memory (mapped from memoryScope)
  if (spec.memoryScope) {
    frontmatter += `memory: ${spec.memoryScope}\n`;
  }

  // Optional: maxTurns
  if (spec.maxTurns !== undefined) {
    frontmatter += `maxTurns: ${spec.maxTurns}\n`;
  }

  // Optional: mcpServers (allowlist of MCP server names)
  // Distinguish undefined (inherit all) from empty array (deny all)
  if (spec.mcpServers !== undefined) {
    if (spec.mcpServers.length > 0) {
      frontmatter += `mcpServers: [${spec.mcpServers.map(s => `"${s}"`).join(', ')}]\n`;
    } else {
      frontmatter += `mcpServers: []\n`;
    }
  }

  // Optional: skills (array format)
  if (spec.skills.length > 0) {
    frontmatter += 'skills:\n';
    for (const skill of spec.skills) {
      frontmatter += `  - ${skill.name}\n`;
    }
  }

  // Optional: hooks (from validation rules)
  const hooks = buildHooksFromRules(spec.validationRules);
  if (Object.keys(hooks).length > 0) {
    frontmatter += 'hooks:\n';
    frontmatter += serializeHooksYaml(hooks, 2);
  }

  frontmatter += '---\n';

  return `${frontmatter}\n${spec.systemPrompt}\n`;
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
