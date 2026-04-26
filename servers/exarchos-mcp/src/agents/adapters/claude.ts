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
import { generateAgentMarkdown } from '../generate-cc-agents.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

/**
 * Claude is the reference runtime: every capability the spec model
 * defines today is `native`. Task 7a will reify this in
 * `runtimes/claude.yaml`.
 */
const CLAUDE_SUPPORT_LEVELS = buildSupportMap('native');

export const claudeAdapter: RuntimeAdapter = {
  runtime: 'claude',
  supportLevels: CLAUDE_SUPPORT_LEVELS,

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
      if (CLAUDE_SUPPORT_LEVELS[cap] === 'unsupported') {
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
