import { admitActionContract } from './annotations.js';
import { BUILTIN_TOOL_NAMES, TOOL_REGISTRY } from './tools.js';
import type { CompositeTool, ToolAction } from './types.js';

// ─── Dynamic Tool Registration (DEPRECATED — superseded by v3.0 #1258) ─────
//
// The `registerCustomTool` / `setCustomToolActionHandler` /
// `unregisterCustomTool` surface plus the `exarchos.config.ts` `tools:`
// block is the pre-SDK extension scaffolding for declaring custom MCP
// composite tools at runtime. It is superseded by the Workflow Builder
// SDK (epic #1258) shipping in v3.0, which becomes the single authoring
// surface for workflows AND custom tools. The closed-form `hsm-
// definitions.ts` / `playbooks.ts` registries are deleted in that
// milestone for the same DIM-5 hygiene reason — the SDK is the single
// source of truth.
//
// The surface remains `@deprecated` for v3.0 removal, but admission now
// runs every action through the same action-contract language as built-in
// registration. A missing or invalid block fails at `registerCustomTool`.

const customTools: CompositeTool[] = [];

/** Maps `toolName -> actionName -> handler` for custom tool dispatch. */
const customToolHandlers = new Map<string, Map<string, CustomToolActionHandler>>();

export type CustomToolActionHandler = (args: Record<string, unknown>) => Promise<unknown>;

/**
 * Register a custom composite tool. Throws if the name collides with a
 * built-in tool or an already-registered custom tool.
 *
 * @deprecated since v2.10.0 — this surface is removed in v3.0.0 in favor
 * of the Workflow Builder SDK (epic #1258), which becomes the single
 * authoring path for custom workflows and tools. New extension code
 * should target the v3.0 SDK instead.
 */
export function registerCustomTool(tool: CompositeTool): void {
  if (BUILTIN_TOOL_NAMES.has(tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": collides with built-in tool name`,
    );
  }
  if (customTools.some((t) => t.name === tool.name)) {
    throw new Error(
      `Cannot register custom tool "${tool.name}": already registered as a custom tool`,
    );
  }
  for (const action of tool.actions) {
    admitActionContract(action, tool.name);
  }
  customTools.push(tool);
}

/**
 * Store a handler function for a custom tool action.
 * Called during config-driven registration to wire handlers for dispatch.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function setCustomToolActionHandler(
  toolName: string,
  actionName: string,
  handler: CustomToolActionHandler,
): void {
  let actionMap = customToolHandlers.get(toolName);
  if (!actionMap) {
    actionMap = new Map();
    customToolHandlers.set(toolName, actionMap);
  }
  actionMap.set(actionName, handler);
}

/**
 * Retrieve the handler for a custom tool action.
 * Returns undefined if the tool or action is not registered.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function getCustomToolActionHandler(
  toolName: string,
  actionName: string,
): CustomToolActionHandler | undefined {
  return customToolHandlers.get(toolName)?.get(actionName);
}

/**
 * Check if a custom tool has any registered handlers.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function hasCustomToolHandlers(toolName: string): boolean {
  const actionMap = customToolHandlers.get(toolName);
  return actionMap !== undefined && actionMap.size > 0;
}

/**
 * Unregister a custom composite tool by name. Throws if the name is a
 * built-in tool or not registered as a custom tool.
 *
 * @deprecated since v2.10.0 — removed in v3.0.0 per #1258. See
 * {@link registerCustomTool}.
 */
export function unregisterCustomTool(name: string): void {
  if (BUILTIN_TOOL_NAMES.has(name)) {
    throw new Error(
      `Cannot unregister built-in tool "${name}"`,
    );
  }
  const index = customTools.findIndex((t) => t.name === name);
  if (index === -1) {
    throw new Error(
      `Cannot unregister tool "${name}": not registered as a custom tool`,
    );
  }
  customTools.splice(index, 1);
  customToolHandlers.delete(name);
}

/**
 * Returns the full registry: built-in TOOL_REGISTRY + custom tools.
 */
export function getFullRegistry(): readonly CompositeTool[] {
  if (customTools.length === 0) return TOOL_REGISTRY;
  return [...TOOL_REGISTRY, ...customTools];
}

/**
 * Clear all registered custom tools. Used for test cleanup.
 */
export function clearCustomTools(): void {
  customTools.length = 0;
  customToolHandlers.clear();
}

/**
 * Find a specific action within a tool in the full registry (built-in + custom).
 * Returns undefined if the tool or action is not found.
 */
export function findActionInRegistry(toolName: string, actionName: string): ToolAction | undefined {
  const tool = getFullRegistry().find(t => t.name === toolName);
  return tool?.actions.find(a => a.name === actionName);
}
