// ─── Codex RuntimeAdapter ──────────────────────────────────────────────────
//
// Lowers `AgentSpec` values into Codex CLI custom-agent TOML files at
// `.codex/agents/<name>.toml`. Codex's custom-agent format requires
// top-level `name`, `description`, and `developer_instructions`; optional
// fields include `model`, `reasoning_effort`, `sandbox_mode`, and
// `mcp_servers`.
//
// Capability support: Codex covers fs/shell/subagent-spawn/MCP/worktree
// isolation, but does NOT support Claude-specific Agent Teams or the
// Claude completion-signal/start-signal hooks.
//
// Name-resolution caveat: Codex upstream issues #15250 and #14579 mean
// custom agents in `.codex/agents/` may not be invocable by name from
// tool-backed sessions. The adapter still emits the TOML file (so the
// artifact is correct for the future) and exposes
// `customAgentResolutionWorks = false`. The runtime YAML's
// `SPAWN_AGENT_CALL` (Task 7b) decides whether to dispatch by name or
// fall back to inline-prompt + `agent_type: "default"`.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4 and
// docs/research/2026-04-25-delegation-platform-agnosticity.md §3.
// ────────────────────────────────────────────────────────────────────────────

import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

/**
 * Codex covers fs/shell/subagent-spawn/MCP natively, treats
 * `isolation:worktree` as advisory (orchestrator-managed), and rejects
 * Claude-only primitives (Agent Teams, signal hooks, session:resume).
 */
const CODEX_SUPPORT_LEVELS = buildSupportMap('native', {
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
});

/** Escape characters disallowed inside a TOML basic string. */
export function tomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\x08/g, '\\b')
    .replace(/\f/g, '\\f')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`;
}

/**
 * Render a TOML multi-line basic string. Triple-quoted form preserves
 * newlines verbatim; we only need to escape sequences of three-or-more
 * double quotes inside the body.
 */
function tomlMultilineString(value: string): string {
  // Escape any literal """ inside the body so it cannot terminate early.
  const safe = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `"""\n${safe}\n"""`;
}

/** Render a TOML inline array of basic strings. */
function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlBasicString).join(', ')}]`;
}

/**
 * Compose the `developer_instructions` body: the agent's system prompt
 * followed by a brief enumeration of declared capabilities so the
 * underlying model knows which platform affordances to expect.
 */
function renderDeveloperInstructions(spec: AgentSpec): string {
  const capabilityLines = spec.capabilities.map((cap) => `- ${cap}`).join('\n');
  return [
    spec.systemPrompt,
    '',
    '## Declared capabilities',
    capabilityLines,
  ].join('\n');
}

function lowerSpec(spec: AgentSpec): { path: string; contents: string } {
  const path = `.codex/agents/${spec.id}.toml`;

  const lines: string[] = [];
  lines.push(`name = ${tomlBasicString(spec.id)}`);
  lines.push(`description = ${tomlBasicString(spec.description)}`);
  lines.push(
    `developer_instructions = ${tomlMultilineString(renderDeveloperInstructions(spec))}`,
  );

  if (spec.mcpServers && spec.mcpServers.length > 0) {
    lines.push(`mcp_servers = ${tomlStringArray([...spec.mcpServers])}`);
  } else if (spec.capabilities.includes('mcp:exarchos')) {
    lines.push(`mcp_servers = ${tomlStringArray(['exarchos'])}`);
  }

  return { path, contents: `${lines.join('\n')}\n` };
}

function validateSupport(spec: AgentSpec): ValidationResult {
  for (const cap of spec.capabilities) {
    if (CODEX_SUPPORT_LEVELS[cap] === 'unsupported') {
      return {
        ok: false,
        reason: `codex does not support capability ${cap}`,
        fixHint:
          "Either remove the capability from the spec or exclude codex from the spec's runtime set.",
      };
    }
  }
  return { ok: true };
}

/**
 * Codex adapter. The `customAgentResolutionWorks` flag is consumed by the
 * runtime YAML's `SPAWN_AGENT_CALL` template (Task 7b) to decide whether
 * named-agent dispatch is reliable; until upstream resolves
 * #15250/#14579, this stays `false`.
 */
export const codexAdapter: RuntimeAdapter & {
  readonly customAgentResolutionWorks: boolean;
} = {
  runtime: 'codex',
  supportLevels: CODEX_SUPPORT_LEVELS,
  customAgentResolutionWorks: false,
  agentFilePath(agentName: string): string {
    return `.codex/agents/${agentName}.toml`;
  },
  lowerSpec,
  validateSupport,
};
