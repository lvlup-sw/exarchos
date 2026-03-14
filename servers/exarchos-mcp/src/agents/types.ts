// ─── Agent Spec Types ──────────────────────────────────────────────────────
//
// Defines the shape of agent specifications for subagent dispatch.
// These types are consumed by the agent_spec handler and definitions.
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

/** Complete specification for a subagent. */
export interface AgentSpec {
  readonly id: AgentSpecId;
  readonly description: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
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
