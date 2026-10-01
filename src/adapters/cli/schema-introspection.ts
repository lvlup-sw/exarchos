import { zodToJsonSchema } from '../../utils/json-schema.js';
import { getFullRegistry } from '../../registry.js';
import {
  serializeTopology,
  listWorkflowTypes,
} from '../../workflow/state-machine.js';
import type { SerializedTopology, WorkflowTypeSummary } from '../../workflow/state-machine.js';
import { serializeEventCatalog } from '../../events/schemas.js';
import type { EventCatalog } from '../../events/schemas.js';
import {
  serializePlaybooks,
  listPlaybookWorkflowTypes,
} from '../../workflow/playbooks.js';
import type { SerializedPlaybooks } from '../../workflow/playbooks.js';

/**
 * Resolves a `<tool>.<action>` ref, such as `workflow.init`, to the JSON Schema of
 * that action. The tool part maps to `exarchos_<tool>` in the registry.
 *
 * @throws Error if the ref format is not valid, or the tool or the action is not found.
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

  const tool = getFullRegistry().find((t) => t.name === toolFullName);
  if (!tool) {
    throw new Error(
      `Tool "${toolFullName}" not found in registry. Available: ${getFullRegistry().map((t) => t.name).join(', ')}`,
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
 * Lists every tool in the registry with its actions, hidden tools included. The MCP
 * adapter skips hidden tools, but the CLI is the operator surface and shows them on
 * purpose. Each entry carries a `hidden` flag, so callers can mark or filter them.
 */
export function listSchemas(): Array<{
  tool: string;
  hidden: boolean;
  actions: Array<{ name: string; description: string }>;
}> {
  return getFullRegistry().map((tool) => ({
    tool: tool.name,
    hidden: tool.hidden === true,
    actions: tool.actions.map((action) => ({
      name: action.name,
      description: action.description,
    })),
  }));
}

/**
 * Returns the serialized HSM topology of one workflow type.
 * Without a workflow type, returns a summary of all workflow types.
 *
 * @throws Error if the workflow type is not found.
 */
export function resolveTopologyRef(workflowType?: string): SerializedTopology | WorkflowTypeSummary {
  if (workflowType) {
    return serializeTopology(workflowType);
  }
  return listWorkflowTypes();
}

/**
 * Returns the serialized phase playbooks of one workflow type.
 * Without a workflow type, returns the names of the workflow types that have playbooks.
 *
 * @throws Error if the workflow type is not found.
 */
export function resolvePlaybookRef(
  workflowType?: string,
): SerializedPlaybooks | string[] {
  if (workflowType) {
    return serializePlaybooks(workflowType);
  }
  return listPlaybookWorkflowTypes();
}

/** Returns the event emission catalog, grouped by emission source. */
export function resolveEmissionCatalog(): EventCatalog {
  return serializeEventCatalog();
}
