import { zodToJsonSchema } from '../adapters/json-schema.js';
import { resolveEconomyBudget } from '../registry.js';
import type { ToolAction } from '../registry.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
} from '../event-store/schemas.js';
import { serializeTopology, listWorkflowTypes } from '../workflow/state-machine.js';
import { serializePlaybooks, listPlaybookWorkflowTypes } from '../workflow/playbooks.js';
import { buildConfigDescription } from '../workflow/describe-config.js';
import { RESERVED_FIELDS_DESCRIPTOR } from '../workflow/schemas.js';
// T5a.1/DR-4 (#1259, v2.11): Worktree/Task/Artifacts/Synthesis schemas
// were previously imported here to populate the `set` action's
// stateSchema discoverability slot. The slot and its consumer
// (`buildSetStateSchema`) are removed alongside the action.

/**
 * Handles the `describe` action for composite tools.
 * Returns full schemas, descriptions, gate metadata, and phase/role info
 * for the requested action names. Optionally includes HSM topology when
 * the `topology` parameter is provided, or phase playbooks when the
 * `playbook` parameter is provided.
 */
export async function handleDescribe(
  args: { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
  toolActions: readonly ToolAction[],
  options?: { includeStateSchema?: boolean | undefined; projectConfig?: ResolvedProjectConfig | undefined },
): Promise<ToolResult> {
  // Guard clauses: reject malformed values before computing flags
  if (args.actions !== undefined && (!Array.isArray(args.actions) || !args.actions.every((a: unknown) => typeof a === 'string'))) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'actions must be a non-empty string[]',
        expectedShape: { actions: ['action_name_1', 'action_name_2'] },
      },
    };
  }
  if (args.playbook !== undefined && (typeof args.playbook !== 'string' || args.playbook.length === 0)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'playbook must be a non-empty string',
        expectedShape: { playbook: 'feature | debug | refactor | all' },
      },
    };
  }
  if (args.topology !== undefined && (typeof args.topology !== 'string' || args.topology.length === 0)) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'topology must be a non-empty string',
        expectedShape: { topology: 'feature | debug | refactor | all' },
      },
    };
  }
  if (args.config !== undefined && typeof args.config !== 'boolean') {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'config must be a boolean',
        expectedShape: { config: true },
      },
    };
  }

  const hasActions = Array.isArray(args.actions) && args.actions.length > 0;
  const hasTopology = typeof args.topology === 'string' && args.topology.length > 0;
  const hasPlaybook = typeof args.playbook === 'string' && args.playbook.length > 0;
  const hasConfig = args.config === true;

  if (!hasActions && !hasTopology && !hasPlaybook && !hasConfig) {
    return {
      success: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'describe requires at least one of actions, topology, playbook, or config',
        expectedShape: {
          actions: ['action_name_1', 'action_name_2'],
          topology: 'feature | debug | refactor | all',
          playbook: 'feature | debug | refactor | all',
          config: true,
        },
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
            validActions: toolActions.map(a => a.name),
          },
        };
      }

      const actionResult: Record<string, unknown> = {
        description: action.description,
        schema: zodToJsonSchema(action.schema),
        gate: (action as ToolAction & { gate?: unknown }).gate ?? null,
        phases: [...action.phases],
        roles: [...action.roles],
        ...(action.autoEmits ? { autoEmits: [...action.autoEmits] } : {}),
        // T41 / DR-4 / DR-11: surface the `deprecated` flag so model-facing
        // agents can pivot to the canonical action without parsing the
        // description string. Surfaced unconditionally (not just when true)
        // so structurally-honest consumers can rely on the slot's presence.
        ...(action.deprecated ? { deprecated: true } : {}),
        // T8 (#1440 Op 2, preview-4 design §4.3): project the `dispatch`
        // DispatchHints slot so clients can enumerate task-suitable
        // actions via `exarchos_view describe`. The slot is omitted
        // entirely when the action does not declare it, mirroring the
        // `autoEmits` / `deprecated` optional-field pattern above.
        ...(action.dispatch ? { dispatch: action.dispatch } : {}),
        // DR-1 / Task 002 (design §"The economy block"): surface the
        // action's *effective* response budget — its declared
        // `economy.budgetTokens` or the registry default. Surfaced
        // unconditionally (not just when declared) because every action
        // resolves a concrete budget, and it is resolved through the single
        // `resolveEconomyBudget` so the number a client sees here matches
        // exactly what the dispatch-core measurement seam enforces (Task 003).
        economyBudgetTokens: resolveEconomyBudget(action),
        // Wave 0 / Task G.3 (#1287 + INV-5b, design §2.1 Approach C):
        // per-action `outputSchema` is surfaced as JSON Schema 2020-12
        // under `outputSchemaJson` so clients can introspect the precise
        // per-action contract via describe instead of relying on the LCD
        // envelope advertised on `tools/list`. The legacy `outputSchema`
        // key is retained alongside for one release to avoid breaking
        // existing consumers; the canonical slot going forward is
        // `outputSchemaJson`.
        ...(action.outputSchema
          ? {
              outputSchema: zodToJsonSchema(action.outputSchema),
              outputSchemaJson: zodToJsonSchema(action.outputSchema),
            }
          : {}),
        // #1360 / PR 2 — surface the reserved-fields descriptor on the
        // `update` action so callers can discover the immutable boundary
        // (and the alternate write paths, e.g. `transition` for phase)
        // through describe instead of trial-and-error against the
        // `RESERVED_FIELD` error envelope. Sourced from
        // `RESERVED_FIELDS_DESCRIPTOR` so the doc surface and the runtime
        // guard (`isReservedField`) share one canonical list.
        ...(actionName === 'update'
          ? { reservedFields: RESERVED_FIELDS_DESCRIPTOR }
          : {}),
      };

      // T5a.1/DR-4 (#1259, v2.11): the prior `set`-specific stateSchema
      // attachment has nothing to hang off — the `set` action is removed.
      // `options.includeStateSchema` is retained on the signature so
      // callers compile, but no action currently surfaces a stateSchema
      // entry. A successor surface will re-bind this in v2.12.

      results[actionName] = actionResult;
    }
  }

  // Resolve topology if requested
  if (hasTopology) {
    const topologyResult = handleTopologyDescribe(args.topology as string);
    if (!topologyResult.success) return topologyResult;
    results.topology = topologyResult.data;
  }

  // Resolve playbook if requested
  if (hasPlaybook) {
    const playbookResult = handlePlaybookDescribe(args.playbook as string);
    if (!playbookResult.success) return playbookResult;
    results.playbook = playbookResult.data;
  }

  // Resolve config description if requested
  if (hasConfig && options?.projectConfig) {
    results.config = buildConfigDescription(options.projectConfig);
  } else if (hasConfig) {
    // Config requested but no project config available — return informative message
    results.config = { message: 'No .exarchos.yml project config loaded. Using all defaults.' };
  }

  return { success: true, data: results };
}

// T5a.1/DR-4 (#1259, v2.11): the prior `buildSetStateSchema` helper —
// which described the `set` action's `updates` parameter shape — is
// removed alongside the action itself. Re-introduce a successor helper
// in v2.12 if a replacement surface needs equivalent discoverability.

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
 * Handles playbook introspection for the workflow describe action.
 * When playbook is "all", returns a listing of all workflow types with playbooks.
 * Otherwise, returns the serialized phase playbooks for the specified type.
 */
function handlePlaybookDescribe(playbook: string): ToolResult {
  if (playbook === 'all') {
    return {
      success: true,
      data: listPlaybookWorkflowTypes(),
    };
  }

  try {
    const serialized = serializePlaybooks(playbook);
    return { success: true, data: serialized };
  } catch {
    return {
      success: false,
      error: {
        code: 'UNKNOWN_WORKFLOW_TYPE',
        message: `Unknown workflow type: ${playbook}`,
        validTargets: listPlaybookWorkflowTypes(),
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
