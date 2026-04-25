import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { registerWorkflowType, unregisterWorkflowType } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import { registerEventType, unregisterEventType } from '../event-store/schemas.js';
import { ViewRegistry } from '../views/registry.js';
import { registerCustomTool, unregisterCustomTool, setCustomToolActionHandler, ALL_PHASES } from '../registry.js';
import type { CompositeTool, ToolAction } from '../registry.js';
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
 * Register all custom workflows and events from an ExarchosConfig.
 * For each workflow: registers the HSM definition, extends the type schema,
 * and stores any guard definitions. Workflows are topologically sorted so
 * parents register before children that extend them.
 * For each event: registers the event type with source and optional schema.
 * On any failure, all registrations are rolled back to prevent partial state.
 */
export function registerCustomWorkflows(config: ExarchosConfig): void {
  if (!config.workflows && !config.events) return;

  const registeredWorkflows: string[] = [];
  const extendedTypes: string[] = [];
  const registeredGuardKeys: string[] = [];
  const registeredEvents: string[] = [];

  try {
    // Register workflows
    if (config.workflows) {
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
    }

    // Register events
    if (config.events) {
      for (const [name, eventDef] of Object.entries(config.events)) {
        registerEventType(name, eventDef);
        registeredEvents.push(name);
      }
    }
  } catch (error) {
    // Rollback: undo all registrations to prevent partial state
    for (const name of registeredEvents) {
      unregisterEventType(name);
    }
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

// ─── Tool Registry (Config-Driven) ──────────────────────────────────────────

const registeredToolNames: string[] = [];

/**
 * Clear all registered custom tools from config. Used for test cleanup.
 */
export function clearRegisteredTools(): void {
  for (const name of registeredToolNames) {
    try {
      unregisterCustomTool(name);
    } catch {
      // Ignore if already unregistered
    }
  }
  registeredToolNames.length = 0;
}

/**
 * Validates that a dynamically imported tool action handler module exports
 * a `handle()` function. Returns the handler function.
 */
function validateToolActionHandler(
  mod: unknown,
  handlerPath: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const module = mod as Record<string, unknown>;

  // Support both default export and named exports
  const target = (
    module.default && typeof module.default === 'object'
      ? module.default as Record<string, unknown>
      : module
  );

  // Support default export as function or object with handle()
  if (typeof module.default === 'function') {
    return module.default as (args: Record<string, unknown>) => Promise<unknown>;
  }

  if (typeof target.handle !== 'function') {
    throw new Error(
      `Tool action handler at "${handlerPath}" does not export a handle() function`,
    );
  }

  return target.handle as (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Register all custom tools from an ExarchosConfig.
 * Loads handler modules via dynamic import, builds CompositeTool objects,
 * and registers them via registerCustomTool().
 * Includes rollback on failure.
 */
export async function registerCustomTools(
  config: ExarchosConfig,
  projectRoot: string,
): Promise<void> {
  if (!config.tools) return;

  const registeredNames: string[] = [];

  try {
    for (const [toolName, toolDef] of Object.entries(config.tools)) {
      const actions: ToolAction[] = [];
      const pendingHandlers: Array<{ actionName: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> = [];

      for (const actionDef of toolDef.actions) {
        const handlerPath = path.resolve(projectRoot, actionDef.handler);
        const handlerUrl = pathToFileURL(handlerPath).href;

        let mod: unknown;
        try {
          mod = await import(handlerUrl);
        } catch (err) {
          throw new Error(
            `Failed to load tool action handler for "${toolName}.${actionDef.name}" at "${handlerPath}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Validate the handler module exports handle() and collect for deferred storage
        const handler = validateToolActionHandler(mod, handlerPath);
        pendingHandlers.push({ actionName: actionDef.name, handler });

        // Build a ToolAction with a permissive schema (custom tools don't
        // declare Zod schemas in config — they accept any args and validate
        // internally via their handler). Use passthrough() so user-provided
        // parameters flow through the strict composite schema.
        actions.push({
          name: actionDef.name,
          description: actionDef.description,
          schema: z.object({}).passthrough(),
          phases: ALL_PHASES,
          roles: new Set<string>(['any']),
        });
      }

      const compositeTool: CompositeTool = {
        name: toolName,
        description: toolDef.description,
        actions,
      };

      registerCustomTool(compositeTool);
      registeredNames.push(toolName);

      // Store handlers only after successful registration — if registerCustomTool
      // throws, no orphaned handlers remain in the registry
      for (const { actionName, handler } of pendingHandlers) {
        setCustomToolActionHandler(toolName, actionName, handler);
      }
    }
  } catch (error) {
    // Rollback: unregister all tools registered so far
    for (const name of registeredNames) {
      try {
        unregisterCustomTool(name);
      } catch {
        // Ignore rollback errors
      }
    }
    throw new Error(
      `Failed to register custom tools: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Track for cleanup
  registeredToolNames.push(...registeredNames);
}
