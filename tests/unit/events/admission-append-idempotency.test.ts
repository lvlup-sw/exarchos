// Each admission append carries a claim key that derives from the natural identity of the fact.
// The two appends are `admission.shadow-attempt` and `admission.disagreement-disposition`.
// A retry with the same key collapses onto the stored row. The invariant for idempotency at the
// boundary has no mechanical checker, so this suite is the check for these appends.
//
// Each retry assertion reads rows back from a file-backed `EventStore` after a second append.
// The suite compares two authorities. The first is the envelope that the typed writer returns
// on each dispatch. The second is the set of durable rows that `eventStore.query` reads from disk.
// The comparison computes neither side from the other, so the two sides can disagree:
//
//   - Without the key, the retry appends a second row.
//   - With a random key, the stored `idempotencyKey` differs from the key that the test recomputes.
//
// @oracle-sources: the envelopes the shipped typed writer returns on two independent dispatches, the durable rows re-read off disk by the file-backed event store

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../../../src/dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../src/dispatch/dispatch-context.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';
import { EventStore } from '../../../src/events/store.js';
import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
} from '../../../src/events/schemas.js';
import {
  admissionDispositionIdempotencyKey,
  handleAdmissionDisagreementDisposition,
} from '../../../src/events/tools.js';
import { defaultTranslationContext } from '../../../src/workflow/admission/legacy-state-translation.js';
import {
  InMemoryLiveShadowSink,
  LiveShadowHealthCounter,
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  observeLiveTransition,
} from '../../../src/workflow/admission/live-shadow-observer.js';
import type { LegacyTransitionObservation } from '../../../src/workflow/admission/shadow-decision.js';

const STREAM = 'phase-gate-t49-admission-idempotency';
const FIRST_TIME = '2026-07-21T21:00:00.000Z';
/** A later instant for the retry. It shows that the stored row won. */
const RETRY_TIME = '2026-07-21T22:30:00.000Z';

const DISPOSITION_ID = 'disposition-t49';

function dispositionInput(overrides: Record<string, unknown> = {}) {
  return {
    stream: STREAM,
    dispositionId: DISPOSITION_ID,
    shadowAttemptId: 'shadow-attempt-t49',
    disposition: 'explained-admission' as const,
    rationale: 'The admission record used durable gate evidence.',
    ...overrides,
  };
}

/**
 * Records one disposition through the typed writer in a new dispatch. Each call gets a new
 * `operationId` and its own `resolvedAt`, so `dispositionId` is the only stable identity of a retry.
 */
async function recordDisposition(
  eventStore: EventStore,
  resolvedAt: string,
  overrides: Record<string, unknown> = {},
) {
  const authorization = snapshotCallerAuthorization(
    deriveMcpCallerIdentity({ sessionId: 'admission-idempotency-session' }),
    createInMemoryResolver([
      'fs:read',
      'fs:write',
      'shell:exec',
      'isolation:worktree',
      'mcp:exarchos',
    ]),
    () => resolvedAt,
  );
  return runWithDispatchContext(
    mintDispatchContext(undefined, authorization),
    () => handleAdmissionDisagreementDisposition(dispositionInput(overrides), eventStore),
  );
}

describe('DR-36 / T-49 — admission.disagreement-disposition retry collapses', () => {
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'admission-idempotency-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * The retry is the same disposition at a later instant in a new dispatch. It returns the
   * stored result, and the one stored row keeps the time and the sequence of the first append.
   * The key on that row is the key that the test recomputes from `DISPOSITION_ID`.
   */
  it('AdmissionDisposition_ReplayedAppend_ReturnsStoredResultNotDuplicate', async () => {
    const first = await recordDisposition(eventStore, FIRST_TIME);
    expect(first.success).toBe(true);

    const replay = await recordDisposition(eventStore, RETRY_TIME);
    expect(replay.success).toBe(true);

    expect(replay.data).toEqual(first.data);

    const persisted = await eventStore.query(STREAM, {
      type: 'admission.disagreement-disposition',
    });
    expect(persisted.length).toBe(1);

    const row = persisted[0]!;
    expect(row.timestamp).toBe(FIRST_TIME);
    expect(AdmissionDisagreementDispositionData.parse(row.data).recordedAt).toBe(
      FIRST_TIME,
    );
    expect((first.data as { sequence: number }).sequence).toBe(row.sequence);

    expect(row.idempotencyKey).toBe(admissionDispositionIdempotencyKey(DISPOSITION_ID));
    expect(row.idempotencyKey).toContain(DISPOSITION_ID);
  });

  /**
   * A key from `randomUUID()` or `Date.now()` fails here. The schema limits `idempotencyKey` to
   * 200 characters and `dispositionId` can hold 256. Thus a long id must give a key that stays
   * in the limit and stays a deterministic function of the id.
   */
  it('AdmissionDispositionKey_SameNaturalIdentity_IsDeterministicNotRandom', () => {
    const once = admissionDispositionIdempotencyKey(DISPOSITION_ID);
    const twice = admissionDispositionIdempotencyKey(DISPOSITION_ID);
    expect(twice).toBe(once);
    expect(admissionDispositionIdempotencyKey(`${DISPOSITION_ID}-other`)).not.toBe(once);
    expect(once).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(once).not.toMatch(/\d{13}/);

    const longId = 'd'.repeat(256);
    const longKey = admissionDispositionIdempotencyKey(longId);
    expect(longKey.length).toBeLessThanOrEqual(200);
    expect(admissionDispositionIdempotencyKey(longId)).toBe(longKey);
    expect(admissionDispositionIdempotencyKey('d'.repeat(255))).not.toBe(longKey);
  });

  /**
   * The same claim key with a different fact is not a retry. The writer returns a typed
   * conflict, adds no row, and leaves the stored fact as it is.
   */
  it('AdmissionDisposition_SameKeyDifferentPayload_IsTypedConflictNotSilentSuccess', async () => {
    const first = await recordDisposition(eventStore, FIRST_TIME);
    expect(first.success).toBe(true);

    const divergent = await recordDisposition(eventStore, RETRY_TIME, {
      disposition: 'accepted-risk',
      rationale: 'A completely different adjudication under a reused id.',
    });

    expect(divergent).toMatchObject({
      success: false,
      error: {
        code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
        action: 'handleAdmissionDisagreementDisposition',
      },
    });

    const persisted = await eventStore.query(STREAM, {
      type: 'admission.disagreement-disposition',
    });
    expect(persisted.length).toBe(1);
    const stored = AdmissionDisagreementDispositionData.parse(persisted[0]!.data);
    expect(stored.disposition).toBe('explained-admission');
    expect(stored.rationale).toBe(dispositionInput().rationale);
  });
});

