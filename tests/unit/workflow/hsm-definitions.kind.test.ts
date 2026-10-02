/**
 * Characterization tests that lock the `kind` tag of each HSM state.
 * Only atomic states carry a `kind`. Compound and final states carry none.
 */

import { describe, it, expect } from 'vitest';
import {
  createFeatureHSM,
  createDebugHSM,
  createOneshotHSM,
  createDiscoveryHSM,
  createRefactorHSM,
} from '../../../src/workflow/hsm-definitions.js';
import type { HSMDefinition, State } from '../../../src/workflow/state-machine.js';
import type { PhaseKind } from '../../../src/workflow/phase-kind.js';

const ALL_KINDS: readonly PhaseKind[] = ['IMPLEMENT', 'PLAN', 'REVIEW', 'SYNTHESIZE', 'MERGE', 'GATHER'];

const ALL_HSMS: Record<string, HSMDefinition> = {
  feature: createFeatureHSM(),
  debug: createDebugHSM(),
  oneshot: createOneshotHSM(),
  discovery: createDiscoveryHSM(),
  refactor: createRefactorHSM(),
};

/** Read `kind` off a state without narrowing-induced compile coupling in tests. */
function kindOf(state: State): string | undefined {
  return (state as { kind?: string }).kind;
}

/** The expected kind of each atomic state, per HSM. Compound and final states carry no kind, so they are absent. */
const LOCKED_CLASSIFICATION: Record<string, Record<string, PhaseKind>> = {
  feature: {
    /** The feature HSM has no ideate state. `plan` is its initial state. */
    plan: 'PLAN',
    'plan-review': 'PLAN',
    delegate: 'IMPLEMENT',
    review: 'REVIEW',
    'merge-pending': 'MERGE',
    synthesize: 'SYNTHESIZE',
    blocked: 'GATHER',
  },
  debug: {
    triage: 'GATHER',
    investigate: 'GATHER',
    rca: 'PLAN',
    design: 'PLAN',
    'debug-implement': 'IMPLEMENT',
    'debug-validate': 'REVIEW',
    'debug-review': 'REVIEW',
    'hotfix-implement': 'IMPLEMENT',
    'hotfix-validate': 'REVIEW',
    synthesize: 'SYNTHESIZE',
    blocked: 'GATHER',
  },
  oneshot: {
    plan: 'PLAN',
    implementing: 'IMPLEMENT',
    synthesize: 'SYNTHESIZE',
  },
  discovery: {
    gathering: 'GATHER',
    synthesizing: 'GATHER',
  },
  refactor: {
    explore: 'GATHER',
    brief: 'PLAN',
    'polish-implement': 'IMPLEMENT',
    'polish-validate': 'REVIEW',
    'polish-update-docs': 'GATHER',
    'overhaul-plan': 'PLAN',
    'overhaul-plan-review': 'PLAN',
    'overhaul-delegate': 'IMPLEMENT',
    'overhaul-review': 'REVIEW',
    'overhaul-update-docs': 'GATHER',
    synthesize: 'SYNTHESIZE',
    blocked: 'GATHER',
  },
};

/** The implement state of each HSM track. Each one must have the kind IMPLEMENT. */
const IMPLEMENT_SNOWFLAKES: ReadonlyArray<{ hsm: string; state: string }> = [
  { hsm: 'feature', state: 'delegate' },
  { hsm: 'refactor', state: 'overhaul-delegate' },
  { hsm: 'debug', state: 'debug-implement' },
  { hsm: 'debug', state: 'hotfix-implement' },
  { hsm: 'refactor', state: 'polish-implement' },
  { hsm: 'oneshot', state: 'implementing' },
];

describe('HsmStates kind tagging (DR-2)', () => {
  it('HsmStates_EveryAtomicState_CarriesKind', () => {
    for (const [hsmName, hsm] of Object.entries(ALL_HSMS)) {
      for (const state of Object.values(hsm.states)) {
        if (state.type !== 'atomic') continue;
        const kind = kindOf(state);
        expect(
          ALL_KINDS.includes(kind as PhaseKind),
          `${hsmName}.${state.id} kind '${String(kind)}' must be one of ${ALL_KINDS.join(', ')}`,
        ).toBe(true);
      }
    }
  });

  it('HsmStates_ImplementSnowflakes_AllTaggedImplement', () => {
    for (const { hsm, state } of IMPLEMENT_SNOWFLAKES) {
      const s = ALL_HSMS[hsm].states[state];
      expect(s, `${hsm}.${state} must exist`).toBeDefined();
      expect(s.type, `${hsm}.${state} must be atomic`).toBe('atomic');
      expect(kindOf(s), `${hsm}.${state} must be kind IMPLEMENT`).toBe('IMPLEMENT');
    }
  });

  it('HsmStates_KindMap_MatchesLockedClassification', () => {
    for (const [hsmName, expectedMap] of Object.entries(LOCKED_CLASSIFICATION)) {
      const hsm = ALL_HSMS[hsmName];
      const actualMap: Record<string, string | undefined> = {};
      for (const state of Object.values(hsm.states)) {
        if (state.type === 'atomic') {
          actualMap[state.id] = kindOf(state);
        }
      }
      expect(actualMap, `${hsmName} atomic state → kind map`).toEqual(expectedMap);
    }
  });

  it('HsmStates_CompoundAndFinal_HaveNoKind', () => {
    for (const [hsmName, hsm] of Object.entries(ALL_HSMS)) {
      for (const state of Object.values(hsm.states)) {
        if (state.type === 'atomic') continue;
        expect(
          Object.prototype.hasOwnProperty.call(state, 'kind'),
          `${hsmName}.${state.id} (${state.type}) must NOT carry a kind`,
        ).toBe(false);
      }
    }
  });
});
