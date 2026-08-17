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
// See docs/designs/archive/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import { stringify as stringifyYaml } from 'yaml';
import type { AgentSpec } from '../types.js';
import type { Capability } from '../capabilities.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';
import { buildSupportMap } from './support-levels.js';
import { resolveCapabilities } from '../../../workflow/capabilities/posture-mapping.js';

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
 * Strip the heavy `## Worktree Hygiene` per-command rule block from a
 * systemPrompt when the target runtime treats `isolation:worktree` as
 * advisory rather than native (Cursor's case today — see
 * CURSOR_SUPPORT_LEVELS).
 *
 * CodeRabbit #1213/#2: the lighter `## Worktree Verification` startup
 * STOP block IS retained for cursor. Operators on advisory-isolation
 * runtimes still need an explicit "verify your cwd before editing"
 * checkpoint — without it, a subagent that boots in the parent repo
 * silently writes to the wrong directory. The cursor adapter previously
 * stripped both blocks for symmetry, but the verification block has
 * value even under advisory isolation (it's a sanity check, not a hard
 * runtime invariant).
 *
 * The hygiene block (per-command `git -C` + `npm --prefix` rules) IS
 * still stripped — it depends on the runtime actually placing the
 * agent inside `.worktrees/`, and on advisory isolation that
 * assumption fails and the rules would force an unworkable command
 * style.
 *
 * The match is conservative: anchored on the exact H2 heading and
 * stops at the next H2 (or end of string). If a future spec drops the
 * section or renames the heading, this is a silent no-op rather than
 * an over-eager strip that clobbers unrelated content.
 *
 * The source `definitions.ts` IMPLEMENTER/SCAFFOLDER specs keep the
 * full guard verbatim (Claude and other native-isolation runtimes
 * still need both blocks).
 */
function stripAdvisoryWorktreeGuard(systemPrompt: string): string {
  const pattern = /(?:^|\n)## Worktree Hygiene[^\n]*\n[\s\S]*?(?=\n## |\n?$)/g;
  return systemPrompt.replace(pattern, '');
}

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

  // Item 1, T09: grant the exarchos MCP server when either capability tier
  // is present. Both tiers map to the same server entry — the readonly
  // distinction is enforced server-side via the action allowlist gate
  // (see core/dispatch.ts), not at the cursor adapter layer.
  if (
    resolved.has('mcp:exarchos') ||
    resolved.has('mcp:exarchos:readonly')
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
