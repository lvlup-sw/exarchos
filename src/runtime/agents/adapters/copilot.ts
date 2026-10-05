/**
 * The Copilot `RuntimeAdapter`. It lowers an `AgentSpec` into a GitHub Copilot
 * CLI custom agent file at `.github/agents/<name>.agent.md`, as Markdown with
 * YAML frontmatter. The Copilot loader reads only the `.agent.md` extension.
 * The file is at project scope, because the repo versions agent definitions.
 *
 * Copilot declares the allowed tools as an array of names. Both `mcp:exarchos`
 * and `mcp:exarchos:readonly` map to `mcp__exarchos`, because the array has no
 * per-action grant. The readonly gate in dispatch enforces the readonly tier.
 * Format reference:
 * https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/create-custom-agents-for-cli
 */

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

/**
 * Copilot supports fs, shell, subagent spawn and MCP natively. Worktree
 * isolation and session resume are advisory, because the orchestrator manages
 * worktrees and Copilot has no `agentId` resume. The signal hooks and Agent
 * Teams are unsupported.
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
  'mcp:exarchos:readonly': 'mcp__exarchos',
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
    for (const cap of resolveCapabilities(spec.posture, spec.id)) {
      if (COPILOT_SUPPORT_LEVELS[cap] === 'unsupported') {
        return {
          ok: false,
          reason: `Copilot runtime does not support capability '${cap}'`,
          fixHint:
            `Adjust the spec's posture (or per-agent overlay in capabilities/posture-mapping.ts) so '${cap}' ` +
            `is no longer resolved for Copilot, exclude Copilot from this spec's targets, ` +
            `or dispatch this agent to a runtime that supports it (e.g. claude).`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * Write a tool entry only for a native capability. The frontmatter declares no
   * MCP servers, because the Copilot CLI registers servers outside the agent
   * file and its loader ignores an `mcp-servers` block. The `mcp__<server>` tool
   * entry gates a server for each agent.
   */
  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    const resolved = resolveCapabilities(spec.posture, spec.id);
    const nativeCaps: Capability[] = [...resolved].filter(
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

    const yamlBlock = stringifyYaml(frontmatter).trimEnd();
    const contents = `---\n${yamlBlock}\n---\n\n${spec.systemPrompt}\n`;

    return { path: this.agentFilePath(spec.id), contents };
  }
}
