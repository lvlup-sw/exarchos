import { zodToJsonSchema } from 'zod-to-json-schema';
import { getFullRegistry } from '../registry.js';
import { getHSMDefinition, getInitialPhase } from '../workflow/state-machine.js';
import type { State, Transition } from '../workflow/state-machine.js';
import { EventTypes, EVENT_EMISSION_REGISTRY } from '../event-store/schemas.js';
import type { EventEmissionSource } from '../event-store/schemas.js';

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
 * Returns a summary with tool name and action name/description pairs.
 */
export function listSchemas(): Array<{
  tool: string;
  actions: Array<{ name: string; description: string }>;
}> {
  return getFullRegistry().map((tool) => ({
    tool: tool.name,
    actions: tool.actions.map((action) => ({
      name: action.name,
      description: action.description,
    })),
  }));
}

// ─── Topology Types ───────────────────────────────────────────────────────

export interface SerializedState {
  readonly id: string;
  readonly type: 'atomic' | 'compound' | 'final';
  readonly parent?: string;
  readonly initial?: string;
  readonly maxFixCycles?: number;
}

export interface SerializedTransition {
  readonly from: string;
  readonly to: string;
  readonly guard?: string;
  readonly isFixCycle?: boolean;
}

export interface SerializedTopology {
  readonly workflowType: string;
  readonly initialPhase: string;
  readonly states: readonly SerializedState[];
  readonly transitions: readonly SerializedTransition[];
  readonly tracks: readonly string[];
}

export interface WorkflowTypeSummary {
  readonly name: string;
  readonly initialPhase: string;
  readonly stateCount: number;
  readonly trackCount: number;
}

export interface WorkflowTypeListing {
  readonly workflowTypes: readonly WorkflowTypeSummary[];
}

// ─── Event Catalog Types ──────────────────────────────────────────────────

export interface EventCatalog {
  readonly types: readonly string[];
  readonly bySource: Record<string, readonly string[]>;
  readonly totalCount: number;
}

// ─── Built-in workflow type names ─────────────────────────────────────────

const BUILT_IN_WORKFLOW_TYPES = ['feature', 'debug', 'refactor'] as const;

// ─── Topology Introspection ──────────────────────────────────────────────

function serializeHSMState(state: State): SerializedState {
  const serialized: SerializedState = {
    id: state.id,
    type: state.type,
    ...(state.parent ? { parent: state.parent } : {}),
    ...(state.initial ? { initial: state.initial } : {}),
    ...(state.maxFixCycles != null ? { maxFixCycles: state.maxFixCycles } : {}),
  };
  return serialized;
}

function serializeHSMTransition(transition: Transition): SerializedTransition {
  const serialized: SerializedTransition = {
    from: transition.from,
    to: transition.to,
    ...(transition.guard ? { guard: transition.guard.id } : {}),
    ...(transition.isFixCycle ? { isFixCycle: transition.isFixCycle } : {}),
  };
  return serialized;
}

function getTopologyForType(workflowType: string): SerializedTopology {
  const hsm = getHSMDefinition(workflowType);
  const initialPhase = getInitialPhase(workflowType);

  const states = Object.values(hsm.states).map(serializeHSMState);
  const transitions = hsm.transitions.map(serializeHSMTransition);
  const tracks = Object.values(hsm.states)
    .filter((s) => s.type === 'compound')
    .map((s) => s.id);

  return {
    workflowType,
    initialPhase,
    states,
    transitions,
    tracks,
  };
}

/**
 * Resolves HSM topology for a specific workflow type or lists all workflow types.
 *
 * When called with a workflow type, returns the full serialized HSM topology.
 * When called without arguments, returns a listing of all available workflow types
 * with summary metadata (state count, track count).
 *
 * @throws Error if the workflow type is not found.
 */
export function resolveTopologyRef(workflowType?: string): SerializedTopology | WorkflowTypeListing {
  if (workflowType) {
    return getTopologyForType(workflowType);
  }

  const workflowTypes: WorkflowTypeSummary[] = BUILT_IN_WORKFLOW_TYPES.map((name) => {
    const hsm = getHSMDefinition(name);
    const initialPhase = getInitialPhase(name);
    const trackCount = Object.values(hsm.states).filter((s) => s.type === 'compound').length;

    return {
      name,
      initialPhase,
      stateCount: Object.keys(hsm.states).length,
      trackCount,
    };
  });

  return { workflowTypes };
}

/**
 * Returns the event emission catalog grouped by source (auto, model, hook, planned).
 *
 * Provides a complete listing of all event types, grouped by their emission source,
 * along with a total count.
 */
export function resolveEmissionCatalog(): EventCatalog {
  const types = [...EventTypes];
  const bySource: Record<string, string[]> = {};

  for (const [eventType, source] of Object.entries(EVENT_EMISSION_REGISTRY) as [string, EventEmissionSource][]) {
    if (!bySource[source]) {
      bySource[source] = [];
    }
    bySource[source].push(eventType);
  }

  return {
    types,
    bySource,
    totalCount: types.length,
  };
}
