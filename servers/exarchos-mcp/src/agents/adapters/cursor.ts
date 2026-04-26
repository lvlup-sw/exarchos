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
import type { Capability } from '../capabilities.js';
import type { RuntimeAdapter, ValidationResult } from './types.js';

const SUPPORTED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'fs:read',
  'fs:write',
  'shell:exec',
  'subagent:spawn',
  'mcp:exarchos',
]);

function agentFilePath(agentName: string): string {
  return `.cursor/agents/${agentName}.md`;
}

function lowerSpec(spec: AgentSpec): { path: string; contents: string } {
  const readonly = !spec.capabilities.includes('fs:write');

  const frontmatter = {
    name: spec.id,
    description: spec.description,
    model: 'inherit' as const,
    readonly,
    is_background: false,
  };

  const yaml = stringifyYaml(frontmatter).trimEnd();
  const contents = `---\n${yaml}\n---\n${spec.systemPrompt}`;

  return { path: agentFilePath(spec.id), contents };
}

function validateSupport(spec: AgentSpec): ValidationResult {
  const unsupported = spec.capabilities.filter((cap) => !SUPPORTED_CAPABILITIES.has(cap));
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
  agentFilePath,
  lowerSpec,
  validateSupport,
};
