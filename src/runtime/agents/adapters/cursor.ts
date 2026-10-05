/**
 * The Cursor runtime adapter. It lowers an `AgentSpec` into the Cursor 2.5+ custom-agent format: Markdown
 * with YAML frontmatter at the project path `.cursor/agents/<name>.md`. See https://cursor.com/docs/subagents.
 *
 * The frontmatter holds `name`, `description`, `model` (always `inherit`), `readonly` (true when the spec
 * lacks `fs:write`), `is_background`, and an optional `mcp` map.
 *
 * Cursor has no worktree isolation mode like the one in Claude, so `isolation:worktree` is advisory. A spec
 * with it lowers with no error, but Cursor does not enforce the worktree boundary. A caller that needs strict
 * isolation must target Claude.
 */

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

/**
 * Cursor supports the file, shell, subagent-spawn, and MCP capabilities natively. `isolation:worktree` is
 * advisory: Cursor does not enforce it, and the orchestrator still manages the worktrees. Claude-only
 * primitives are unsupported.
 */
const CURSOR_SUPPORT_LEVELS = buildSupportMap('native', {
  'isolation:worktree': 'advisory',
  'session:resume': 'advisory',
  'subagent:completion-signal': 'unsupported',
  'subagent:start-signal': 'unsupported',
  'team:agent-teams': 'unsupported',
});

function agentFilePath(agentName: string): string {
  return `.cursor/agents/${agentName}.md`;
}

/**
 * Frontmatter of `.cursor/agents/<id>.md`. The optional `mcp` field enables MCP servers per agent, in the
 * same shape as the OpenCode adapter.
 */
interface CursorFrontmatter {
  name: string;
  description: string;
  model: 'inherit';
  readonly: boolean;
  is_background: boolean;
  mcp?: Record<string, true>;
}

/**
 * Removes the `## Worktree Hygiene` block from a system prompt for a runtime with advisory isolation. Its
 * per-command `git -C` and `npm --prefix` rules assume that the runtime puts the agent in `.worktrees/`, and
 * advisory isolation does not.
 *
 * The `## Worktree Verification` block stays. Without that cwd check, a subagent that starts in the parent
 * repo writes to the wrong directory. The match starts at the exact H2 heading and stops at the next H2, so
 * a renamed heading removes nothing. The specs in `definitions.ts` keep both blocks.
 */
function stripAdvisoryWorktreeGuard(systemPrompt: string): string {
  const pattern = /(?:^|\n)## Worktree Hygiene[^\n]*\n[\s\S]*?(?=\n## |\n?$)/g;
  return systemPrompt.replace(pattern, '');
}

/**
 * Lowers a spec to a Cursor agent file. Both `mcp:exarchos` and `mcp:exarchos:readonly` enable the
 * `exarchos` server, and the action allowlist gate in `dispatch/core/dispatch.ts` enforces the readonly tier.
 * Because `isolation:worktree` is advisory, the prompt loses its worktree hygiene block.
 */
function lowerSpec(spec: AgentSpec): { path: string; contents: string } {
  const resolved = resolveCapabilities(spec.posture, spec.id);
  const readonly = !resolved.has('fs:write');

  const frontmatter: CursorFrontmatter = {
    name: spec.id,
    description: spec.description,
    model: 'inherit',
    readonly,
    is_background: false,
  };

  if (
    resolved.has('mcp:exarchos') ||
    resolved.has('mcp:exarchos:readonly')
  ) {
    frontmatter.mcp = { exarchos: true };
  }

  const renderedPrompt =
    CURSOR_SUPPORT_LEVELS['isolation:worktree'] === 'advisory'
      ? stripAdvisoryWorktreeGuard(spec.systemPrompt)
      : spec.systemPrompt;

  const yaml = stringifyYaml(frontmatter).trimEnd();
  const contents = `---\n${yaml}\n---\n${renderedPrompt}`;

  return { path: agentFilePath(spec.id), contents };
}

function validateSupport(spec: AgentSpec): ValidationResult {
  const resolved = resolveCapabilities(spec.posture, spec.id);
  const unsupported: Capability[] = [...resolved].filter(
    (cap) => CURSOR_SUPPORT_LEVELS[cap] === 'unsupported',
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `Cursor runtime does not support capabilities: ${unsupported.join(', ')}`,
      fixHint: `Adjust the spec's posture (or per-agent overlay in capabilities/posture-mapping.ts) so ${unsupported.map((c) => `'${c}'`).join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} no longer resolved for Cursor, or dispatch to a runtime that supports ${unsupported.length === 1 ? 'it' : 'them'} (e.g. claude).`,
    };
  }
  return { ok: true };
}

export const CursorAdapter: RuntimeAdapter = {
  runtime: 'cursor',
  supportLevels: CURSOR_SUPPORT_LEVELS,
  agentFilePath,
  lowerSpec,
  validateSupport,
};
