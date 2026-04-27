// ─── Copilot RuntimeAdapter ────────────────────────────────────────────────
//
// Lowers a runtime-agnostic `AgentSpec` into a GitHub Copilot CLI custom
// agent definition file. Format: Markdown with YAML frontmatter, written
// to `.github/agents/<name>.agent.md` (project scope) — the literal
// `.agent.md` extension is required by the Copilot CLI custom-agent
// loader. Plain `.md` is not picked up.
//
// Path scope choice: project (`.github/agents/`) over user
// (`~/.copilot/agents/`). Exarchos's plugin-distribution model versions
// agent definitions with the repo, so they must live inside the project.
// User scope remains a valid alternative for hand-authored agents but is
// not what the generator produces.
//
// ── Capability → Copilot tool name mapping ─────────────────────────────────
//
// Copilot CLI custom agents declare permitted tools as an ARRAY of tool
// names (distinct from OpenCode's boolean map and Claude's PascalCase
// tool array). MCP tools follow the `mcp__<server>` namespacing
// convention; full per-tool gating uses `mcp__<server>__<tool>`.
//
// Source: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
//
//   fs:read                     → `read`
//   fs:write                    → `write`
//   shell:exec                  → `shell`
//   subagent:spawn              → `task`
//   mcp:exarchos                → `mcp__exarchos` tool entry only
//   isolation:worktree          → advisory; emits no tool entry
//   subagent:start-signal       → unsupported (Copilot has no equivalent hook)
//   subagent:completion-signal  → unsupported
//   team:agent-teams            → unsupported (Claude-only tmux primitive)
//   session:resume              → unsupported (no `agentId` resumption)
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

/**
 * Copilot covers fs/shell/subagent-spawn/MCP natively. `isolation:worktree`
 * and `session:resume` are advisory (no first-class primitive — the
 * orchestrator manages worktree fan-out, and `resumable` flows degrade
 * gracefully when no `agentId` resume is available). Claude-only signal
 * hooks and Agent Teams are unsupported.
 */
const COPILOT_SUPPORT_LEVELS = buildSupportMap('native', {
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
});

/** Capability → Copilot tool name (or `null` for advisory/non-tool). */
const CAPABILITY_TO_TOOL: Record<Capability, string | null> = {
  'fs:read': 'read',
  'fs:write': 'write',
  'shell:exec': 'shell',
  'subagent:spawn': 'task',
  'mcp:exarchos': 'mcp__exarchos',
  'isolation:worktree': null,
  'subagent:start-signal': null,
  'subagent:completion-signal': null,
  'team:agent-teams': null,
  'session:resume': null,
};

/** Frontmatter shape emitted into the `.agent.md` file. */
interface CopilotFrontmatter {
  description: string;
  tools: string[];
  model?: string;
}

export class CopilotAdapter implements RuntimeAdapter {
  readonly runtime = 'copilot' as const;
  readonly supportLevels = COPILOT_SUPPORT_LEVELS;

  agentFilePath(agentName: string): string {
    return `.github/agents/${agentName}.agent.md`;
  }

  validateSupport(spec: AgentSpec): ValidationResult {
    for (const cap of spec.capabilities) {
      if (COPILOT_SUPPORT_LEVELS[cap] === 'unsupported') {
        return {
          ok: false,
          reason: `Copilot runtime does not support capability '${cap}'`,
          fixHint:
            `Either remove '${cap}' from the spec, exclude Copilot from this spec's targets, ` +
            `or dispatch this agent to a runtime with the capability (e.g. claude).`,
        };
      }
    }
    return { ok: true };
  }

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    // Filter to native capabilities only — advisory caps are silently
    // tolerated and emit no tool entry.
    const nativeCaps = spec.capabilities.filter(
      (cap) => COPILOT_SUPPORT_LEVELS[cap] === 'native',
    );
    const tools: string[] = [];
    for (const cap of nativeCaps) {
      const tool = CAPABILITY_TO_TOOL[cap];
      if (tool !== null && tool !== undefined && !tools.includes(tool)) {
        tools.push(tool);
      }
    }

    const frontmatter: CopilotFrontmatter = {
      description: spec.description,
      tools,
    };

    if (spec.model && spec.model !== 'inherit') {
      frontmatter.model = spec.model;
    }

    // MCP server enablement is NOT declared in agent frontmatter for the
    // Copilot CLI. Servers are registered out-of-band (e.g. `gh mcp add`
    // or a shared `mcp.json`); per-agent gating happens via the
    // `mcp__<server>` tool entry already present in `tools` above.
    // The `mcp-servers:` field documented for cloud-agent custom agents
    // expects `{ type, command, args, tools, env }` — not `{ enabled }` —
    // and is not honored by the CLI loader regardless. Emitting any
    // `mcp:` block here was non-standard and silently ignored.

    const yamlBlock = stringifyYaml(frontmatter).trimEnd();
    const contents = `---\n${yamlBlock}\n---\n\n${spec.systemPrompt}\n`;

    return { path: this.agentFilePath(spec.id), contents };
  }
}
