// ─── DR-36 / T-49 — every new admission append carries a natural-identity key ─
//
// INV-8 ("idempotency at the boundary") is a `mode: audit` invariant: it has no
// mechanical checker. T-31/T-32 added two NEW durable production appends
// (`admission.shadow-attempt`, `admission.disagreement-disposition`) and the
// shipped typed writer appended with no `idempotencyKey` at all, so a retry
// duplicated the fact instead of collapsing onto it. THIS FILE IS THE
// MECHANICAL BACKSTOP for that: nothing else in the build will catch a
// regression to unkeyed (or randomly-keyed) admission appends.
//
// ANTI-VACUITY: every assertion is made against rows READ BACK OUT of a real
// file-backed `EventStore` after a real second append. Nothing here mocks the
// store, and no test asserts merely that a key string was computed — the
// retry actually runs through the substrate's claim ledger, and the row count
// is what proves the collapse.
//
// ── The two authorities this file compares (DR-30) ──────────────────────────
//
// AUTHORITY A — THE RETURNED ENVELOPES. What the shipped typed writer
//   (`handleAdmissionDisagreementDisposition`) hands back on each of the two
//   dispatches. The retry is a genuinely NEW dispatch — fresh operationId, a
//   LATER `resolvedAt` — so only the natural identity is stable across them.
//
// AUTHORITY B — THE DURABLE ROWS. What `eventStore.query(STREAM, …)` reads
//   back off disk afterwards: the row count, `timestamp`, `sequence` and the
//   stored `idempotencyKey`. This side never sees Authority A's in-memory
//   value. It crosses the durability boundary and comes back through the
//   store's own read path.
//
// The two sides do share a module graph — the writer appends THROUGH the
// store — and that is stated plainly rather than hidden: what makes them
// independent is that neither is computed from the other AT COMPARISON TIME.
// Side B is re-read from bytes on disk by a query the writer never touches.
// So they can disagree, in two concrete ways this file would catch:
//
//   • Drop the `idempotencyKey` (the exact T-31/T-32 regression this file
//     backstops) and the retry appends a SECOND row: Authority A comes back
//     with the retry's own `sequence`/`recordedAt`, while Authority B holds
//     two rows whose first still says `FIRST_TIME`.
//   • Mint the key with `randomUUID()`/`Date.now()` instead of the natural
//     identity and the key recomputed in-test by
//     `admissionDispositionIdempotencyKey(DISPOSITION_ID)` no longer matches
//     the `idempotencyKey` on the row read back off disk.
//
// @oracle-sources: the envelopes the shipped typed writer returns on two independent dispatches, the durable rows re-read off disk by the file-backed event store

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createInMemoryResolver } from '../capabilities/resolver.js';
import {
  deriveMcpCallerIdentity,
  snapshotCallerAuthorization,
} from '../dispatch/caller-identity.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { EventStore } from './store.js';
import {
  AdmissionDisagreementDispositionData,
  AdmissionShadowAttemptData,
} from './schemas.js';
import {
  admissionDispositionIdempotencyKey,
  handleAdmissionDisagreementDisposition,
} from './tools.js';
import { defaultTranslationContext } from '../workflow/admission/legacy-state-translation.js';
import {
  InMemoryLiveShadowSink,
  LiveShadowHealthCounter,
  flushLiveShadowEvidence,
  liveShadowEvidenceStreamId,
  observeLiveTransition,
} from '../workflow/admission/live-shadow-observer.js';
import type { LegacyTransitionObservation } from '../workflow/admission/shadow-decision.js';

const STREAM = 'phase-gate-t49-admission-idempotency';
const FIRST_TIME = '2026-07-21T21:00:00.000Z';
/** A LATER instant for the retry, so "the stored row won" is observable. */
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

