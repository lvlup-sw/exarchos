// ─── Agent Spec Types ──────────────────────────────────────────────────────
//
// Defines the shape of agent specifications for subagent dispatch. Specs
// declare a `posture` (DR-6 trust tier); the capability resolver
// (`capabilities/posture-mapping.ts:resolveCapabilities`) derives the
// effective capability set from posture + agentId. Runtime tool naming
// (e.g. Claude tool arrays) belongs in adapters, which call the resolver
// at render time.
//
// v2.10-preview.1 (#1333): the legacy runtime-interface field
// `capabilities: readonly Capability[]` was dropped — the resolver is the
// single source of truth.
//
// See docs/designs/archive/2026-04-25-delegation-runtime-parity.md §3 and
// docs/designs/archive/2026-05-09-v2-10-0-preview-1-substrate-stabilization.md.
// ────────────────────────────────────────────────────────────────────────────

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
   * Capability posture (DR-6). The single declarative authority on a
   * spec's capability surface; the resolver derives the effective
   * capability set from posture + agentId, then layers the runtime
   * handshake on top.
   */
  readonly posture: AgentPosture;
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
