import { describe, it, expect } from 'vitest';
import {
  createFeatureHSM,
  createDebugHSM,
  createOneshotHSM,
  createDiscoveryHSM,
  createRefactorHSM,
} from './hsm-definitions.js';
import type { HSMDefinition, State } from './state-machine.js';
import type { PhaseKind } from './phase-kind.js';

// ─── Task 003 (DR-2): characterization of the kind-tag classification ────────
//
// These tests LOCK the current state → kind classification before any behavior
// change (Feathers-style). The `kind` tag lives on the obligation layer; the
// state names/transitions remain bespoke (INV-6 variation layer). Compound and
// final states are exempt — only `type === 'atomic'` states carry a `kind`.

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

// The complete, locked state-id → kind classification per HSM (compound + final
// states are intentionally absent — they carry no kind).
const LOCKED_CLASSIFICATION: Record<string, Record<string, PhaseKind>> = {
  feature: {
    // DR-4 (#1581): ideate (GATHER) removed — plan is initial.
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

// The six implement snowflakes (DR-2): each lives in a different HSM/track but
// all must resolve to the single IMPLEMENT kind so S2 reaches every one.
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
      const s = ALL_HSMS[hsm]!.states[state];
      expect(s, `${hsm}.${state} must exist`).toBeDefined();
      expect(s!.type, `${hsm}.${state} must be atomic`).toBe('atomic');
      expect(kindOf(s!), `${hsm}.${state} must be kind IMPLEMENT`).toBe('IMPLEMENT');
    }
  });

  it('HsmStates_KindMap_MatchesLockedClassification', () => {
    for (const [hsmName, expectedMap] of Object.entries(LOCKED_CLASSIFICATION)) {
      const hsm = ALL_HSMS[hsmName];
      const actualMap: Record<string, string | undefined> = {};
      for (const state of Object.values(hsm!.states)) {
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
