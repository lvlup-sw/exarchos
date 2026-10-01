import { zodToJsonSchema } from '../utils/json-schema.js';
import {
  actionContractCanonicalBytes,
  contractEmissionsOf,
  normalizeActionContract,
  resolveEconomyBudget,
  type ActionContract,
  type ActionEmission,
  type DeclaredSet,
  type ReplayPolicy,
  type ToolAction,
} from '../registry.js';
import type { ToolResult } from '../format.js';
import type { ResolvedProjectConfig } from '../config/resolve.js';
import {
  EVENT_DATA_SCHEMAS,
  EVENT_EMISSION_REGISTRY,
  getValidEventTypes,
  isBuiltInEventType,
  serializeEventCatalog,
} from '../events/schemas.js';
import { serializeTopology, listWorkflowTypes } from '../workflow/state-machine.js';
import { serializePlaybooks, listPlaybookWorkflowTypes } from '../workflow/playbooks.js';
import { buildConfigDescription } from '../workflow/describe-config.js';
import { RESERVED_FIELDS_DESCRIPTOR } from '../workflow/schemas.js';

type ContractDimension =
  | 'requires'
  | 'ensures'
  | 'needs'
  | 'touches'
  | 'executionAuthority'
  | 'replay'
  | 'emissions';

export const ACTION_CONTRACT_DIMENSIONS: readonly ContractDimension[] = [
  'requires',
  'ensures',
  'needs',
  'touches',
  'executionAuthority',
  'replay',
  'emissions',
];

export type CompactDeclaredSet<T> =
  | { readonly kind: 'none' }
  | { readonly kind: 'declared'; readonly values: readonly T[] };

export interface CompactActionContract {
  readonly requires: CompactDeclaredSet<unknown>;
  readonly ensures: CompactDeclaredSet<unknown>;
  readonly needs: CompactDeclaredSet<unknown>;
  readonly touches: {
    readonly frame: ActionContract['touches']['frame'];
    readonly resources: CompactDeclaredSet<unknown>;
  };
  readonly executionAuthority: ActionContract['executionAuthority'];
  readonly replay: Exclude<ReplayPolicy, { readonly kind: 'reject-replay' }> | { readonly kind: 'reject-replay' };
  readonly emissions: CompactDeclaredSet<Omit<ActionEmission, 'description'>>;
  readonly digest: string;
}

function readDeclaredActionContract(action: ToolAction): unknown {
  if (!('actionContract' in action)) return undefined;
  return Reflect.get(action, 'actionContract');
}

/**
 * Project a declared registry contract through describe. Missing contracts
 * stay missing — annotations and top-level autoEmits are not a source.
 */
export function projectDescribedActionContract(action: ToolAction): ActionContract | undefined {
  const declared = readDeclaredActionContract(action);
  if (declared === undefined) return undefined;
  return normalizeActionContract(declared, { annotations: action.annotations });
}

/**
 * Compacts a declared set, with an optional item transform. Two overloads declare the two return
 * types. A single signature with a `U = T` default needs a cast on the untransformed branch.
 */
function compactDeclaredSet<T>(set: DeclaredSet<T>): CompactDeclaredSet<T>;
function compactDeclaredSet<T, U>(
  set: DeclaredSet<T>,
  compactItem: (item: T) => U,
): CompactDeclaredSet<U>;
function compactDeclaredSet<T, U>(
  set: DeclaredSet<T>,
  compactItem?: (item: T) => U,
): CompactDeclaredSet<T | U> {
  if (set.kind === 'none') return { kind: 'none' };
  return {
    kind: 'declared',
    values: compactItem === undefined ? set.values : set.values.map(compactItem),
  };
}

function compactEmission(emission: ActionEmission): Omit<ActionEmission, 'description'> {
  return {
    event: emission.event,
    condition: emission.condition,
    owner: emission.owner,
    role: emission.role,
    ...(emission.recoveryExpiresAt === undefined ? {} : { recoveryExpiresAt: emission.recoveryExpiresAt }),
  };
}

function compactReplay(
  replay: ReplayPolicy,
): { readonly kind: 'reject-replay' } | Exclude<ReplayPolicy, { readonly kind: 'reject-replay' }> {
  if (replay.kind === 'reject-replay') return { kind: 'reject-replay' };
  return replay;
}

