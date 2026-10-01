/**
 * The built-in topology that staleness scoring uses when a project has no
 * `topology.yaml`. It is derived from the built-in workflow registry, so these
 * cases pin the derivation rule and the default contract, not a phase list.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { getBuiltinTopology, resolveStalenessTopology } from '../../../../src/workflow/topology/builtin.js';
import { __resetTopologyCacheForTesting } from '../../../../src/workflow/topology/loader.js';
import { TopologySchema } from '../../../../src/workflow/topology/phase-contract.js';
import {
  getHSMDefinition,
  isBuiltInWorkflowType,
  listWorkflowTypes,
  registerWorkflowType,
  unregisterWorkflowType,
} from '../../../../src/workflow/state-machine.js';

const BUILT_IN_WORKFLOW_TYPES = ['feature', 'debug', 'refactor', 'oneshot', 'discovery'];

const FOURTEEN_DAYS_IN_MINUTES = 14 * 24 * 60;

const DEFAULT_CONTRACT = {
  expectedMaxDwellMinutes: FOURTEEN_DAYS_IN_MINUTES,
  signals: [{ name: 'lastActivity', thresholdMinutes: FOURTEEN_DAYS_IN_MINUTES }],
  freshnessRequires: 'all',
};

const CUSTOM_WORKFLOW_TYPE = 'builtin-topology-custom-probe';

describe('getBuiltinTopology', () => {
  afterEach(() => {
    if (!listWorkflowTypes().workflowTypes.some((t) => t.name === CUSTOM_WORKFLOW_TYPE)) return;
    unregisterWorkflowType(CUSTOM_WORKFLOW_TYPE);
  });

  it('BuiltinTopology_RegistryBuiltInTypes_AreTheFiveTheTopologyCovers', () => {
    const registered = listWorkflowTypes()
      .workflowTypes.map((t) => t.name)
      .filter((name) => isBuiltInWorkflowType(name));

    expect(registered).toEqual(BUILT_IN_WORKFLOW_TYPES);
  });

  it('BuiltinTopology_AtomicPhases_CarryTheFourteenDayLastActivityContract', () => {
    const topology = getBuiltinTopology();

    for (const phase of ['plan', 'delegate', 'triage', 'rca', 'explore', 'overhaul-review', 'implementing', 'gathering']) {
      expect(topology.phases[phase]?.staleness, phase).toEqual(DEFAULT_CONTRACT);
    }
  });

  it('BuiltinTopology_EveryBuiltInState_IsCoveredIffItIsAtomic', () => {
    const topology = getBuiltinTopology();

    for (const workflowType of BUILT_IN_WORKFLOW_TYPES) {
      for (const state of Object.values(getHSMDefinition(workflowType).states)) {
        const entry = topology.phases[state.id];
        if (state.type === 'atomic') {
          expect(entry?.staleness, `${workflowType}/${state.id}`).toEqual(DEFAULT_CONTRACT);
        } else {
          expect(entry, `${workflowType}/${state.id}`).toBeUndefined();
        }
      }
    }
    expect(topology.phases['completed']).toBeUndefined();
    expect(topology.phases['cancelled']).toBeUndefined();
    expect(topology.phases['implementation']).toBeUndefined();
  });

  it('BuiltinTopology_CustomWorkflowTypePhases_AreNotCovered', () => {
    registerWorkflowType(CUSTOM_WORKFLOW_TYPE, {
      phases: ['probe-start', 'probe-done'],
      initialPhase: 'probe-start',
      transitions: [{ from: 'probe-start', to: 'probe-done', event: 'probe-finished' }],
    });

    const topology = getBuiltinTopology();

    expect(topology.phases['probe-start']).toBeUndefined();
    expect(topology.phases['plan']?.staleness).toEqual(DEFAULT_CONTRACT);
  });

  it('BuiltinTopology_ParsesUnderTheLoaderSchema', () => {
    expect(() => TopologySchema.parse(getBuiltinTopology())).not.toThrow();
  });
});

describe('resolveStalenessTopology', () => {
  beforeEach(() => {
    __resetTopologyCacheForTesting();
  });

  afterEach(() => {
    __resetTopologyCacheForTesting();
    if (!listWorkflowTypes().workflowTypes.some((t) => t.name === CUSTOM_WORKFLOW_TYPE)) return;
    unregisterWorkflowType(CUSTOM_WORKFLOW_TYPE);
  });

  it('StalenessScope_NoTopologyFileRequested_CoversOnlyTheBuiltInWorkflowTypes', () => {
    registerWorkflowType(CUSTOM_WORKFLOW_TYPE, {
      phases: ['plan', 'probe-done'],
      initialPhase: 'plan',
      transitions: [{ from: 'plan', to: 'probe-done', event: 'probe-finished' }],
    });

    const scope = resolveStalenessTopology();

    expect(scope.topology.phases['plan']?.staleness).toEqual(DEFAULT_CONTRACT);
    expect(scope.topology.phases['probe-done']).toBeUndefined();
    expect([...(scope.coveredWorkflowTypes ?? [])]).toEqual(BUILT_IN_WORKFLOW_TYPES);
  });
});
