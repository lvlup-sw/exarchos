/**
 * This test checks the document side of the guard input against the state that `handleSet` gives the guard.
 * It runs the seven transitions of the guard-state golden. Inside the guard wrapper, it reads the state document and the rows of the stream.
 * `documentGuardInput` with the handler options, or with `{}` when the handler has none, must give the state that the guard got.
 * The handler injects the default review gates also with no options, so the case passes `{}` as the live shadow does.
 *
 * @oracle-sources: ../../../../src/projections/guard-input/fold.ts, the state that the wrapped guard gets from the handler at call time
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { documentGuardInput, type GuardInput } from '../../../../src/projections/guard-input/fold.js';
import { readStateFile } from '../../../../src/workflow/state-store.js';
import { captureTransitionGuardStates } from '../../../helpers/guard-input/guard-state-spy.js';

/** The state document and the rows of one transition, as the wrapper reads them at the guard call. */
interface DocumentRead {
  readonly document: GuardInput;
  readonly rows: readonly WorkflowEvent[];
}

/** The seven transitions of the golden, in golden order. */
const SEVEN_TRANSITIONS: readonly string[] = [
  'feature plan -> plan-review',
  'feature plan-review -> delegate',
  'feature delegate -> review',
  'feature review -> synthesize at the high tier',
  'feature review -> synthesize at the medium tier',
  'oneshot implementing -> synthesize',
  'debug triage -> investigate',
];

/**
 * Returns a copy of a guard state without the phase attempt id.
 * The handler sets that id before the guard call, and the document side does not set it.
 */
function withoutPhaseAttemptId(state: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).filter(([key]) => key !== '_pendingPhaseAttemptId'));
}

describe('the document side of the guard input', () => {
  /**
   * For each transition, the document side equals the state that the guard got, other than the phase attempt id.
   * Five transitions pass no options, and the three feature transitions among them still hold the default review gate.
   */
  it('DocumentSide_EachGoldenTransition_EqualsTheStateThatTheGuardGets', async () => {
    const reads = new Map<string, DocumentRead>();
    const entries = await captureTransitionGuardStates(async ({ name, stateDir, eventStore, attempt }) => {
      const document = await readStateFile(path.join(stateDir, `${attempt.featureId}.state.json`));
      const rows = await eventStore.query(attempt.featureId);
      reads.set(name, { document, rows });
    });

    expect(entries.map((entry) => entry.name)).toEqual(SEVEN_TRANSITIONS);
    expect([...reads.keys()]).toEqual(SEVEN_TRANSITIONS);
    expect(entries.filter((entry) => entry.options === undefined)).toHaveLength(5);
    for (const entry of entries) {
      const read = reads.get(entry.name);
      if (read === undefined) throw new Error(`the wrapper read no document for '${entry.name}'`);
      expect(read.rows.length, entry.name).toBeGreaterThan(0);
      expect(entry.state._pendingPhaseAttemptId, entry.name).toEqual(expect.any(String));

      const documentSide = documentGuardInput(read.document, read.rows, { config: entry.options ?? {} });

      expect(documentSide, entry.name).toStrictEqual(withoutPhaseAttemptId(entry.state));
    }
    const featureWithNoOptions = entries.filter((entry) => entry.workflowType === 'feature' && entry.options === undefined);
    expect(featureWithNoOptions.map((entry) => entry.state._requiredReviews)).toEqual([['review'], ['review'], ['review']]);
  });
});
