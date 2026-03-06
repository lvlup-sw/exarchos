import { registerWorkflowType, unregisterWorkflowType } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import type { ExarchosConfig, WorkflowDefinition } from './define.js';

// Re-export for consumers that imported from here
export type { ExarchosConfig, WorkflowDefinition };

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

  const registeredWorkflows: string[] = [];
  const extendedTypes: string[] = [];
  const registeredGuardKeys: string[] = [];

  try {
    for (const [name, definition] of Object.entries(config.workflows)) {
      registerWorkflowType(name, definition);
      registeredWorkflows.push(name);

      extendWorkflowTypeEnum(name);
      extendedTypes.push(name);

      // Register guards if present
      if (definition.guards) {
        for (const [guardId, guardDef] of Object.entries(definition.guards)) {
          const key = `${name}:${guardId}`;
          guardRegistry.set(key, guardDef);
          registeredGuardKeys.push(key);
        }
      }
    }
  } catch (error) {
    // Rollback: undo all registrations to prevent partial state
    for (const key of registeredGuardKeys) {
      guardRegistry.delete(key);
    }
    for (const name of extendedTypes) {
      unextendWorkflowTypeEnum(name);
    }
    for (const name of registeredWorkflows) {
      unregisterWorkflowType(name);
    }
    throw new Error(
      `Failed to register custom workflows: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
