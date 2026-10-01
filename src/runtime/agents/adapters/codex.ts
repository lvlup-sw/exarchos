/**
 * Codex `RuntimeAdapter`. It lowers an `AgentSpec` into a Codex CLI agent TOML file
 * at `.codex/agents/<name>.toml`. The format requires `name`, `description` and
 * `developer_instructions`. This adapter also emits `sandbox_mode` and, when needed, `mcp_servers`.
 *
 * Codex CLI issues openai/codex#15250 and openai/codex#14579 can stop a tool-backed
 * session from invoking a custom agent by name. The adapter still writes the TOML file
 * and sets `customAgentResolutionWorks` to `false`.
 */

import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

/**
 * Codex support levels. `isolation:worktree` and `session:resume` are advisory.
 * The Claude-only signal and Agent Teams capabilities are unsupported.
 * All other capabilities are native.
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
 * Render a TOML multi-line basic string. The triple-quoted form keeps newlines.
 * The function escapes backslashes and each literal triple quote, so the body
 * cannot end the string early.
 */
function tomlMultilineString(value: string): string {
  const safe = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `"""\n${safe}\n"""`;
}

/** Render a TOML inline array of basic strings. */
function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlBasicString).join(', ')}]`;
}

/**
 * Derive the Codex `sandbox_mode` from the capabilities of the spec.
 * Codex has no per-tool allowlist, so `sandbox_mode` is the only structural gate.
 * If the capabilities include `fs:write` or `shell:exec`, the mode is `workspace-write`.
 * If not, the mode is `read-only`.
 * Without this derivation, a read-only reviewer and a write-capable implementer
 * get the same sandbox, and the read-only limit of the reviewer is prose only.
 */
function deriveCodexSandboxMode(spec: AgentSpec): 'read-only' | 'workspace-write' {
  const caps = resolveCapabilities(spec.posture, spec.id);
  if (caps.has('fs:write') || caps.has('shell:exec')) {
    return 'workspace-write';
  }
  return 'read-only';
}

/**
 * Compose the `developer_instructions` body: the system prompt of the agent,
 * then a list of its capabilities, so the model knows which tools to expect.
 */
function renderDeveloperInstructions(spec: AgentSpec): string {
  const resolved = resolveCapabilities(spec.posture, spec.id);
  const capabilityLines = [...resolved].map((cap) => `- ${cap}`).join('\n');
  return [
    spec.systemPrompt,
    '',
    '## Declared capabilities',
    capabilityLines,
  ].join('\n');
}

/**
 * Lower `spec` into the Codex TOML file. The capability-derived `sandbox_mode` keeps
 * Codex off a session default that gives more access than the spec allows.
 * `mcp:exarchos` and `mcp:exarchos:readonly` give the same `mcp_servers` entry,
 * because Codex has no per-action grant. The server enforces the read-only tier.
 */
function lowerSpec(spec: AgentSpec): { path: string; contents: string } {
  const path = `.codex/agents/${spec.id}.toml`;

  const lines: string[] = [];
  lines.push(`name = ${tomlBasicString(spec.id)}`);
  lines.push(`description = ${tomlBasicString(spec.description)}`);
  lines.push(
    `developer_instructions = ${tomlMultilineString(renderDeveloperInstructions(spec))}`,
  );

  lines.push(`sandbox_mode = ${tomlBasicString(deriveCodexSandboxMode(spec))}`);

  const resolved = resolveCapabilities(spec.posture, spec.id);
  if (spec.mcpServers && spec.mcpServers.length > 0) {
    lines.push(`mcp_servers = ${tomlStringArray([...spec.mcpServers])}`);
  } else if (
    resolved.has('mcp:exarchos') ||
    resolved.has('mcp:exarchos:readonly')
  ) {
    lines.push(`mcp_servers = ${tomlStringArray(['exarchos'])}`);
  }

  return { path, contents: `${lines.join('\n')}\n` };
}

function validateSupport(spec: AgentSpec): ValidationResult {
  for (const cap of resolveCapabilities(spec.posture, spec.id)) {
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
 * Codex adapter. `customAgentResolutionWorks` stays `false` until Codex CLI fixes
 * openai/codex#15250 and openai/codex#14579. To match the flag, `SPAWN_AGENT_CALL` in
 * `content/harness/runtimes/codex.yaml` dispatches with an inline prompt, not by agent name.
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
