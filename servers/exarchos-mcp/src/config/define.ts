// ─── Config Types ──────────────────────────────────────────────────────────

export interface ExarchosConfig {
  workflows?: Record<string, WorkflowDefinition>;
}

export interface WorkflowDefinition {
  extends?: string;
  phases: string[];
  initialPhase: string;
  transitions: TransitionDefinition[];
  guards?: Record<string, GuardDefinition>;
}

export interface TransitionDefinition {
  from: string;
  to: string;
  event: string;
  guard?: string;
}

export interface GuardDefinition {
  command: string;
  timeout?: number; // ms, default 30000
  description?: string;
}

// ─── defineConfig Helper ───────────────────────────────────────────────────

/**
 * Identity function providing type-safety for Exarchos configuration files.
 * Use in `exarchos.config.ts`:
 *
 * ```ts
 * export default defineConfig({ workflows: { ... } });
 * ```
 */
export function defineConfig(config: ExarchosConfig): ExarchosConfig {
  return config;
}
