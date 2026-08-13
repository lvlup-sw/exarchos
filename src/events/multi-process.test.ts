// ─── A5: Cross-process MCP test — two EventStore instances ───────────────────
//
// Pins the post-Wave-A (PID lock demotion, #1343) contract for EventStore:
//
//   1. Two EventStore instances against the same stateDir BOTH initialize()
//      successfully — no PidLockError, no file-system exclusion.
//   2. Interleaved appends from both instances produce a consistent, gapless
//      sequence (1, 2, 3) on the shared stream: every write from every
//      instance lands in the correct order.
//   3. No `.event-store.lock` file is left in stateDir after the test — the
//      PID lock was deleted outright in Wave A; its presence is a regression.
//
// INV-3 LOW (forward-compat note): this test is substrate-only. It does not
// reference `.event-store.lock` path construction, does not assume process-local
// PID file paths, and does not mock SQLite. The DB file at
// `${stateDir}/<store>.db` is the only shared resource.
//
// The in-process pattern mirrors the approach in `store.race.test.ts` and
// `cli-concurrency.test.ts`: two EventStore instances constructed from the
// same stateDir simulate two independent OS processes attaching to the same
// SQLite file. Cross-process serialization is delegated to SQLite WAL +
// BEGIN IMMEDIATE + the (stream_id, sequence) PRIMARY KEY.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore } from './store.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

describe('EventStore cross-process attach (#1343, Wave A5)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eventstore-multiproc-'));
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('EventStore_TwoProcesses_InterleavedAppendsAreObservedByBoth', async () => {
    const STREAM_ID = 'multi-process-stream';

    // ─── Arrange: two independent EventStore instances, same stateDir ────────
    //
    // Simulates two OS processes (or two MCP server instances) attaching to
    // the same SQLite database. Pre-Wave-A the second initialize() would have
    // thrown PidLockError('live-holder'). Post-Wave-A both must resolve cleanly.
    const storeA = new EventStore(stateDir);
    const storeB = new EventStore(stateDir);

    await expect(storeA.initialize()).resolves.toBeUndefined();
    await expect(storeB.initialize()).resolves.toBeUndefined();

    // ─── Act: interleaved appends ─────────────────────────────────────────────
    //
    // Instance A appends event 1, instance B appends event 2, instance A
    // appends event 3. Sequential (await each) to produce a deterministic
    // append order; the substrate must reflect exactly sequences 1, 2, 3.
    const ack1 = await storeA.append(STREAM_ID, {
      type: 'task.assigned',
      data: { source: 'storeA', step: 1 },
    });
    const ack2 = await storeB.append(STREAM_ID, {
      type: 'task.completed',
      data: { source: 'storeB', step: 2 },
    });
    const ack3 = await storeA.append(STREAM_ID, {
      type: 'workflow.transition',
      data: { source: 'storeA', step: 3 },
    });

    // Sequence assignments must be monotonically increasing in append order.
    expect(ack1.sequence).toBe(1);
    expect(ack2.sequence).toBe(2);
    expect(ack3.sequence).toBe(3);

    // ─── Assert: both instances observe all three events in order ─────────────
    //
    // query() reads directly from the SQLite substrate; both EventStore
    // instances share the same DB file, so either can see the full stream.
    const eventsFromA = await storeA.query(STREAM_ID);
    const eventsFromB = await storeB.query(STREAM_ID);

    // Both instances must see all three events.
    expect(eventsFromA).toHaveLength(3);
    expect(eventsFromB).toHaveLength(3);

    // Sequences must be dense 1..3 in correct append order.
    const seqsA = eventsFromA.map((e) => e.sequence);
    const seqsB = eventsFromB.map((e) => e.sequence);
    expect(seqsA).toEqual([1, 2, 3]);
    expect(seqsB).toEqual([1, 2, 3]);

    // Event types must reflect the correct append order (per-step tag).
    expect(eventsFromA[0].type).toBe('task.assigned');
    expect(eventsFromA[1].type).toBe('task.completed');
    expect(eventsFromA[2].type).toBe('workflow.transition');

    // ─── Assert: no .event-store.lock file ───────────────────────────────────
    //
    // Wave A deleted the PID lock; its presence indicates a regression.
    // fs.access rejects with ENOENT when the path does not exist — that is
    // the expected post-Wave-A state.
    const lockPath = path.join(stateDir, '.event-store.lock');
    await expect(fs.access(lockPath)).rejects.toThrow();
  });
});
