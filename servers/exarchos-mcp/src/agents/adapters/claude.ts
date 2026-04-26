// ─── Claude RuntimeAdapter ──────────────────────────────────────────────────
//
// Lowers a runtime-agnostic `AgentSpec` into a Claude Code agent definition
// file (Markdown with YAML frontmatter). Output is byte-identical to the
// legacy `generate-cc-agents.ts` generator (regression-critical until Task
// 14 deletes the legacy generator).
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import { generateAgentMarkdown } from '../generate-cc-agents.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';

/**
 * Capabilities that Claude Code supports. Claude is the reference runtime
 * and supports every capability the spec model defines today. Task 7a
 * will reify this list in `runtimes/claude.yaml`.
 */
const CLAUDE_SUPPORTED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'subagent:completion-signal',
  'subagent:start-signal',
  'mcp:exarchos',
  'isolation:worktree',
  'team:agent-teams',
  'session:resume',
]);

export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',

  agentFilePath(agentName: string): string {
    return `agents/${agentName}.md`;
  },

  lowerSpec(spec: AgentSpec): { path: string; contents: string } {
    // Delegate rendering to the legacy generator until Task 14 deletes it.
    // This keeps output byte-identical with the pre-rewrite agents/*.md
    // files. Task 5 will replace the legacy module with logic that lives
    // here directly.
    return {
      path: `agents/${spec.id}.md`,
      contents: generateAgentMarkdown(spec),
    };
  },

  validateSupport(spec: AgentSpec): ValidationResult {
    for (const cap of spec.capabilities) {
      if (!CLAUDE_SUPPORTED_CAPABILITIES.has(cap)) {
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
