import type { z } from 'zod';

// ─── Config Types ──────────────────────────────────────────────────────────

export interface EventDefinition {
  readonly source: 'auto' | 'model' | 'hook';
  readonly schema?: z.ZodSchema;
}

export interface ViewDefinition {
  readonly events: string[];      // Event types this view subscribes to
  readonly handler: string;       // Path to handler module (relative to project root)
}

export interface ToolActionDefinition {
  readonly name: string;
  readonly description: string;
  readonly handler: string;       // Path to handler module (relative to project root)
}

export interface ToolDefinition {
  readonly description: string;
  readonly actions: readonly ToolActionDefinition[];
}

export interface ExarchosConfig {
  readonly workflows?: Record<string, WorkflowDefinition>;
  readonly events?: Record<string, EventDefinition>;
  readonly views?: Record<string, ViewDefinition>;
  readonly tools?: Record<string, ToolDefinition>;
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
