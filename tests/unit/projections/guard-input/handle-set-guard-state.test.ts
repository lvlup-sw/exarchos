/**
 * These tests compare the state that `handleSet` gives the transition guard with a golden.
 * A scratch script wrote the golden once, before any change of the guard input. No test writes it.
 * Each transition runs on its own temporary SQLite store, so the state document is the `workflow_state` row.
 * The mask replaces each timestamp and each phase attempt id, so the golden holds no value of one run.
 *
 * @oracle-sources: ./__fixtures__/handle-set-guard-state.golden.json, ../../../../src/workflow/handlers/set.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  captureGuardStates,
  captureTransitionGuardStates,
  maskGuardState,
  renderGuardStateGolden,
} from '../../../helpers/guard-input/guard-state-spy.js';
import { projectStateToFacts } from '../../../../src/workflow/admission/legacy-state-translation.js';
import { hsmTransitionGuard } from '../../../../src/workflow/hsm-transition-guard.js';

/** The golden file that the scratch capture wrote once. */
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/handle-set-guard-state.golden.json',
);

/** The part of a golden entry that the tests read. */
const GoldenEntrySchema = z.object({
  name: z.string(),
  workflowType: z.string(),
  featureId: z.string(),
  from: z.string(),
  to: z.string(),
  options: z.record(z.string(), z.unknown()).optional(),
  state: z.record(z.string(), z.unknown()),
});

/** The seven transitions of the golden, in golden order. */
const SEVEN_TRANSITIONS: readonly string[] = [
  'feature plan -> plan-review',
  'feature plan-review -> delegate',
  'feature delegate -> review',
  'feature review -> synthesize',
  'feature review -> synthesize',
  'oneshot implementing -> synthesize',
  'debug triage -> investigate',
];

/** Reads the golden as JSON. */
function readGolden(): unknown {
  return JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
}

describe('the guard state of handleSet', () => {
  /**
   * The hook sees one guard call for each transition. The guard now gets the ledger fold, not the document copy of the golden.
   * So the facts of each captured input equal the facts of its golden entry, and the rest of each entry equals the golden.
   * A change of the injected config, of the hydrated events or of a fact of the input changes the capture.
   */
  it('HandleSetGuardState_SevenTransitions_EqualTheGolden', async () => {
    const calls: string[] = [];
    const entries = await captureTransitionGuardStates(({ attempt }) => {
      calls.push(`${attempt.context.workflowType} ${attempt.from} -> ${attempt.to}`);
    });

    expect(calls).toEqual(SEVEN_TRANSITIONS);
    const golden = z.array(GoldenEntrySchema).parse(readGolden());
    expect(golden).toHaveLength(entries.length);
    entries.forEach((entry, index) => {
      const goldenEntry = golden[index];
      if (goldenEntry === undefined) throw new Error(`the golden holds no entry ${index}`);
      const { state: _state, ...identity } = goldenEntry;
      const masked = JSON.parse(renderGuardStateGolden([{ ...entry, state: {} }]));
      expect(masked, entry.name).toStrictEqual([{ ...identity, state: {} }]);
      expect(projectStateToFacts(maskGuardState(entry.state)), entry.name).toStrictEqual(projectStateToFacts(goldenEntry.state));
    });
  });

  /**
   * The golden holds the seven transitions and the keys that the handler injects.
   * Only the high tier injects the mutation keys. Each feature transition with no options still gets the review gate.
   */
  it('HandleSetGuardState_TheGolden_HoldsSevenTransitionsAndTheInjectedKeys', () => {
    const golden = z.array(GoldenEntrySchema).parse(readGolden());

    expect(golden.map((entry) => `${entry.workflowType} ${entry.from} -> ${entry.to}`)).toEqual(SEVEN_TRANSITIONS);
    const high = golden.find((entry) => entry.name === 'feature review -> synthesize at the high tier');
    const medium = golden.find((entry) => entry.name === 'feature review -> synthesize at the medium tier');
    expect(high?.options).toEqual({ mutationEnforcement: 'block', mutationThreshold: 80, maxNoCoverage: 2 });
    expect(high?.state).toMatchObject({
      riskTier: 'high',
      _requiredReviews: ['review', 'mutation-adequacy'],
      _mutationEnforcement: 'block',
      _mutationThreshold: 80,
      _maxNoCoverage: 2,
    });
    expect(medium?.options).toEqual(high?.options);
    expect(medium?.state).toMatchObject({ riskTier: 'medium', _requiredReviews: ['review'] });
    expect(medium?.state).not.toHaveProperty('_mutationEnforcement');
    expect(medium?.state).not.toHaveProperty('_mutationThreshold');
    expect(medium?.state).not.toHaveProperty('_maxNoCoverage');
    const featureWithNoOptions = golden.filter((entry) => entry.workflowType === 'feature' && entry.options === undefined);
    expect(featureWithNoOptions.map((entry) => entry.state._requiredReviews)).toEqual([['review'], ['review'], ['review']]);
    for (const entry of golden) {
      expect(entry.state._pendingPhaseAttemptId).toBe('<phase-attempt-id>');
      expect(entry.state._events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'workflow.started' })]));
    }
  });

  /**
   * A throw of the run and a throw of the hook inside the wrapper both reach the caller.
   * After each one, the guard has its own method again and no own property.
   */
  it('HandleSetGuardState_TheWrapper_RestoresTheMethodAfterAThrow', async () => {
    const original = hsmTransitionGuard.attempt;
    const wrappedDuringRun: boolean[] = [];

    await expect(
      captureGuardStates(async () => {
        wrappedDuringRun.push(hsmTransitionGuard.attempt !== original);
        throw new Error('the run throws');
      }),
    ).rejects.toThrow('the run throws');
    expect(hsmTransitionGuard.attempt).toBe(original);
    expect(Object.getOwnPropertyDescriptor(hsmTransitionGuard, 'attempt')).toBeUndefined();

    await expect(
      captureGuardStates(
        async () => {
          wrappedDuringRun.push(hsmTransitionGuard.attempt !== original);
          return hsmTransitionGuard.attempt('guard-state-wrapper', 'plan', 'plan-review', {
            state: { phase: 'plan' },
            workflowType: 'feature',
            eventStore: null,
          });
        },
        () => {
          throw new Error('the hook throws inside the wrapper');
        },
      ),
    ).rejects.toThrow('the hook throws inside the wrapper');
    expect(wrappedDuringRun).toEqual([true, true]);
    expect(hsmTransitionGuard.attempt).toBe(original);
    expect(Object.getOwnPropertyDescriptor(hsmTransitionGuard, 'attempt')).toBeUndefined();
  });
});
