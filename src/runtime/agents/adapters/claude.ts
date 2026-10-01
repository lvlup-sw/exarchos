/**
 * The Claude runtime adapter. It lowers a runtime-agnostic `AgentSpec` into a Claude Code agent file:
 * Markdown with YAML frontmatter.
 *
 * The snapshot suite in `generate-agents.test.ts` compares `claudeAdapter.lowerSpec` with committed
 * fixtures byte for byte. A change to a render helper here fails that test with a byte-level diff.
 */

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec, AgentValidationRule } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

/**
 * Translates the capabilities that the posture of a spec resolves to into the flat Claude `tools` array.
 * For the reviewer the order is `Read, Grep, Glob, Bash`, and for other roles it is
 * `Read, Write, Edit, Bash, Grep, Glob`. The snapshot suite pins both orders.
 *
 * `handler.ts` and `generated-drift.test.ts` call it to build the same array.
 */
export function deriveClaudeToolsFromCapabilities(spec: AgentSpec): readonly string[] {
  const caps = resolveCapabilities(spec.posture, spec.id) as ReadonlySet<string>;
  const tools: string[] = [];
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

/**
 * Maps a validation-rule trigger to a Claude hook type and tool matcher. The rules in `definitions.ts`
 * use only `pre-write` and `post-test`.
 */
const TRIGGER_MAP: Record<string, { hookType: string; matcher: string }> = {
  /** Matches each file-write tool, so an agent cannot bypass the worktree-boundary guard with `MultiEdit` or `NotebookEdit`. */
  'pre-write': { hookType: 'PreToolUse', matcher: 'Write|Edit|MultiEdit|NotebookEdit' },
  'post-test': { hookType: 'PostToolUse', matcher: 'Bash' },
};

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

/**
 * Renders an `AgentSpec` as a Claude Code agent file. `yaml.stringify` serializes the frontmatter, so the
 * YAML library escapes quotes, colons, and `$(...)` in scalar values. The field order matches the snapshot
 * fixtures. `lineWidth: 0` stops the folding of long scalars, and `PLAIN` quotes only the scalars that need it.
 *
 * `isolation` and `mcpServers` come from the resolved capabilities, not from `spec.isolation`. Both
 * `mcp:exarchos` and `mcp:exarchos:readonly` grant the whole `exarchos` server, because the agent file has
 * no per-action allowlist. `enforceReadonlyGate` in `dispatch/core/dispatch.ts` limits the readonly tier per action.
 *
 * Production callers use `claudeAdapter.lowerSpec`. Tests call this function directly.
 */
export function generateClaudeAgentMarkdown(spec: AgentSpec): string {
  const frontmatter: Record<string, unknown> = {};

  frontmatter.name = `exarchos-${spec.id}`;
  frontmatter.description = spec.description;

  frontmatter.tools = [...deriveClaudeToolsFromCapabilities(spec)];
  frontmatter.model = spec.model;

  if (spec.color) {
    frontmatter.color = spec.color;
  }

  if (spec.disallowedTools && spec.disallowedTools.length > 0) {
    frontmatter.disallowedTools = [...spec.disallowedTools];
  }

  const resolvedCaps = resolveCapabilities(spec.posture, spec.id);
  if (resolvedCaps.has('isolation:worktree')) {
    frontmatter.isolation = 'worktree';
  }

  if (spec.memoryScope) {
    frontmatter.memory = spec.memoryScope;
  }

  if (spec.maxTurns !== undefined) {
    frontmatter.maxTurns = spec.maxTurns;
  }

  if (
    resolvedCaps.has('mcp:exarchos') ||
    resolvedCaps.has('mcp:exarchos:readonly')
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

  const yamlText = stringifyYaml(frontmatter, {
    lineWidth: 0,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });

  return `---\n${yamlText}---\n\n${spec.systemPrompt}\n`;
}

/**
 * Claude is the reference runtime: every capability the spec model
 * defines today is `native`. Mirrored in `content/harness/runtimes/claude.yaml`.
 */
const CLAUDE_SUPPORT_LEVELS = buildSupportMap('native');

export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',
  supportLevels: CLAUDE_SUPPORT_LEVELS,

  agentFilePath(agentName: string): string {
    return `rendered/agents/${agentName}.md`;
  },

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    return {
      path: `rendered/agents/${spec.id}.md`,
      contents: generateClaudeAgentMarkdown(spec),
    };
  },

  validateSupport(spec: AgentSpec): ValidationResult {
    for (const cap of resolveCapabilities(spec.posture, spec.id)) {
      if (CLAUDE_SUPPORT_LEVELS[cap] === 'unsupported') {
        return {
          ok: false,
          reason: `Claude runtime does not support capability '${cap}'`,
          fixHint: `Adjust the spec's posture (or per-agent overlay in capabilities/posture-mapping.ts) so '${cap}' is no longer resolved for Claude, or dispatch this agent to a runtime that supports it.`,
        };
      }
    }
    return { ok: true };
  },
};
