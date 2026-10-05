/**
 * The `EventStore` has one composition root.
 *
 * Every handler receives the `EventStore` through `DispatchContext`. No
 * module-global factory exists that can create a second instance.
 * `tools/audit/gates/check-event-store-composition-root.mjs` rejects a
 * `new EventStore(...)` outside the documented entry points.
 *
 * This suite pins the runtime side: concurrent appends to one stream keep
 * unique and contiguous sequences.
 *
 * Rationale: `docs/rca/2026-04-26-v29-event-projection-cluster.md`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('EventStore single composition root (#1182, Fix 1)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'es-single-root-'));
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * The views tools module must export no module-global `EventStore` factory
   * and no registry. Then `ctx.eventStore` is the only instance in a bootstrap.
   * Each `initializeContext` call builds a new `EventStore` by design, so the
   * test does not compare the stores of two calls.
   */
  it('InitializeContext_ReturnsSingleEventStore_PerStateDir', async () => {
    const toolsModule = await import('../../../src/projections/views/tools.js');
    expect(
      (toolsModule as Record<string, unknown>).getOrCreateEventStore,
      'getOrCreateEventStore must not exist — handlers receive EventStore via DispatchContext',
    ).toBeUndefined();
    expect(
      (toolsModule as Record<string, unknown>).registerCanonicalEventStore,
      'registerCanonicalEventStore must not exist — no module-global registry',
    ).toBeUndefined();
  });

  /**
   * One `EventStore` serves the process, so concurrent appends get unique and
   * contiguous sequences. The SQLite `sequences` table holds the durable
   * counter, and it must equal the highest observed sequence.
   */
  it('ConcurrentAppends_SingleInstance_PreserveSequenceIntegrity', async () => {
    const { initializeContext } = await import('../../../src/dispatch/core/context.js');
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

    const sqlite = ctx.eventStore.getAppender().getSqliteBackend();
    if (!sqlite) throw new Error('SQLite backend not initialized after appends');
    expect(sqlite.readSequenceHighWaterMark(streamId)).toBe(Math.max(...sequences));
  });
});
