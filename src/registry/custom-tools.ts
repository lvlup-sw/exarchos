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
// There are no known active consumers of this surface. CodeRabbit MAJOR
// on PR #1369 flagged that `registerCustomTool` doesn't run actions
// through `validateAction`, leaving missing `outputSchema`/`annotations`
// to surface as runtime crashes far from the registration site. Rather
// than tighten the contract (which would touch test fixtures and ship a
// pseudo-breaking-change to an API with no consumers), we mark the
// entire surface `@deprecated` here and schedule its removal alongside
// #1258 in v3.0.

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
  // Custom tools are intentionally NOT run through `validateAction` here.
  // The whole surface is `@deprecated` for v3.0 removal per #1258, so
  // hardening the contract here would ship a pseudo-breaking-change for
  // an API with no consumers (CodeRabbit PR #1369 MAJOR, resolved by
  // deprecation rather than tightening).
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
