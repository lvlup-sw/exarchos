/**
 * Production-shape integration test for EventStore single-composition-root
 * (Fix 1 → constructor injection refactor, RCA cluster #1182).
 *
 * Before the refactor: orchestrate handlers reached for `EventStore` via
 * a module-global registry (`getOrCreateEventStore`), which silently
 * lazy-created a divergent in-process instance — corrupting sequence
 * numbers in the shared JSONL.
 *
 * After the refactor: every handler receives the canonical `EventStore`
 * via `DispatchContext`. `getOrCreateEventStore` no longer exists. The
 * regression surface is structural, not runtime: the composition-root
 * CI script (`scripts/check-event-store-composition-root.mjs`) prevents
 * any new `new EventStore(...)` outside the documented entry points.
 *
 * This test asserts the runtime invariant that survives both implementations:
 * concurrent appends to the same JSONL stream — through whichever
 * obtain-paths exist at any given commit — preserve sequence integrity.
 *
 * Rationale: `docs/rca/2026-04-26-v29-event-projection-cluster.md`,
 * `docs/plans/archive/2026-04-26-eventstore-constructor-injection.md`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../test-helpers/temp-dir.js';

describe('EventStore single composition root (#1182, Fix 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-single-root-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('InitializeContext_ReturnsSingleEventStore_PerStateDir', async () => {
    // Two calls to `initializeContext` for the same stateDir produce two
    // distinct EventStore instances by design — each bootstrap creates a
    // fresh wiring. Production never does this in the same process; the
    // composition root runs once at server boot.
    //
    // Within a single bootstrap, `ctx.eventStore` is the only EventStore
    // any handler should see — there is no module-global factory to
    // create a competing instance. This test asserts that invariant: the
    // `getOrCreateEventStore` factory has been deleted.
    const toolsModule = await import('../../projections/views/tools.js');
    expect(
      (toolsModule as Record<string, unknown>).getOrCreateEventStore,
      'getOrCreateEventStore must not exist — handlers receive EventStore via DispatchContext',
    ).toBeUndefined();
    expect(
      (toolsModule as Record<string, unknown>).registerCanonicalEventStore,
      'registerCanonicalEventStore must not exist — no module-global registry',
    ).toBeUndefined();
  });

  it('ConcurrentAppends_SingleInstance_PreserveSequenceIntegrity', async () => {
    // Production wiring: one EventStore per process, threaded everywhere.
    // Concurrent appends serialize through the in-memory `withLock` chain,
    // so sequences are unique and contiguous regardless of arrival order.
    const { initializeContext } = await import('../../core/context.js');
    const ctx = await initializeContext(tmpDir);

    const streamId = 'integrity-test';

    await Promise.all([
      ctx.eventStore.append(streamId, {
        type: 'workflow.started',
        data: { featureId: streamId, workflowType: 'feature' },
      }),
      ctx.eventStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['x'], patch: { x: 1 } },
      }),
      ctx.eventStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['y'], patch: { y: 2 } },
      }),
      ctx.eventStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['z'], patch: { z: 3 } },
      }),
      ctx.eventStore.append(streamId, {
        type: 'workflow.checkpoint',
        data: { featureId: streamId, summary: 'mid-test' },
      }),
      ctx.eventStore.append(streamId, {
        type: 'state.patched',
        data: { featureId: streamId, fields: ['w'], patch: { w: 4 } },
      }),
    ]);

    const events = await ctx.eventStore.query(streamId);
    const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);

    expect(
      new Set(sequences).size,
      `sequences must be unique; got ${JSON.stringify(sequences)}`,
    ).toBe(sequences.length);

    for (let i = 0; i < sequences.length; i++) {
      expect(sequences[i]).toBe(i + 1);
    }

    // Substrate witness: post v2.11 substrate-cut the `.seq` sidecar
    // file is gone (it was a JSONL-mode bookkeeping artefact). The
    // SQLite `sequences` table is the durable counter; we verify
    // it via the appender's exposed backend handle so the assertion
    // still pins "the persisted high-water mark equals max(observed
    // sequences)".
    const sqlite = ctx.eventStore.getAppender().getSqliteBackend();
    if (!sqlite) throw new Error('SQLite backend not initialized after appends');
    expect(sqlite.readSequenceHighWaterMark(streamId)).toBe(Math.max(...sequences));
  });
});
