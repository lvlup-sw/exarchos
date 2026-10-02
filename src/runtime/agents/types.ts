/**
 * Shape of the agent specs for subagent dispatch. A spec declares a `posture`
 * trust tier, and `resolveCapabilities` in
 * `src/workflow/capabilities/posture-mapping.ts` derives the effective
 * capabilities from the posture and the agent id. Runtime tool names belong in
 * the adapters, which call the resolver at render time.
 */

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

/** The canonical capability postures. */
export type AgentPosture = 'read-only' | 'task-isolated' | 'shared-mutating';

/** Complete specification for a subagent. */
export interface AgentSpec {
  readonly id: AgentSpecId;
  readonly description: string;
  readonly systemPrompt: string;
  /**
   * Capability posture, the declared source of the capabilities of the spec.
   * The resolver derives the effective set from the posture and the agent id,
   * and then adds the runtime handshake.
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
