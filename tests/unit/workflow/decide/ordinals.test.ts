/**
 * These tests compare the pure ordinals and the pure frozen floor with the store reads of the transition guard.
 * Each case seeds one store by hand, reads its rows, and runs both forms on the same stream.
 *
 * @oracle-sources: ../../../../src/workflow/decide/emit.ts, hand-seeded store rows
 */
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventStore } from '../../../../src/events/store.js';
import { SqliteBackend } from '../../../../src/storage/sqlite-backend.js';
import { fixCycleOrdinalOf, frozenFloorOf, planRevisionOrdinalOf } from '../../../../src/workflow/decide/emit.js';
import {
  nextFixCycleOrdinal,
  nextPlanRevisionOrdinal,
  readFrozenFloorForPhase,
} from '../../../../src/workflow/hsm-transition-guard.js';
import { makeTempDir, rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The stream of each case. */
const FEATURE_ID = 'decide-ordinals';

let stateDir: string;
let backend: SqliteBackend;
let eventStore: EventStore;

beforeEach(async () => {
  stateDir = makeTempDir('decide-ordinals-');
  backend = new SqliteBackend(path.join(stateDir, 'exarchos.db'));
  backend.initialize();
  eventStore = new EventStore(stateDir, { backend });
  await eventStore.initialize();
});

afterEach(async () => {
  eventStore.close();
  backend.close();
  await rmrfAsync(stateDir);
});

/** Appends one `phase.entered` row with the given phase, gates and coordinate. */
async function appendEntered(
  phase: string,
  gates: readonly string[],
  riskTier: string,
  boundaryTouching: boolean,
): Promise<void> {
  await eventStore.append(FEATURE_ID, {
    type: 'phase.entered',
    data: {
      phase,
      kind: 'REVIEW',
      resolver: 'review-contract',
      resolvedGates: gates.map((gate) => ({ family: 'review', gate })),
      policySource: 'builtin',
      mode: 'enforce',
      posture: 'read-only',
      riskTier,
      boundaryTouching,
    },
  });
}

/** Appends one `workflow.fix-cycle` row, with a group id when one is given. */
async function appendFixCycle(compoundStateId: string | undefined, count: number): Promise<void> {
  await eventStore.append(FEATURE_ID, {
    type: 'workflow.fix-cycle',
    data: { ...(compoundStateId === undefined ? {} : { compoundStateId }), count, featureId: FEATURE_ID },
  });
}

describe('the ordinals and the frozen floor of the rows', () => {
  it('FrozenFloorOf_Rows_EqualsReadFrozenFloorForPhase', async () => {
    await appendEntered('review', ['quality'], 'high', true);
    await appendEntered('delegate', ['spec'], 'medium', false);
    await appendEntered('review', ['spec', 'security'], 'low', false);
    const rows = await eventStore.query(FEATURE_ID);
    const stored = await readFrozenFloorForPhase(eventStore, FEATURE_ID, 'review');
    expect(stored?.gates?.map((gate) => gate.gate)).toEqual(['spec', 'security']);
    expect(frozenFloorOf(rows, 'review')).toEqual(stored);
    expect(frozenFloorOf(rows, 'synthesize')).toEqual(await readFrozenFloorForPhase(eventStore, FEATURE_ID, 'synthesize'));
  });

  it('FixCycleOrdinalOf_Rows_EqualsTheStoreCount', async () => {
    await appendFixCycle('implementation', 1);
    await appendFixCycle('overhaul-track', 1);
    await appendFixCycle('implementation', 2);
    await appendFixCycle(undefined, 1);
    const rows = await eventStore.query(FEATURE_ID);
    const groups: readonly unknown[] = ['implementation', 'overhaul-track', 'no-such-group', undefined];
    const pure = groups.map((group) => fixCycleOrdinalOf(rows, group));
    const stored = await Promise.all(groups.map((group) => nextFixCycleOrdinal(eventStore, FEATURE_ID, group)));
    expect(stored).toEqual([3, 2, 1, 5]);
    expect(pure).toEqual(stored);
  });

  it('PlanRevisionOrdinalOf_Rows_EqualsTheStoreCount', async () => {
    await eventStore.append(FEATURE_ID, { type: 'workflow.plan-revision', data: { count: 1, featureId: FEATURE_ID } });
    await appendFixCycle('implementation', 1);
    await eventStore.append(FEATURE_ID, { type: 'workflow.plan-revision', data: { count: 2, featureId: FEATURE_ID } });
    const rows = await eventStore.query(FEATURE_ID);
    const stored = await nextPlanRevisionOrdinal(eventStore, FEATURE_ID);
    expect(stored).toBe(3);
    expect(planRevisionOrdinalOf(rows)).toBe(stored);
  });
});
