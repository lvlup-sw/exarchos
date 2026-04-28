// ─── Cursor RuntimeAdapter ─────────────────────────────────────────────────
//
// Lowers an AgentSpec into Cursor 2.5+ custom-agent format: Markdown with
// YAML frontmatter at `.cursor/agents/<name>.md` (project scope) or
// `~/.cursor/agents/<name>.md` (user scope). This adapter targets the
// project-scoped path.
//
// Reference: https://cursor.com/docs/subagents (Cursor 2.5, early 2026).
// Frontmatter fields:
//   - name: string                           (required)
//   - description: string                    (required)
//   - model: 'fast' | 'inherit' | <model>    (we always emit 'inherit')
//   - readonly: bool (default false)         (true → spec lacks fs:write)
//   - is_background: bool (default false)
//   - mcp?: Record<string, true>             (per-server enablement)
//
// Isolation note: Cursor does NOT have an explicit `isolation:worktree`
// mode equivalent to Claude's worktree-isolated subagents. The
// delegation-runtime-parity discovery doc records that Cursor's runtime
// does not enforce the same isolation guarantees — specs that declare
// `isolation:worktree` lower without error, but the runtime cannot
// enforce the worktree boundary at dispatch time. Validation accepts
// the capability so the adapter can still emit a usable definition;
// callers that require strict isolation should target Claude.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';

/**
 * Cursor covers fs/shell/subagent-spawn/MCP natively, treats
 * `isolation:worktree` as advisory (no first-class enforcement; orchestrator
 * still manages worktree fan-out), and rejects Claude-only primitives.
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
 * Frontmatter shape emitted into `.cursor/agents/<id>.md`. The optional
 * `mcp` field gates per-agent MCP server enablement; mirrors the shape
 * used by the OpenCode adapter.
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
 * Strip the hard "STOP if pwd doesn't contain `.worktrees/`" worktree
 * guard from a systemPrompt when the target runtime treats
 * `isolation:worktree` as advisory rather than native (Cursor's case
 * today — see CURSOR_SUPPORT_LEVELS).
 *
 * The guard lives in two known H2 subsections in the canonical specs
 * (`definitions.ts`):
 *   - `## Worktree Verification` — the startup STOP block
 *   - `## Worktree Hygiene (MANDATORY ...)` — the extended per-command rules
 *
 * Both are predicated on the runtime actually placing the agent inside
 * a `.worktrees/` path; under advisory isolation that assumption fails
 * and the guards would always trip.
 *
 * The match is conservative: anchored on the exact H2 headings and
 * stops at the next H2 (or end of string). If a future spec drops these
 * sections or renames the headings, this is a silent no-op rather than
 * an over-eager strip that clobbers unrelated content.
 *
 * The source `definitions.ts` IMPLEMENTER/SCAFFOLDER specs keep the
 * guards verbatim (Claude and other native-isolation runtimes still
 * need them).
 */
function stripAdvisoryWorktreeGuard(systemPrompt: string): string {
  const pattern = /(?:^|\n)## Worktree (?:Verification|Hygiene)[^\n]*\n[\s\S]*?(?=\n## |\n?$)/g;
  return systemPrompt.replace(pattern, '');
}

function lowerSpec(spec: AgentSpec): { path: string; contents: string } {
  const readonly = !spec.capabilities.includes('fs:write');

  const frontmatter: CursorFrontmatter = {
    name: spec.id,
    description: spec.description,
    model: 'inherit',
    readonly,
    is_background: false,
  };

  // Item 1, T09: grant the exarchos MCP server when either capability tier
  // is present. Both tiers map to the same server entry — the readonly
  // distinction is enforced server-side via the action allowlist gate
  // (see core/dispatch.ts), not at the cursor adapter layer.
  if (
    spec.capabilities.includes('mcp:exarchos') ||
    spec.capabilities.includes('mcp:exarchos:readonly')
  ) {
    frontmatter.mcp = { exarchos: true };
  }

  // Item 7, T29: Cursor treats `isolation:worktree` as advisory (see
  // CURSOR_SUPPORT_LEVELS). Strip the hard guard so the rendered
  // agent doesn't trip on a runtime that doesn't enforce worktree
  // placement.
  const renderedPrompt =
    CURSOR_SUPPORT_LEVELS['isolation:worktree'] === 'advisory'
      ? stripAdvisoryWorktreeGuard(spec.systemPrompt)
      : spec.systemPrompt;

  const yaml = stringifyYaml(frontmatter).trimEnd();
  const contents = `---\n${yaml}\n---\n${renderedPrompt}`;

  return { path: agentFilePath(spec.id), contents };
}

function validateSupport(spec: AgentSpec): ValidationResult {
  const unsupported = spec.capabilities.filter(
    (cap) => CURSOR_SUPPORT_LEVELS[cap] === 'unsupported',
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `Cursor runtime does not support capabilities: ${unsupported.join(', ')}`,
      fixHint: `Remove ${unsupported.map((c) => `'${c}'`).join(', ')} from the spec's capabilities, or dispatch to a runtime that supports them (e.g. claude).`,
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
