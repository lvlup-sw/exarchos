/**
 * Tests for `buildOnboardEventCtx`, the shared onboard event seam. They use a real on-disk
 * `EventStore`, so one file pins the plain append and the tail cut.
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

  /** A plain append has no expected sequence, so a second emit cannot cause a CAS conflict. */
  it('emit appends to the onboard stream as a PLAIN append (no CAS pin)', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    await seam.emit({ type: 'onboard.requested', data: requested('k1') });

    const events = await fx.eventStore.query(ONBOARD_STREAM_ID);
    expect(events.map((e) => e.type)).toEqual(['onboard.requested']);
    await expect(
      seam.emit({ type: 'onboard.executed', data: executed('k1') }),
    ).resolves.toBeUndefined();
  });

  /** The completed `old` pair sits before the cut. The dangling `new` request after it is the tail. */
  it('readStreamTail returns the FRESH tail after the last onboard.executed', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    await seam.emit({ type: 'onboard.requested', data: requested('old') });
    await seam.emit({ type: 'onboard.executed', data: executed('old') });
    await seam.emit({ type: 'onboard.requested', data: requested('new') });

    const tail = await seam.readStreamTail();
    expect(tail.map((e) => e.type)).toEqual(['onboard.requested']);
    expect((tail[0].data as OnboardRequested).idempotencyKey).toBe('new');
  });

  /**
   * The pair of a completed run sits before the cut. Thus a new run sees an empty tail and
   * reconciles the current drift.
   */
  it('readStreamTail is empty when the most recent event is an onboard.executed', async () => {
    const seam = buildOnboardEventCtx(fx.ctx);
    await seam.emit({ type: 'onboard.requested', data: requested('done') });
    await seam.emit({ type: 'onboard.executed', data: executed('done') });

    const tail = await seam.readStreamTail();
    expect(tail).toHaveLength(0);
  });
});
