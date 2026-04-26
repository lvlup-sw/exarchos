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
//   mcp:exarchos                → `mcp__exarchos` (and `mcp` config block)
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

/**
 * Capabilities the Copilot runtime supports natively. These appear as
 * tool names in the lowered frontmatter.
 */
const SUPPORTED_CAPABILITIES: readonly Capability[] = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'mcp:exarchos',
];

/**
 * Capabilities accepted as advisory: tolerated without error but emit no
 * tool entry and no frontmatter field. Per the design's capability table,
 * Copilot has no native primitive for these but does not need to reject
 * them either — they degrade gracefully.
 *   - `isolation:worktree`: Exarchos manages worktree fan-out at the
 *     orchestrator layer regardless of runtime support.
 *   - `session:resume`: Copilot has no `agentId` resume; downstream fixer
 *     flows handle this conditionally elsewhere.
 */
const ADVISORY_CAPABILITIES: readonly Capability[] = [
  'isolation:worktree',
  'session:resume',
];

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
  mcp?: Record<string, { enabled: true }>;
}

export class CopilotAdapter implements RuntimeAdapter {
  readonly runtime = 'copilot' as const;

  agentFilePath(agentName: string): string {
    return `.github/agents/${agentName}.agent.md`;
  }

  validateSupport(spec: AgentSpec): ValidationResult {
    for (const cap of spec.capabilities) {
      if (!SUPPORTED_CAPABILITIES.includes(cap) && !ADVISORY_CAPABILITIES.includes(cap)) {
        return {
          ok: false,
          reason: `Copilot runtime does not support capability '${cap}'`,
          fixHint:
            `Either remove '${cap}' from the spec, exclude Copilot from this spec's targets, ` +
            `or add the capability to Copilot's supportedCapabilities once the runtime gains it.`,
        };
      }
    }
    return { ok: true };
  }

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    const tools: string[] = [];
    for (const cap of spec.capabilities) {
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

    // Emit `mcp` config block when the spec declares mcp:exarchos.
    if (spec.capabilities.includes('mcp:exarchos')) {
      frontmatter.mcp = { exarchos: { enabled: true } };
    }

    const yamlBlock = stringifyYaml(frontmatter).trimEnd();
    const contents = `---\n${yamlBlock}\n---\n\n${spec.systemPrompt}\n`;

    return { path: this.agentFilePath(spec.id), contents };
  }
}
