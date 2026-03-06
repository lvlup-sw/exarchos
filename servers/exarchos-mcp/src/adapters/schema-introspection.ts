import { zodToJsonSchema } from 'zod-to-json-schema';
import { TOOL_REGISTRY } from '../registry.js';

/**
 * Resolves a schema reference (e.g., "workflow.init") to its JSON Schema representation.
 *
 * The ref format is `<toolShortName>.<actionName>` where toolShortName maps to
 * `exarchos_<toolShortName>` in the registry.
 *
 * @throws Error if the ref format is invalid or the tool/action is not found.
 */
export function resolveSchemaRef(ref: string): Record<string, unknown> {
  const parts = ref.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid schema ref format: "${ref}". Expected "<tool>.<action>" (e.g., "workflow.init")`,
    );
  }

  const toolShort = parts[0];
  const actionName = parts[1];
  const toolFullName = `exarchos_${toolShort}`;

  const tool = TOOL_REGISTRY.find((t) => t.name === toolFullName);
  if (!tool) {
    throw new Error(
      `Tool "${toolFullName}" not found in registry. Available: ${TOOL_REGISTRY.map((t) => t.name).join(', ')}`,
    );
  }

  const action = tool.actions.find((a) => a.name === actionName);
  if (!action) {
    throw new Error(
      `Action "${actionName}" not found in tool "${toolFullName}". Available: ${tool.actions.map((a) => a.name).join(', ')}`,
    );
  }

  return zodToJsonSchema(action.schema) as Record<string, unknown>;
}

/**
 * Lists all tools and their actions from the registry.
 * Returns a summary with tool name and action name/description pairs.
 */
export function listSchemas(): Array<{
  tool: string;
  actions: Array<{ name: string; description: string }>;
}> {
  return TOOL_REGISTRY.map((tool) => ({
    tool: tool.name,
    actions: tool.actions.map((action) => ({
      name: action.name,
      description: action.description,
    })),
  }));
}
