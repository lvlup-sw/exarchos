/**
 * Production-shape integration test for EventStore single-composition-root
 * (Fix 1, RCA cluster #1182).
 *
 * Phase progression:
 *   - RED: today, every orchestrate handler that wants an EventStore goes
 *     through `getOrCreateEventStore(stateDir)` (views/tools.ts), which
 *     returns a SECOND instance — a separate `sequenceCounters` Map
 *     writing to the same JSONL as the canonical `ctx.eventStore`. This
 *     test asserts the invariant that any EventStore reachable from
 *     production handlers is identical to `ctx.eventStore`, and that
 *     concurrent appends across obtain-paths preserve sequence integrity.
 *   - GREEN: after T1.3, `getOrCreateEventStore` is deleted; handlers
 *     receive `EventStore` via `DispatchContext`. The same-instance
 *     assertion is then trivially true; the integrity assertion remains
 *     as a regression test that the canonical wiring stays canonical.
 *
 * Rationale: `docs/rca/2026-04-26-v29-event-projection-cluster.md`
 * (DIM-1 + DIM-4 findings). The unit test suite never caught this bug
 * because all tests instantiated a single EventStore; production wiring
 * has two. This test boots the way `index.ts:createServer` does, so the
 * production-shape assertion is honest.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('EventStore single composition root (#1182, Fix 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-single-root-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('HandlerObtainedEventStore_IsSameInstance_AsContext', async () => {
    // The canonical production wiring: initializeContext is called once,
    // its `eventStore` field is the only EventStore the process should
    // reach. Any divergent obtain-path is a DIM-1 violation per the RCA.
    const { initializeContext } = await import('../../core/context.js');
    const ctx = await initializeContext(tmpDir);

    // The way orchestrate handlers obtain an EventStore today. After
    // T1.3, this import either no longer exists (file deleted) or no
    // longer exports `getOrCreateEventStore` — the test will then need
    // to be rewritten to drop this assertion or removed entirely. Both
    // outcomes prove the bug is fixed.
    const { getOrCreateEventStore } = await import('../../views/tools.js');
    const handlerStore = getOrCreateEventStore(tmpDir);

    expect(
      handlerStore,
      'handler-obtained EventStore must be the same instance as ctx.eventStore',
    ).toBe(ctx.eventStore);
  });

  it('ConcurrentAppends_AcrossObtainPaths_PreserveSequenceIntegrity', async () => {
    // Reproduces the #1182 corruption pattern: two EventStore instances
    // race appends to the same JSONL stream. Today this fails because
    // `getOrCreateEventStore` returns a separate instance with its own
    // `sequenceCounters` Map. After T1.3 the obtain-paths converge and
    // there is only one counter — sequences stay unique and monotonic.
    const { initializeContext } = await import('../../core/context.js');
    const { getOrCreateEventStore } = await import('../../views/tools.js');

    const ctx = await initializeContext(tmpDir);
    const handlerStore = getOrCreateEventStore(tmpDir);

    const streamId = 'integrity-test';

    // Concurrent appends — half from the canonical store, half from the
    // handler-obtained store. The interleaving exposes the duplicate-
    // sequence pattern observed in delegation-runtime-parity.events.jsonl
    // (lines 6-7: two events with sequence 6, written 2ms apart).
    await Promise.all([
      ctx.eventStore.append(streamId, {
        type: 'workflow.started',
        data: { featureId: streamId, workflowType: 'feature' },
      }),
      handlerStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['x'], patch: { x: 1 } },
      }),
      ctx.eventStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['y'], patch: { y: 2 } },
      }),
      handlerStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['z'], patch: { z: 3 } },
      }),
      ctx.eventStore.append(streamId, {
        type: 'workflow.checkpoint',
        data: { featureId: streamId, summary: 'mid-test' },
      }),
      handlerStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['w'], patch: { w: 4 } },
      }),
    ]);

    const events = await ctx.eventStore.query(streamId);
    const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);

    // Invariant 1: every sequence is unique
    expect(
      new Set(sequences).size,
      `sequences must be unique; got ${JSON.stringify(sequences)}`,
    ).toBe(sequences.length);

    // Invariant 2: sequences are 1..N contiguous (no gaps, no skips)
    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i + 1);
    }

    // Invariant 3: .seq file matches max(sequences). The seq cache is
    // the recovery anchor — if it lags, reconcile() can't catch up.
    const seqFile = path.join(tmpDir, `${streamId}.seq`);
    const seqRaw = await fs.readFile(seqFile, 'utf8');
    const seqContent = JSON.parse(seqRaw) as { sequence: number };
    expect(seqContent.sequence).toBe(Math.max(...sequences));
  });
});
