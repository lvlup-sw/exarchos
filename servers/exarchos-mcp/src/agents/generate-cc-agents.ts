// ─── CC Agent File Generator ────────────────────────────────────────────────
//
// Build-time tool that generates Claude Code agent definition (.md) files
// from the agent spec registry. Each generated file contains YAML frontmatter
// and a system prompt body.
// ────────────────────────────────────────────────────────────────────────────

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentSpec, AgentValidationRule } from './types.js';
import { ALL_AGENT_SPECS } from './definitions.js';

// ─── Trigger-to-Matcher Mapping ─────────────────────────────────────────────

const TRIGGER_MAP: Record<string, { hookType: string; matcher: string }> = {
  'pre-write': { hookType: 'PreToolUse', matcher: 'Write|Edit' },
  'pre-edit': { hookType: 'PreToolUse', matcher: 'Edit' },
  'post-test': { hookType: 'PostToolUse', matcher: 'Bash' },
};

// ─── Build Hooks from Rules ─────────────────────────────────────────────────

/**
 * Maps validation rules to CC hook format.
 * Rules without a `command` property are skipped.
 */
export function buildHooksFromRules(
  rules: readonly AgentValidationRule[],
): Record<string, unknown> {
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

function escapeYamlString(value: string): string {
  // Wrap in quotes if it contains special characters
  if (value.includes(':') || value.includes('#') || value.includes('"') || value.includes("'")) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

function serializeHooksYaml(hooks: Record<string, unknown>, indent: number): string {
  const pad = ' '.repeat(indent);
  const entries = Object.entries(hooks) as [string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>][];
  let yaml = '';

  for (const [hookType, hookList] of entries) {
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
 * Generates a markdown file with YAML frontmatter + system prompt body
 * from an AgentSpec.
 */
export function generateAgentMarkdown(spec: AgentSpec): string {
  let frontmatter = '---\n';

  // Required fields
  frontmatter += `name: exarchos-${spec.id}\n`;
  frontmatter += `description: "${spec.description}"\n`;
  frontmatter += `tools: ${spec.tools.join(', ')}\n`;
  frontmatter += `model: ${spec.model}\n`;

  // Optional: disallowedTools
  if (spec.disallowedTools && spec.disallowedTools.length > 0) {
    frontmatter += `disallowedTools: ${spec.disallowedTools.join(', ')}\n`;
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

// ─── Generate All Agent Files ───────────────────────────────────────────────

/**
 * Writes all agent spec files as markdown to the output directory.
 */
export function generateAllAgentFiles(outDir: string): void {
  // Ensure output directory exists
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  for (const spec of ALL_AGENT_SPECS) {
    const markdown = generateAgentMarkdown(spec);
    const filePath = path.join(outDir, `${spec.id}.md`);
    fs.writeFileSync(filePath, markdown, 'utf-8');
  }
}