/** Record one disposition through the REAL typed writer under a fresh dispatch. */
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
  // A genuine retry is a NEW dispatch: fresh operationId, fresh resolvedAt.
  // Only the natural identity (`dispositionId`) is stable across the two.
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

  it('AdmissionDisposition_ReplayedAppend_ReturnsStoredResultNotDuplicate', async () => {
    const first = await recordDisposition(eventStore, FIRST_TIME);
    expect(first.success).toBe(true);

    // THE RETRY: same logical disposition, later instant, new dispatch.
    const replay = await recordDisposition(eventStore, RETRY_TIME);
    expect(replay.success).toBe(true);

    // ── The canonical STORED RESULT came back, not a second row. ──────────
    expect(replay.data).toEqual(first.data);

    const persisted = await eventStore.query(STREAM, {
      type: 'admission.disagreement-disposition',
    });
    expect(persisted.length).toBe(1);

    const row = persisted[0]!;
    // The stored row is the FIRST append: the replay did not overwrite it and
    // did not land beside it.
    expect(row.timestamp).toBe(FIRST_TIME);
    expect(AdmissionDisagreementDispositionData.parse(row.data).recordedAt).toBe(
      FIRST_TIME,
    );
    expect((first.data as { sequence: number }).sequence).toBe(row.sequence);

    // ── The claim key is the NATURAL identity, read back off the row. ─────
    expect(row.idempotencyKey).toBe(admissionDispositionIdempotencyKey(DISPOSITION_ID));
    expect(row.idempotencyKey).toContain(DISPOSITION_ID);
  });

  it('AdmissionDispositionKey_SameNaturalIdentity_IsDeterministicNotRandom', () => {
    // A future refactor to `randomUUID()`/`Date.now()` fails HERE, loudly:
    // recomputing the key for the same natural identity must be stable across
    // calls, and distinct identities must stay distinct.
    const once = admissionDispositionIdempotencyKey(DISPOSITION_ID);
    const twice = admissionDispositionIdempotencyKey(DISPOSITION_ID);
    expect(twice).toBe(once);
    expect(admissionDispositionIdempotencyKey(`${DISPOSITION_ID}-other`)).not.toBe(once);
    // Not a UUID and not wall-clock derived.
    expect(once).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i);
    expect(once).not.toMatch(/\d{13}/);

    // The schema bounds `idempotencyKey` at 200 chars while `dispositionId`
    // may be 256; the derivation must stay inside the bound AND stay a
    // deterministic function of the id.
    const longId = 'd'.repeat(256);
    const longKey = admissionDispositionIdempotencyKey(longId);
    expect(longKey.length).toBeLessThanOrEqual(200);
    expect(admissionDispositionIdempotencyKey(longId)).toBe(longKey);
    expect(admissionDispositionIdempotencyKey('d'.repeat(255))).not.toBe(longKey);
  });

  it('AdmissionDisposition_SameKeyDifferentPayload_IsTypedConflictNotSilentSuccess', async () => {
    const first = await recordDisposition(eventStore, FIRST_TIME);
    expect(first.success).toBe(true);

    // Same claim key, DIFFERENT fact: not a retry — a second, silently
    // different write hiding behind an existing claim.
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

    // Never a duplicate row, and the stored fact is untouched.
    const persisted = await eventStore.query(STREAM, {
      type: 'admission.disagreement-disposition',
    });
    expect(persisted.length).toBe(1);
    const stored = AdmissionDisagreementDispositionData.parse(persisted[0]!.data);
    expect(stored.disposition).toBe('explained-admission');
    expect(stored.rationale).toBe(dispositionInput().rationale);
  });
});

// ─── The observer's two durable appends ──────────────────────────────────────
//
// `admission.shadow-attempt` (every shadowed edge) and
// `admission.disagreement-disposition` (disagreements only) are appended by
// the live shadow observer. The store handed to it here is a REAL
// `EventStore`; the observer, the shadow adjudication and the identity
// derivation are all production code.

const OBSERVATION: LegacyTransitionObservation = {
  workflowType: 'debug',
  fromPhase: 'debug-implement',
  // The P06-01 obsolete predicate: legacy always allows, admission denies —
  // a disagreement, so BOTH durable facts are emitted for one observation.
  toPhase: 'debug-validate',
  legacyOutcome: 'allow',
  idempotent: false,
};
const OBSERVED_STATE = {
  featureId: 'admission-idempotency-shadow',
  implementation: { complete: false },
};
const OBSERVED_AT = defaultTranslationContext('2026-07-21T21:00:00.000Z');

/** One full observation through the real observer into a real store. */
async function observeInto(store: EventStore): Promise<void> {
  observeLiveTransition(OBSERVATION, OBSERVED_STATE, {
    sink: new InMemoryLiveShadowSink(),
    context: OBSERVED_AT,
    health: new LiveShadowHealthCounter(),
    evidence: { appender: store },
  });
  // The durable append is fire-and-forget; drain it before reading back.
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

  it('ShadowAttempt_RetriedAppend_CollapsesOnIdempotencyKey', async () => {
    await observeInto(eventStore);

    const afterFirst = await eventStore.query(evidenceStream, {
      type: 'admission.shadow-attempt',
    });
    expect(afterFirst.length).toBe(1);

    // THE RETRY: the same logical observation, appended a second time.
    await observeInto(eventStore);

    const attempts = await eventStore.query(evidenceStream, {
      type: 'admission.shadow-attempt',
    });
    expect(attempts.length).toBe(1);
    // The surviving row is the one the first append persisted, verbatim.
    expect(attempts[0]!.sequence).toBe(afterFirst[0]!.sequence);

    // The claim key IS the natural identity of the attempt — read back off
    // the persisted row, not off the object we appended.
    const attempt = AdmissionShadowAttemptData.parse(attempts[0]!.data);
    expect(attempt.shadowAttemptId).toMatch(/^shadow-attempt:[0-9a-f]{64}$/);
    expect(attempts[0]!.idempotencyKey).toBe(attempt.shadowAttemptId);

    // The disagreement fact emitted by the SAME observation collapses too.
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

  it('ShadowAttemptKey_SameObservation_IsDeterministicAcrossStores', async () => {
    // Determinism proved WITHOUT relying on the claim ledger: an independent
    // store, with its own empty database, must derive the identical key for
    // the identical observation. A random (or wall-clock) key differs here.
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