/**
 * The compact projection of a normalized contract. It omits the `because` prose of a
 * `reject-replay` policy and the emission descriptions. It keeps each dimension and the digest.
 */
export function projectCompactActionContract(contract: ActionContract): CompactActionContract {
  return {
    requires: compactDeclaredSet(contract.requires),
    ensures: compactDeclaredSet(contract.ensures),
    needs: compactDeclaredSet(contract.needs),
    touches: {
      frame: contract.touches.frame,
      resources: compactDeclaredSet(contract.touches.resources),
    },
    executionAuthority: contract.executionAuthority,
    replay: compactReplay(contract.replay),
    emissions: compactDeclaredSet(contract.emissions, compactEmission),
    digest: actionContractCanonicalBytes(contract),
  };
}

function describedActionContractFields(action: ToolAction): Record<string, unknown> {
  const actionContract = projectDescribedActionContract(action);
  if (actionContract === undefined) return {};
  return {
    actionContract,
    actionContractDigest: actionContractCanonicalBytes(actionContract),
    actionContractCompact: projectCompactActionContract(actionContract),
  };
}

/**
 * Handles the `describe` action for composite tools. For each requested action it returns the
 * input schema, description, gate, phases, roles, and `economyBudgetTokens`. The budget comes from
 * `resolveEconomyBudget`, which the dispatch core also enforces. The optional slots appear only
 * when the action declares them. `outputSchema` and `outputSchemaJson` hold the same JSON Schema.
 *
 * It also returns the HSM topology, the phase playbooks, or the project config on request.
 * The `update` action also carries `reservedFields`. `options.includeStateSchema` has no effect.
 */
export async function handleDescribe(
  args: { actions?: string[]; topology?: string; playbook?: string; config?: boolean },
  toolActions: readonly ToolAction[],
  options?: { includeStateSchema?: boolean | undefined; projectConfig?: ResolvedProjectConfig | undefined },
): Promise<ToolResult> {
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

      const emissions = contractEmissionsOf(action);
      const actionResult: Record<string, unknown> = {
        description: action.description,
        schema: zodToJsonSchema(action.schema),
        gate: (action as ToolAction & { gate?: unknown }).gate ?? null,
        phases: [...action.phases],
        roles: [...action.roles],
        ...(emissions.length > 0 ? { autoEmits: [...emissions] } : {}),
        ...(action.deprecated ? { deprecated: true } : {}),
        ...(action.dispatch ? { dispatch: action.dispatch } : {}),
        economyBudgetTokens: resolveEconomyBudget(action),
        ...(action.outputSchema
          ? {
              outputSchema: zodToJsonSchema(action.outputSchema),
              outputSchemaJson: zodToJsonSchema(action.outputSchema),
            }
          : {}),
        ...(actionName === 'update'
          ? { reservedFields: RESERVED_FIELDS_DESCRIPTOR }
          : {}),
        ...describedActionContractFields(action),
      };

      results[actionName] = actionResult;
    }
  }

  if (hasTopology) {
    const topologyResult = handleTopologyDescribe(args.topology as string);
    if (!topologyResult.success) return topologyResult;
    results.topology = topologyResult.data;
  }

  if (hasPlaybook) {
    const playbookResult = handlePlaybookDescribe(args.playbook as string);
    if (!playbookResult.success) return playbookResult;
    results.playbook = playbookResult.data;
  }

  if (hasConfig && options?.projectConfig) {
    results.config = buildConfigDescription(options.projectConfig);
  } else if (hasConfig) {
    results.config = { message: 'No .exarchos.yml project config loaded. Using all defaults.' };
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

  if (args.actions && args.actions.length > 0) {
    const actionResult = await handleDescribe({ actions: args.actions }, toolActions);
    if (!actionResult.success) return actionResult;
    Object.assign(results, { actions: actionResult.data });
  }

  if (args.eventTypes && args.eventTypes.length > 0) {
    const eventResult = await handleEventTypeDescribe(args.eventTypes);
    if (!eventResult.success) return eventResult;
    Object.assign(results, { eventTypes: eventResult.data });
  }

  if (hasEmissionGuide) {
    results.emissionGuide = serializeEventCatalog();
  }

  return { success: true, data: results };
}
