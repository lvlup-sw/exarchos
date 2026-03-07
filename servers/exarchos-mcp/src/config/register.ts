import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerWorkflowType, unregisterWorkflowType } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import { ViewRegistry } from '../views/registry.js';
import type { ViewProjection } from '../views/materializer.js';
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
 * Topologically sort workflow entries so parents register before children.
 * Workflows extending built-in types have no sibling dependency and sort first.
 */
function topoSortWorkflows(
  workflows: Record<string, WorkflowDefinition>,
): [string, WorkflowDefinition][] {
  const entries = Object.entries(workflows);
  const nameSet = new Set(entries.map(([n]) => n));
  const sorted: [string, WorkflowDefinition][] = [];
  const visited = new Set<string>();

  function visit(name: string): void {
    if (visited.has(name)) return;
    visited.add(name);
    const def = workflows[name];
    // If extends a sibling, visit parent first
    if (def.extends && nameSet.has(def.extends)) {
      visit(def.extends);
    }
    sorted.push([name, def]);
  }

  for (const [name] of entries) {
    visit(name);
  }
  return sorted;
}

/**
 * Register all custom workflows from an ExarchosConfig.
 * For each workflow: registers the HSM definition, extends the type schema,
 * and stores any guard definitions. Workflows are topologically sorted so
 * parents register before children that extend them.
 */
export function registerCustomWorkflows(config: ExarchosConfig): void {
  if (!config.workflows) return;

  const registeredWorkflows: string[] = [];
  const extendedTypes: string[] = [];
  const registeredGuardKeys: string[] = [];

  try {
    for (const [name, definition] of topoSortWorkflows(config.workflows)) {
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

// ─── View Registry ──────────────────────────────────────────────────────────

const viewRegistry = new ViewRegistry();

export function getViewRegistry(): ViewRegistry {
  return viewRegistry;
}

/**
 * Clear all registered custom views. Used for test cleanup.
 */
export function clearRegisteredViews(): void {
  for (const name of viewRegistry.getCustomViewNames()) {
    viewRegistry.unregisterCustomView(name);
  }
}

/**
 * Validates that a dynamically imported handler module conforms to
 * the ViewProjection interface (exports `init()` and `apply()`).
 */
function validateViewHandler(mod: unknown, handlerPath: string): ViewProjection<unknown> {
  const module = mod as Record<string, unknown>;

  // Support both default export and named exports
  const target = (
    module.default && typeof module.default === 'object'
      ? module.default as Record<string, unknown>
      : module
  );

  if (typeof target.init !== 'function') {
    throw new Error(
      `View handler at "${handlerPath}" does not export an init() function`,
    );
  }
  if (typeof target.apply !== 'function') {
    throw new Error(
      `View handler at "${handlerPath}" does not export an apply() function`,
    );
  }

  return target as unknown as ViewProjection<unknown>;
}

/**
 * Register all custom views from an ExarchosConfig.
 * Loads handler modules via dynamic import, validates they conform to
 * ViewProjection, and registers them with the view registry.
 * Includes rollback on failure.
 */
export async function registerCustomViews(
  config: ExarchosConfig,
  projectRoot: string,
): Promise<void> {
  if (!config.views) return;

  const registeredViewNames: string[] = [];

  try {
    for (const [name, definition] of Object.entries(config.views)) {
      const handlerPath = path.resolve(projectRoot, definition.handler);
      const handlerUrl = pathToFileURL(handlerPath).href;

      let mod: unknown;
      try {
        mod = await import(handlerUrl);
      } catch (err) {
        throw new Error(
          `Failed to load view handler for "${name}" at "${handlerPath}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      const projection = validateViewHandler(mod, handlerPath);
      viewRegistry.registerCustomView(name, projection);
      registeredViewNames.push(name);
    }
  } catch (error) {
    // Rollback: unregister all views registered so far
    for (const name of registeredViewNames) {
      try {
        viewRegistry.unregisterCustomView(name);
      } catch {
        // Ignore rollback errors
      }
    }
    throw new Error(
      `Failed to register custom views: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
