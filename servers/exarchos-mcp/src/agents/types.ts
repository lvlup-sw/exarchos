// ─── Agent Spec Types ──────────────────────────────────────────────────────
//
// Defines the shape of agent specifications for subagent dispatch.
// Specs declare runtime-agnostic `capabilities`; runtime tool naming
// (e.g. Claude tool arrays) belongs in adapters, not here.
// See docs/designs/2026-04-25-delegation-runtime-parity.md §3.
// ────────────────────────────────────────────────────────────────────────────

import type { Capability } from './capabilities.js';

/** A skill that can be loaded into an agent's context. */
export interface AgentSkill {
  readonly name: string;
  readonly content: string;
}

/** A validation rule applied during agent execution. */
export interface AgentValidationRule {
  readonly trigger: string;
  readonly rule: string;
  readonly command?: string;
}

/** Canonical agent spec IDs. */
export type AgentSpecId = 'implementer' | 'fixer' | 'reviewer' | 'scaffolder';

/** Three canonical capability postures (DR-6 of #1259). */
export type AgentPosture = 'read-only' | 'task-isolated' | 'shared-mutating';

/** Complete specification for a subagent. */
export interface AgentSpec {
  readonly id: AgentSpecId;
  readonly description: string;
  readonly systemPrompt: string;
  /**
   * Capability posture (DR-6). Mutually exclusive with `capabilities`.
   * The resolver derives the full capability set from posture + runtime
   * handshake. Optional during the v2.10 migration window; required in
   * v2.11.0 once the legacy `capabilities[]` shape is removed.
   */
  readonly posture?: AgentPosture;
  readonly capabilities: readonly Capability[];
  readonly disallowedTools?: readonly string[];
  readonly model: 'opus' | 'sonnet' | 'haiku' | 'inherit';
  readonly effort?: 'low' | 'medium' | 'high' | 'max';
  readonly color?: string;
  readonly isolation?: 'worktree';
  readonly skills: readonly AgentSkill[];
  readonly validationRules: readonly AgentValidationRule[];
  readonly resumable: boolean;
  readonly memoryScope?: 'user' | 'project' | 'local';
  readonly maxTurns?: number;
  readonly mcpServers?: readonly string[];
}
