import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolAction } from '../registry.js';
import type { ToolResult } from '../format.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  getValidEventTypes,
  isBuiltInEventType,
} from '../event-store/schemas.js';

/**
 * Handles the `describe` action for composite tools.
 * Returns full schemas, descriptions, gate metadata, and phase/role info
 * for the requested action names.
 */
export async function handleDescribe(
  args: { actions: string[] },
  toolActions: readonly ToolAction[],
): Promise<ToolResult> {
  if (!Array.isArray(args.actions) || !args.actions.every((a: unknown) => typeof a === 'string')) {
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

  return { success: true, data: results };
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
 * Supports both `actions` (tool action schemas) and `eventTypes` (event data schemas).
 */
export async function handleEventDescribe(
  args: { actions?: string[]; eventTypes?: string[] },
  toolActions: readonly ToolAction[],
): Promise<ToolResult> {
  const hasActions = args.actions && args.actions.length > 0;
  const hasEventTypes = args.eventTypes && args.eventTypes.length > 0;

  if (!hasActions && !hasEventTypes) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'At least one of actions or eventTypes must be provided',
        expectedShape: {
          actions: ['append', 'query'],
          eventTypes: ['shepherd.iteration', 'team.spawned'],
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

  return { success: true, data: results };
}
