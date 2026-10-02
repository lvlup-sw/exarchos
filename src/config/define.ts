import type { z } from 'zod';

export interface EventDefinition {
  readonly source: 'auto' | 'model' | 'hook';
  readonly schema?: z.ZodSchema;
}

export interface ViewDefinition {
  /** The event types that this view subscribes to. */
  readonly events: string[];
  /** The path to the handler module, relative to the project root. */
  readonly handler: string;
}

export interface ToolActionDefinition {
  readonly name: string;
  readonly description: string;
  /** The path to the handler module, relative to the project root. */
  readonly handler: string;
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
  /** The timeout in milliseconds. The default is 30000. */
  readonly timeout?: number;
  readonly description?: string;
}

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
