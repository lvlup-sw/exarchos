import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolAction } from '../registry.js';
import type { ToolResult } from '../format.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
} from '../event-store/schemas.js';
import { serializeTopology, listWorkflowTypes } from '../workflow/state-machine.js';

/**
 * Handles the `describe` action for composite tools.
 * Returns full schemas, descriptions, gate metadata, and phase/role info
 * for the requested action names. Optionally includes HSM topology when
 * the `topology` parameter is provided.
 */
export async function handleDescribe(
  args: { actions?: string[]; topology?: string },
  toolActions: readonly ToolAction[],
): Promise<ToolResult> {
  const hasActions = args.actions && args.actions.length > 0;
  const hasTopology = typeof args.topology === 'string' && args.topology.length > 0;

  if (!hasActions && !hasTopology) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'describe requires at least one of actions or topology',
        expectedShape: {
          actions: ['action_name_1', 'action_name_2'],
          topology: 'feature | debug | refactor | all',
        },
      },
    };
  }

  if (hasActions && (!Array.isArray(args.actions) || !args.actions.every((a: unknown) => typeof a === 'string'))) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'describe requires actions: string[]',
        expectedShape: { actions: ['action_name_1', 'action_name_2'] },
      },
    };
  }

  const results: Record<string, unknown> = {};

  // Resolve action schemas if requested
  if (args.actions && args.actions.length > 0) {
    for (const actionName of args.actions) {
      const action = toolActions.find(a => a.name === actionName);
      if (!action) {
        return {
          success: false,
          error: {
            code: 'UNKNOWN_ACTION',
            message: `Unknown action: ${actionName}`,
            validTargets: toolActions.map(a => a.name),
          },
        };
      }

      results[actionName] = {
        description: action.description,
        schema: zodToJsonSchema(action.schema),
        gate: (action as ToolAction & { gate?: unknown }).gate ?? null,
        phases: [...action.phases],
        roles: [...action.roles],
      };
    }
  }

  // Resolve topology if requested
  if (hasTopology) {
    const topologyResult = handleTopologyDescribe(args.topology as string);
    if (!topologyResult.success) return topologyResult;
    results.topology = topologyResult.data;
  }

  return { success: true, data: results };
}

/**
 * Handles topology introspection for the workflow describe action.
 * When topology is "all", returns a listing of all workflow types.
 * Otherwise, returns the serialized HSM topology for the specified type.
 */
function handleTopologyDescribe(topology: string): ToolResult {
  if (topology === 'all') {
    return {
      success: true,
      data: listWorkflowTypes(),
    };
  }

  try {
    const serialized = serializeTopology(topology);
    return { success: true, data: serialized };
  } catch {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_WORKFLOW_TYPE',
        message: `Unknown workflow type: ${topology}`,
        validTargets: listWorkflowTypes().workflowTypes.map(wt => wt.name),
      },
    };
  }
}

/**
 * Handles event type schema discovery for the event tool's `describe` action.
 * Returns data schema, emission source, and built-in status for each event type.
 */
export async function handleEventTypeDescribe(
  eventTypes: string[],
): Promise<ToolResult> {
  const validTypes = getValidEventTypes();
  const results: Record<string, unknown> = {};

  for (const eventType of eventTypes) {
    if (!validTypes.includes(eventType)) {
      return {
        success: false,
        error: {
          code: 'UNKNOWN_EVENT_TYPE',
          message: `Unknown event type: ${eventType}`,
          validTargets: validTypes,
        },
      };
    }

    const schema = (EVENT_DATA_SCHEMAS as Record<string, unknown>)[eventType];
    const source = (EVENT_EMISSION_REGISTRY as Record<string, string>)[eventType];

    results[eventType] = {
      schema: schema ? zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0]) : null,
      source: source ?? null,
      isBuiltIn: isBuiltInEventType(eventType),
    };
  }

  return { success: true, data: results };
}

/**
 * Combined describe handler for the event tool.
 * Supports `actions` (tool action schemas), `eventTypes` (event data schemas),
 * and `emissionGuide` (full event emission catalog grouped by source).
 */
export async function handleEventDescribe(
  args: { actions?: string[]; eventTypes?: string[]; emissionGuide?: boolean },
  toolActions: readonly ToolAction[],
): Promise<ToolResult> {
  const hasActions = args.actions && args.actions.length > 0;
  const hasEventTypes = args.eventTypes && args.eventTypes.length > 0;
  const hasEmissionGuide = args.emissionGuide === true;

  if (!hasActions && !hasEventTypes && !hasEmissionGuide) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'At least one of actions, eventTypes, or emissionGuide must be provided',
        expectedShape: {
          actions: ['append', 'query'],
          eventTypes: ['shepherd.iteration', 'team.spawned'],
          emissionGuide: true,
        },
      },
    };
  }

  const results: Record<string, unknown> = {};

  // Resolve action schemas if requested
  if (args.actions && args.actions.length > 0) {
    const actionResult = await handleDescribe({ actions: args.actions }, toolActions);
    if (!actionResult.success) return actionResult;
    Object.assign(results, { actions: actionResult.data });
  }

  // Resolve event type schemas if requested
  if (args.eventTypes && args.eventTypes.length > 0) {
    const eventResult = await handleEventTypeDescribe(args.eventTypes);
    if (!eventResult.success) return eventResult;
    Object.assign(results, { eventTypes: eventResult.data });
  }

  // Resolve emission guide if requested
  if (hasEmissionGuide) {
    results.emissionGuide = serializeEventCatalog();
  }

  return { success: true, data: results };
}
