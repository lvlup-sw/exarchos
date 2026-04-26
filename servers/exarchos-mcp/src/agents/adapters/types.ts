// ─── RuntimeAdapter port (Hexagonal/ACL) ───────────────────────────────────
//
// Defines the port that per-runtime adapters plug into. Domain-language
// `AgentSpec` values are lowered into runtime-specific agent definition
// files via `RuntimeAdapter.lowerSpec`, and runtime support for a spec's
// capabilities is checked via `validateSupport`. Concrete adapters
// (Claude, Codex, OpenCode, Cursor, Copilot) live alongside this file.
//
// See docs/designs/2026-04-25-delegation-runtime-parity.md §4.
// ────────────────────────────────────────────────────────────────────────────

import type { AgentSpec } from '../types.js';

/** Tier-1 runtime identifiers. Excludes the `generic` skill-render target. */
export type Runtime = 'claude' | 'codex' | 'opencode' | 'cursor' | 'copilot';

/** Canonical, ordered enumeration of tier-1 runtimes. */
export const RUNTIMES = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'copilot',
] as const satisfies readonly Runtime[];

/** Result of validating that a runtime supports a given spec. */
export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; fixHint: string };

/**
 * Port that all per-runtime adapters implement. Adapters translate a
 * runtime-agnostic `AgentSpec` into a runtime-specific agent definition
 * file, and gate dispatch on capability support for the target runtime.
 */
export interface RuntimeAdapter {
  /** Runtime identifier this adapter targets. */
  readonly runtime: Runtime;

  /**
   * Path (relative to repo root or user home, per runtime convention)
   * where the agent definition file is written.
   */
  agentFilePath(agentName: string): string;

  /**
   * Lower a domain-language `AgentSpec` into a runtime-specific agent
   * definition file (path + contents).
   */
  lowerSpec(spec: AgentSpec): { path: string; contents: string };

  /** Validate that this runtime supports the spec's declared capabilities. */
  validateSupport(spec: AgentSpec): ValidationResult;
}
