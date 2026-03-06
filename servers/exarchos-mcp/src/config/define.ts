// ─── Config Types ──────────────────────────────────────────────────────────

export interface ExarchosConfig {
  readonly workflows?: Record<string, WorkflowDefinition>;
}

export interface WorkflowDefinition {
  readonly extends?: string;
  readonly phases: readonly string[];
  readonly initialPhase: string;
  readonly transitions: readonly TransitionDefinition[];
  readonly guards?: Readonly<Record<string, GuardDefinition>>;
}

export interface TransitionDefinition {
  readonly from: string;
  readonly to: string;
  readonly event: string;
  readonly guard?: string;
}

export interface GuardDefinition {
  readonly command: string;
  readonly timeout?: number; // ms, default 30000
  readonly description?: string;
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
