// ────────────────────────────────────────────────────────────────────────────
// `seedGateEvidence` states a precondition its caller owes, and its whole value
// is that the admission evaluator cannot tell a seeded row from a shipped one.
// That only holds while the seed keys its evidence the way the real runner keys
// its own — so the runner's `evidenceIdFor` is the authority here, and the rows
// a real `EventStore` holds afterwards are the second. Neither is the helper
// talking about itself: the identity is read back off the persisted event, not
// off the id the helper returned.
// @oracle-sources: ../../src/verbs/gates/gate-runner.ts, the rows a real EventStore holds after the seed — read back from the store rather than from the id the helper handed out so a seed that never persisted cannot satisfy the comparison
// ────────────────────────────────────────────────────────────────────────────

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
  it('SeedGateEvidence_TwoPhaseAttempts_LeaveTwoRowsCarryingTheirOwnAttempt', async () => {
    // The attempt is part of the real runner's evidence identity. While the
    // seed left it out, the second attempt collided with the first on the
    // (streamId, idempotencyKey) claim and was answered by the row already
    // there — so a test seeding two attempts silently got one, carrying the
    // FIRST attempt's id, and any admission decision that turned on the attempt
    // was reading a fact about the wrong one.
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
    // Read off the STORE: each attempt is present under its own identity, so a
    // second call that merely returned a fresh id without persisting a row
    // could not satisfy this.
    expect(rows.map((row) => row.phaseAttemptId).sort()).toEqual([
      'phase-attempt:one',
      'phase-attempt:two',
    ]);
    expect(rows.map((row) => row.evidenceId).sort()).toEqual([first, second].sort());
  });

  it('SeedGateEvidence_SameAttemptSeededTwice_ReusesTheExistingRow', async () => {
    // The other half of the same key: widening the identity must not cost the
    // dedupe an exact repeat still relies on.
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

  it('SeedGateEvidence_DifferentRequirements_StayDistinctWithinOneAttempt', async () => {
    // The requirement was already part of the identity; widening by the attempt
    // must not have collapsed it.
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
