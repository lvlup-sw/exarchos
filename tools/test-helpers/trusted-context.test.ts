// `seedGateEvidence` states a precondition that its caller owes. Its value is that the admission
// evaluator cannot tell a seeded row from a shipped row. That holds only while the seed keys its
// evidence the way the real runner keys its own. So the key shape of `evidenceIdFor` in the runner
// is one authority, and the rows of a real `EventStore` are the second. The tests read the
// identity back from the persisted event, not from the id that the helper returned.
// @oracle-sources: ../../src/verbs/gates/gate-runner.ts, the rows a real EventStore holds after the seed — read back from the store rather than from the id the helper handed out so a seed that never persisted cannot satisfy the comparison

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import { rmrfAsync } from './temp-dir.js';
import { seedGateEvidence } from './trusted-context.js';

const STREAM = 'wf-seed-gate-evidence';

let stateDir: string;
let store: EventStore;

/** The persisted rows, not the ids the helper returned. */
async function persisted(): Promise<readonly { phaseAttemptId: string; evidenceId: string }[]> {
  const rows = await store.query(STREAM, { type: 'admission.evidence-recorded' });
  return rows.map((row) => {
    const { evidence } = row.data as {
      evidence: { phaseAttemptId: string; evidenceId: string };
    };
    return { phaseAttemptId: evidence.phaseAttemptId, evidenceId: evidence.evidenceId };
  });
}

beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), 'seed-gate-evidence-'));
  store = new EventStore(stateDir);
  await store.initialize();
});

afterEach(async () => {
  store.close();
  await rmrfAsync(stateDir);
});

describe('seedGateEvidence keys its evidence the way the gate runner keys its own', () => {
  /**
   * The attempt is part of the evidence identity of the real runner. So two attempts must leave two
   * rows in the store, each with its own attempt. A fresh id with no persisted row cannot pass.
   */
  it('SeedGateEvidence_TwoPhaseAttempts_LeaveTwoRowsCarryingTheirOwnAttempt', async () => {
    const first = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId: 'phase-attempt:one',
    });
    const second = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId: 'phase-attempt:two',
    });

    expect(second).not.toBe(first);

    const rows = await persisted();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.phaseAttemptId).sort()).toEqual([
      'phase-attempt:one',
      'phase-attempt:two',
    ]);
    expect(rows.map((row) => row.evidenceId).sort()).toEqual([first, second].sort());
  });

  /** The wider identity must keep the dedupe that an exact repeat relies on. */
  it('SeedGateEvidence_SameAttemptSeededTwice_ReusesTheExistingRow', async () => {
    const first = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId: 'phase-attempt:one',
    });
    const repeat = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId: 'phase-attempt:one',
    });

    expect(repeat).toBe(first);
    expect(await persisted()).toHaveLength(1);
  });

  /** The requirement stays part of the identity within one attempt. */
  it('SeedGateEvidence_DifferentRequirements_StayDistinctWithinOneAttempt', async () => {
    const review = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'review',
      phaseAttemptId: 'phase-attempt:one',
    });
    const security = await seedGateEvidence(store, {
      streamId: STREAM,
      requirementId: 'security',
      phaseAttemptId: 'phase-attempt:one',
    });

    expect(security).not.toBe(review);
    expect(await persisted()).toHaveLength(2);
  });
});
