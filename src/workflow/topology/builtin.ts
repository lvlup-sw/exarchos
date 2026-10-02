/**
 * The topology that staleness scoring uses when a project has no `topology.yaml`.
 *
 * It comes from the built-in workflow registry that also drives phase transitions. Thus a new
 * built-in phase is covered, with no second list to keep in step. Each covered phase gets one
 * `lastActivity` signal at 14 days, which is the default staleness threshold.
 */
import { getTopology, isExplicitTopologyRequested } from './loader.js';
import type { Topology } from './phase-contract.js';
import {
  getHSMDefinition,
  isBuiltInWorkflowType,
  listWorkflowTypes,
} from '../state-machine.js';

/** Fourteen days in minutes. */
const BUILTIN_STALENESS_THRESHOLD_MINUTES = 20_160;

/** The built-in workflow types in the registry, in registration order. */
function listBuiltinWorkflowTypes(): string[] {
  return listWorkflowTypes()
    .workflowTypes.map(({ name }) => name)
    .filter((name) => isBuiltInWorkflowType(name));
}

/**
 * Build the built-in topology from every atomic phase of the built-in
 * workflow types. Final states are left out because the pruner excludes
 * terminal phases before it reads the topology. Compound states are left out
 * because the recorded phase of a workflow is always an atomic state. Custom
 * workflow types are left out, because they are not built in.
 */
export function getBuiltinTopology(): Topology {
  const phases: Topology['phases'] = {};
  for (const name of listBuiltinWorkflowTypes()) {
    for (const state of Object.values(getHSMDefinition(name).states)) {
      if (state.type !== 'atomic' || phases[state.id] !== undefined) continue;
      phases[state.id] = {
        staleness: {
          expectedMaxDwellMinutes: BUILTIN_STALENESS_THRESHOLD_MINUTES,
          signals: [{ name: 'lastActivity', thresholdMinutes: BUILTIN_STALENESS_THRESHOLD_MINUTES }],
          freshnessRequires: 'all',
        },
      };
    }
  }
  return { phases };
}

/** The topology that staleness scoring reads, and the workflow types it covers. */
export interface StalenessScope {
  topology: Topology;
  /**
   * The workflow types the topology covers. It is absent when a
   * `topology.yaml` loaded, because that file then covers every type.
   */
  coveredWorkflowTypes?: ReadonlySet<string>;
}

/**
 * Return the topology that staleness scoring reads. A loaded `topology.yaml`
 * wins and covers every workflow type. With no `topology.yaml`, the built-in
 * topology applies and covers only the built-in workflow types. When a
 * `topology.yaml` was requested but failed to load, this throws: a broken
 * explicit contract is never silently replaced by the built-in defaults.
 */
export function resolveStalenessTopology(): StalenessScope {
  if (isExplicitTopologyRequested()) return { topology: getTopology() };
  return {
    topology: getBuiltinTopology(),
    coveredWorkflowTypes: new Set(listBuiltinWorkflowTypes()),
  };
}
