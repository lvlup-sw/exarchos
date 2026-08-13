/**
 * RF-3 (#1510 review): tests for the SHARED onboard event seam,
 * `buildOnboardEventCtx`. This logic was previously DUPLICATED in
 * `verbs/doctor/index.ts` and `verbs/doctor/index.ts`; it is the
 * most safety-critical code in the feature (the CAS-pin idempotency trap is
 * sidestepped by construction). These tests run it against a REAL on-disk
 * EventStore so the tail-cut + plain-append behavior is locked in ONE place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../../src/events/store.js';
import type { DispatchContext } from '../../../../../src/dispatch/core/dispatch.js';
import { ONBOARD_STREAM_ID } from '../../../../../src/dispatch/core/infra-streams.js';
import { buildOnboardEventCtx } from '../../../../../src/dispatch/core/onboarding/event-ctx.js';
import type { OnboardExecuted, OnboardRequested } from '../../../../../src/events/schemas.js';
import { rmrfAsync } from '../../../../../tools/test-helpers/temp-dir.js';

interface Fixture {
  readonly base: string;
  readonly ctx: DispatchContext;
  readonly eventStore: EventStore;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(path.join(tmpdir(), 'event-ctx-'));
  const stateDir = path.join(base, 'state');
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  const ctx: DispatchContext = { stateDir, eventStore, enableTelemetry: false };
  return { base, ctx, eventStore };
}

const requested = (key: string): OnboardRequested => ({
  trigger: 'onboard',
  plan: { steps: [] },
  idempotencyKey: key,
});

const executed = (key: string): OnboardExecuted => ({
  trigger: 'onboard',
  result: { applied: [], skipped: [], residual: [], advisories: [] },
  idempotencyKey: key,
  durationMs: 1,
});

describe('buildOnboardEventCtx (shared seam, RF-3 #1510)', () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await createFixture();
  });

  afterEach(async () => {
    await rmrfAsync(fx.base).catch(
      () => {},
    );
  });

  it('emit appends to the onboard stream as a PLAIN append (no CAS pin)', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    await seam.emit({ type: 'onboard.requested', data: requested('k1') });

    const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
    expect(events.map((e) => e.type)).toEqual(['onboard.requested']);
    // Plain append: a second emit never reproduces a CAS conflict.
    await expect(
      seam.emit({ type: 'onboard.executed', data: executed('k1') }),
    ).resolves.toBeUndefined();
  });

  it('readStreamTail returns the FRESH tail after the last onboard.executed', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    // A completed prior run (requested + executed) — must be BELOW the cut.
    await seam.emit({ type: 'onboard.requested', data: requested('old') });
    await seam.emit({ type: 'onboard.executed', data: executed('old') });
    // A fresh dangling request AFTER the last executed — must be in the tail.
    await seam.emit({ type: 'onboard.requested', data: requested('new') });

    const tail = await seam.readStreamTail();
    expect(tail.map((e) => e.type)).toEqual(['onboard.requested']);
    expect((tail[0].data as OnboardRequested).idempotencyKey).toBe('new');
  });

  it('readStreamTail is empty when the most recent event is an onboard.executed', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    await seam.emit({ type: 'onboard.requested', data: requested('done') });
    await seam.emit({ type: 'onboard.executed', data: executed('done') });

    // A completed run's pair sits BELOW the cut → fresh runs see an empty tail
    // (so they reconcile drift rather than idempotency-collapsing).
    const tail = await seam.readStreamTail();
    expect(tail).toHaveLength(0);
  });
});
