import { registerWorkflowType } from '../workflow/state-machine.js';
import type { WorkflowDefinition } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum } from '../workflow/schemas.js';

// ─── Config Types ───────────────────────────────────────────────────────────

export interface ExarchosConfig {
  workflows?: Record<string, WorkflowDefinition>;
}

// ─── Guard Registry ─────────────────────────────────────────────────────────

const guardRegistry = new Map<string, { command: string; timeout?: number; description?: string }>();

export function getRegisteredGuard(
  guardId: string,
): { command: string; timeout?: number; description?: string } | undefined {
  return guardRegistry.get(guardId);
}

export function getRegisteredGuards(): ReadonlyMap<
  string,
  { command: string; timeout?: number; description?: string }
> {
  return guardRegistry;
}

/**
 * Clear all registered custom guards. Used for test cleanup.
 */
export function clearRegisteredGuards(): void {
  guardRegistry.clear();
}

// ─── Registration Pipeline ──────────────────────────────────────────────────

/**
 * Register all custom workflows from an ExarchosConfig.
 * For each workflow: registers the HSM definition, extends the type schema,
 * and stores any guard definitions.
 */
export function registerCustomWorkflows(config: ExarchosConfig): void {
  if (!config.workflows) return;

  for (const [name, definition] of Object.entries(config.workflows)) {
    registerWorkflowType(name, definition);
    extendWorkflowTypeEnum(name);

    // Register guards if present
    if (definition.guards) {
      for (const [guardId, guardDef] of Object.entries(definition.guards)) {
        guardRegistry.set(`${name}:${guardId}`, guardDef);
      }
    }
  }
}
