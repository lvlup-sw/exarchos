/**
 * OpenCode `RuntimeAdapter`. It lowers an `AgentSpec` into an OpenCode agent file:
 * Markdown with YAML frontmatter at `.opencode/agents/<name>.md`.
 *
 * Shape differences from Claude:
 *   - The frontmatter sets `mode: subagent`.
 *   - `tools` is a boolean map, not an array. Each known tool is emitted with an explicit
 *     value, so a read-only spec is unambiguous.
 *   - `mcp` is a map keyed by server name, for example `{ exarchos: true }`.
 *
 * Reference: https://opencode.ubitools.com/agents/
 */

import { stringify as stringifyYaml } from 'yaml';
import type { Capability } from '../capabilities.js';
import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

/**
 * OpenCode support levels. `isolation:worktree` and `session:resume` are advisory,
 * because OpenCode has no primitive for them. The Claude-only signal and Agent Teams
 * capabilities are unsupported. All other capabilities are native.
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
  capabilities: ReadonlySet<Capability>,
): Record<ToolKey, boolean> {
  const has = (c: Capability): boolean => capabilities.has(c);
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

/**
 * Build the frontmatter for `spec`. `mcp:exarchos` and `mcp:exarchos:readonly` give the
 * same MCP entry, because the server enforces the read-only tier.
 * The model `inherit` has no OpenCode token, so the field is omitted and OpenCode uses its default.
 */
function buildFrontmatter(spec: AgentSpec): OpenCodeFrontmatter {
  const resolved = resolveCapabilities(spec.posture, spec.id);
  const fm: OpenCodeFrontmatter = {
    mode: 'subagent',
    description: spec.description,
    tools: capabilitiesToTools(resolved),
  };
  if (
    resolved.has('mcp:exarchos') ||
    resolved.has('mcp:exarchos:readonly')
  ) {
    fm.mcp = { exarchos: true };
  }
  if (spec.model && spec.model !== 'inherit') {
    fm.model = spec.model;
  }
  return fm;
}

/**
 * Build the agent file. OpenCode reads the Markdown body as the system prompt.
 * The body starts with the spec description, so the body also says when to use the agent.
 */
function buildContents(spec: AgentSpec): string {
  const fm = buildFrontmatter(spec);
  const yaml = stringifyYaml(fm).trimEnd();
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
    const resolved = resolveCapabilities(spec.posture, spec.id);
    const unsupported: Capability[] = [...resolved].filter(
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