/**
 * The observation that the live shadow observer receives. The observer appends
 * `admission.shadow-attempt` for each shadowed edge, and it appends
 * `admission.disagreement-disposition` for each disagreement.
 */
const OBSERVATION: LegacyTransitionObservation = {
  workflowType: 'debug',
  fromPhase: 'debug-implement',
  /**
   * This edge has an obsolete guard predicate: the legacy guard always allows, and admission
   * denies. The disagreement makes one observation emit both durable facts.
   */
  toPhase: 'debug-validate',
  legacyOutcome: 'allow',
  idempotent: false,
};
const OBSERVED_STATE = {
  featureId: 'admission-idempotency-shadow',
  implementation: { complete: false },
};
const OBSERVED_AT = defaultTranslationContext('2026-07-21T21:00:00.000Z');

/**
 * Runs one observation through the observer into `store`. The observer does not await the
 * durable append, so this helper drains the append before a read.
 */
async function observeInto(store: EventStore): Promise<void> {
  observeLiveTransition(OBSERVATION, OBSERVED_STATE, {
    sink: new InMemoryLiveShadowSink(),
    context: OBSERVED_AT,
    health: new LiveShadowHealthCounter(),
    evidence: { appender: store },
  });
  await flushLiveShadowEvidence();
}

describe('DR-36 / T-49 — admission.shadow-attempt retry collapses', () => {
  const evidenceStream = liveShadowEvidenceStreamId(OBSERVED_STATE.featureId);
  let stateDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'shadow-idempotency-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await flushLiveShadowEvidence();
    eventStore.close();
    await rmrfAsync(stateDir);
  });

  /**
   * The same observation runs two times. One `admission.shadow-attempt` row survives with the
   * sequence of the first append, and its key equals the stored `shadowAttemptId`. The
   * disagreement fact from the same observation collapses in the same way.
   */
  it('ShadowAttempt_RetriedAppend_CollapsesOnIdempotencyKey', async () => {
    await observeInto(eventStore);

    const afterFirst = await eventStore.query(evidenceStream, {
      type: 'admission.shadow-attempt',
    });
    expect(afterFirst.length).toBe(1);

    await observeInto(eventStore);

    const attempts = await eventStore.query(evidenceStream, {
      type: 'admission.shadow-attempt',
    });
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.sequence).toBe(afterFirst[0]!.sequence);

    const attempt = AdmissionShadowAttemptData.parse(attempts[0]!.data);
    expect(attempt.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(attempts[0]!.idempotencyKey).toBe(attempt.shadowAttemptId);

    const dispositions = await eventStore.query(evidenceStream, {
      type: 'admission.disagreement-disposition',
    });
    expect(dispositions.length).toBe(1);
    const disposition = AdmissionDisagreementDispositionData.parse(
      dispositions[0]!.data,
    );
    expect(disposition.dispositionId).toMatch(
      /^disagreement-disposition:[0-9a-f]{64}$/,
    );
    expect(dispositions[0]!.idempotencyKey).toBe(disposition.dispositionId);
  });

  /**
   * This test does not rely on the claim ledger. A second store with an empty database must
   * derive the same key for the same observation. A random key or a wall-clock key differs here.
   */
  it('ShadowAttemptKey_SameObservation_IsDeterministicAcrossStores', async () => {
    await observeInto(eventStore);

    const otherDir = await mkdtemp(join(tmpdir(), 'shadow-idempotency-alt-'));
    const otherStore = new EventStore(otherDir);
    await otherStore.initialize();
    try {
      await observeInto(otherStore);

      const [mine] = await eventStore.query(evidenceStream, {
        type: 'admission.shadow-attempt',
      });
      const [theirs] = await otherStore.query(evidenceStream, {
        type: 'admission.shadow-attempt',
      });

      expect(theirs?.idempotencyKey).toBeDefined();
      expect(theirs!.idempotencyKey).toBe(mine!.idempotencyKey);

      const [myDisposition] = await eventStore.query(evidenceStream, {
        type: 'admission.disagreement-disposition',
      });
      const [theirDisposition] = await otherStore.query(evidenceStream, {
        type: 'admission.disagreement-disposition',
      });
      expect(theirDisposition!.idempotencyKey).toBe(myDisposition!.idempotencyKey);
    } finally {
      otherStore.close();
      await rmrfAsync(otherDir);
    }
  });
});
