// ─── OpenCode RuntimeAdapter ───────────────────────────────────────────────
//
// Lowers domain `AgentSpec` values into OpenCode's custom-agent file
// format: Markdown with YAML frontmatter at `.opencode/agents/<name>.md`.
//
// Key shape differences vs Claude:
//   • `mode: subagent` (vs Claude's no-mode default; `mode: main` is for
//     primary agents).
//   • `tools` is a **boolean object/map**, not an array. Each known tool is
//     emitted explicitly (true if the spec's capabilities cover it, false
//     otherwise) so reviewer-style read-only specs are unambiguous.
//   • `mcp` is an object map keyed by server name, e.g. `{ exarchos: true }`.
//
// Reference: https://opencode.ubitools.com/agents/ and
// docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { stringify as stringifyYaml } from 'yaml';
import type { Capability } from '../capabilities.js';
import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

/**
 * OpenCode covers fs/shell/subagent-spawn/MCP natively, treats
 * `isolation:worktree` and `session:resume` as advisory (orchestrator-
 * managed for worktree; expressible in prose for resume but without a
 * native primitive), and rejects Claude-only signaling primitives
 * (Agent Teams, signal hooks).
 */
const OPENCODE_SUPPORT_LEVELS = buildSupportMap('native', {
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
});

/** Canonical list of OpenCode tool keys we explicitly emit. */
const KNOWN_TOOLS = [
  'read',
  'list',
  'glob',
  'grep',
  'write',
  'edit',
  'bash',
] as const;

type ToolKey = (typeof KNOWN_TOOLS)[number];

/** Map a capability set to OpenCode's `tools` boolean map. */
function capabilitiesToTools(
  capabilities: readonly Capability[],
): Record<ToolKey, boolean> {
  const has = (c: Capability): boolean => capabilities.includes(c);
  const tools: Record<ToolKey, boolean> = {
    read: false,
    list: false,
    glob: false,
    grep: false,
    write: false,
    edit: false,
    bash: false,
  };
  if (has('fs:read')) {
    tools.read = true;
    tools.list = true;
    tools.glob = true;
    tools.grep = true;
  }
  if (has('fs:write')) {
    tools.write = true;
    tools.edit = true;
  }
  if (has('shell:exec')) {
    tools.bash = true;
  }
  return tools;
}

interface OpenCodeFrontmatter {
  mode: 'subagent';
  description: string;
  tools: Record<ToolKey, boolean>;
  mcp?: Record<string, true>;
  model?: string;
}

function buildFrontmatter(spec: AgentSpec): OpenCodeFrontmatter {
  const fm: OpenCodeFrontmatter = {
    mode: 'subagent',
    description: spec.description,
    tools: capabilitiesToTools(spec.capabilities),
  };
  if (spec.capabilities.includes('mcp:exarchos')) {
    fm.mcp = { exarchos: true };
  }
  // `inherit` means "use the host session's current model" — OpenCode
  // has no equivalent token, so omit the field and let the runtime pick
  // its default. Concrete model names (e.g. `sonnet`) pass through.
  if (spec.model && spec.model !== 'inherit') {
    fm.model = spec.model;
  }
  return fm;
}

function buildContents(spec: AgentSpec): string {
  const fm = buildFrontmatter(spec);
  const yaml = stringifyYaml(fm).trimEnd();
  // OpenCode reads the markdown body as the agent's system prompt. We
  // prepend the spec's description so dispatch context (when to use this
  // agent) is preserved in the body even though `description` is also
  // in frontmatter — keeps a single source of behavioral intent for
  // models that primarily attend to the body.
  const parts = [spec.description.trim()];
  if (spec.systemPrompt.trim().length > 0) {
    parts.push(spec.systemPrompt.trim());
  }
  const body = parts.join('\n\n');
  return `---\n${yaml}\n---\n${body}\n`;
}

export const OpenCodeAdapter: RuntimeAdapter = {
  runtime: 'opencode',
  supportLevels: OPENCODE_SUPPORT_LEVELS,

  agentFilePath(agentName: string): string {
    return `.opencode/agents/${agentName}.md`;
  },

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    return {
      path: OpenCodeAdapter.agentFilePath(spec.id),
      contents: buildContents(spec),
    };
  },

  validateSupport(spec: AgentSpec): ValidationResult {
    const unsupported = spec.capabilities.filter(
      (c) => OPENCODE_SUPPORT_LEVELS[c] === 'unsupported',
    );
    if (unsupported.length === 0) {
      return { ok: true };
    }
    return {
      ok: false,
      reason: `OpenCode does not support capabilities: ${unsupported.join(', ')}`,
      fixHint:
        'Remove the listed capabilities from the spec, or dispatch this agent on a runtime that supports them (e.g. claude for completion-signal hooks).',
    };
  },
};
