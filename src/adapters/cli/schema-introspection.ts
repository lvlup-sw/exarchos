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
 * Lists all tools and their actions from the registry.
 *
 * Tier model — INTENTIONAL asymmetry with the MCP `tools/list` surface.
 * `listSchemas()` returns the FULL registry, including `hidden: true` tools
 * (e.g. `exarchos_sync`). The MCP adapter (`./mcp.ts`) skips hidden tools
 * during `registerTool()` so they stay off the model-facing surface. The
 * CLI introspection path keeps them visible because the CLI is the operator
 * / script / debugging surface, where seeing the complete registry is the
 * desired behavior.
 *
 * Each returned entry carries a `hidden` boolean so callers (CLI renderers,
 * docs generators, parity tests) can mark or filter hidden tools without
 * having to re-walk the registry.
 *
 * See bug #1218 for the triage that locked this asymmetry in as
 * intentional, and `registry.ts:CompositeTool.hidden` for the field
 * contract.
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
 * Resolves HSM topology for a specific workflow type or lists all workflow types.
 *
 * Delegates to canonical serialization functions in state-machine.ts.
 * When called with a workflow type, returns the full serialized HSM topology.
 * When called without arguments, returns a listing of all available workflow types
 * with summary metadata.
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
 * Resolves playbook data for a specific workflow type or lists all workflow types.
 *
 * Delegates to canonical serialization functions in playbooks.ts.
 * When called with a workflow type, returns all serialized phase playbooks.
 * When called without arguments, returns a listing of all available workflow types.
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

/**
 * Returns the event emission catalog grouped by source (auto, model, hook, planned).
 *
 * Delegates to canonical serializeEventCatalog() in schemas.ts.
 */
export function resolveEmissionCatalog(): EventCatalog {
  return serializeEventCatalog();
}
