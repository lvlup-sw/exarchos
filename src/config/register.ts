import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { registerWorkflowType, unregisterWorkflowType } from '../workflow/state-machine.js';
import { extendWorkflowTypeEnum, unextendWorkflowTypeEnum } from '../workflow/schemas.js';
import { registerEventType, unregisterEventType } from '../events/schemas.js';
import { ViewRegistry } from '../projections/views/registry.js';
import { registerCustomTool, unregisterCustomTool, setCustomToolActionHandler, ALL_PHASES } from '../registry.js';
import type { ExtensionCompositeTool, ExtensionToolAction } from '../registry.js';
import { withActionContract } from '../registry/action-contract.js';
import { admitActionContract } from '../registry/annotations.js';
import { unregisteredActionOutputSchema } from '../output-schema-declaration.js';
import { logger } from '../logger.js';
import type { ViewProjection } from '../projections/views/materializer.js';
import type { ExarchosConfig, ToolActionDefinition, WorkflowDefinition } from './define.js';

/** Conservative annotations for every custom tool action, because config declares none. */
const EXTENSION_ACTION_ANNOTATIONS = {
  safety: 'local-mutation' as const,
  readOnly: false,
  destructive: false,
  idempotent: false,
  openWorld: false,
};

type ExtensionActionAdmission = ToolActionDefinition & {
  readonly actionContract?: unknown;
};

const configLogger = logger.child({ subsystem: 'config' });

/** True after the custom-tools deprecation warning logs, so it logs once per process. */
let warnedCustomToolsDeprecated = false;

export type { ExarchosConfig, WorkflowDefinition };

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
    if (!def) return;
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
 * Registers the custom workflows and events of an `ExarchosConfig`. For each
 * workflow, it registers the HSM definition, extends the type schema, and
 * stores the guards. A parent workflow registers before a child that extends it.
 * On a failure, it undoes all registrations of this call and throws.
 */
export function registerCustomWorkflows(config: ExarchosConfig): void {
  if (!config.workflows && !config.events) return;

  const registeredWorkflows: string[] = [];
  const extendedTypes: string[] = [];
  const registeredGuardKeys: string[] = [];
  const registeredEvents: string[] = [];

  try {
    if (config.workflows) {
      for (const [name, definition] of topoSortWorkflows(config.workflows)) {
        registerWorkflowType(name, definition);
        registeredWorkflows.push(name);

        extendWorkflowTypeEnum(name);
        extendedTypes.push(name);

        if (definition.guards) {
          for (const [guardId, guardDef] of Object.entries(definition.guards)) {
            const key = `${name}:${guardId}`;
            guardRegistry.set(key, guardDef);
            registeredGuardKeys.push(key);
          }
        }
      }
    }

    if (config.events) {
      for (const [name, eventDef] of Object.entries(config.events)) {
        registerEventType(name, eventDef);
        registeredEvents.push(name);
      }
    }
  } catch (error) {
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
 * Makes sure that an imported view module has `init()` and `apply()`, as named
 * exports or on a default-export object.
 */
function validateViewHandler(mod: unknown, handlerPath: string): ViewProjection<unknown> {
  const module = mod as Record<string, unknown>;

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
 * Registers the custom views of an `ExarchosConfig`. It imports each handler
 * module, makes sure that it is a `ViewProjection`, and registers it. On a
 * failure, it unregisters the views of this call and throws.
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
    for (const name of registeredViewNames) {
      try {
        viewRegistry.unregisterCustomView(name);
      } catch {
      }
    }
    throw new Error(
      `Failed to register custom views: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const registeredToolNames: string[] = [];

/**
 * Clears the custom tools registered from config, and resets the
 * deprecation-warning latch. Used for test cleanup.
 */
export function clearRegisteredTools(): void {
  for (const name of registeredToolNames) {
    try {
      unregisterCustomTool(name);
    } catch {
    }
  }
  registeredToolNames.length = 0;
  warnedCustomToolsDeprecated = false;
}

/**
 * Returns the handler of an imported tool action module: a default-export
 * function, or a `handle()` function on the default-export object or the module.
 */
function validateToolActionHandler(
  mod: unknown,
  handlerPath: string,
): (args: Record<string, unknown>) => Promise<unknown> {
  const module = mod as Record<string, unknown>;

  const target = (
    module.default && typeof module.default === 'object'
      ? module.default as Record<string, unknown>
      : module
  );

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
 * Registers the custom tools of an `ExarchosConfig`. Each action gets a
 * `passthrough()` input schema, because config declares no schema, and its
 * handler checks its own arguments. Each action is an `ExtensionToolAction`
 * with an `unregisteredActionOutputSchema()`, a brand that a built-in action
 * cannot use. It stores the handlers only after `registerCustomTool` succeeds.
 * On a failure, it unregisters the tools of this call and throws. The first
 * call with tools in a process logs a deprecation warning.
 *
 * @deprecated since v2.10.0. The `tools:` block and `registerCustomTool` go
 * away in v3.0.0. Move custom tools to the Workflow Builder SDK.
 */
export async function registerCustomTools(
  config: ExarchosConfig,
  projectRoot: string,
): Promise<void> {
  if (!config.tools) return;

  const toolNames = Object.keys(config.tools);
  if (toolNames.length > 0 && !warnedCustomToolsDeprecated) {
    configLogger.warn(
      { toolNames, count: toolNames.length, removalMilestone: 'v3.0.0', issue: 1258 },
      `[exarchos] DEPRECATION: exarchos.config.ts custom tools are deprecated in v2.10.0 and will be removed in v3.0.0. ` +
        `Migrate to the Workflow Builder SDK (epic #1258).`,
    );
    warnedCustomToolsDeprecated = true;
  }

  const registeredNames: string[] = [];

  try {
    for (const [toolName, toolDef] of Object.entries(config.tools)) {
      const actions: ExtensionToolAction[] = [];
      const pendingHandlers: Array<{ actionName: string; handler: (args: Record<string, unknown>) => Promise<unknown> }> = [];

      for (const actionDef of toolDef.actions) {
        const admission = actionDef as ExtensionActionAdmission;
        const actionContract = admitActionContract(
          {
            name: admission.name,
            annotations: EXTENSION_ACTION_ANNOTATIONS,
            actionContract: admission.actionContract,
          },
          toolName,
        );

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

        const handler = validateToolActionHandler(mod, handlerPath);
        pendingHandlers.push({ actionName: actionDef.name, handler });

        actions.push(withActionContract(
          {
            name: actionDef.name,
            description: actionDef.description,
            schema: z.object({}).passthrough(),
            phases: ALL_PHASES,
            roles: new Set<string>(['any']),
            outputSchema: unregisteredActionOutputSchema(),
            annotations: EXTENSION_ACTION_ANNOTATIONS,
          },
          actionContract,
          { annotations: EXTENSION_ACTION_ANNOTATIONS },
        ));
      }

      const compositeTool: ExtensionCompositeTool = {
        name: toolName,
        description: toolDef.description,
        actions,
      };

      registerCustomTool(compositeTool);
      registeredNames.push(toolName);

      for (const { actionName, handler } of pendingHandlers) {
        setCustomToolActionHandler(toolName, actionName, handler);
      }
    }
  } catch (error) {
    for (const name of registeredNames) {
      try {
        unregisterCustomTool(name);
      } catch {
      }
    }
    throw new Error(
      `Failed to register custom tools: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  registeredToolNames.push(...registeredNames);
}
