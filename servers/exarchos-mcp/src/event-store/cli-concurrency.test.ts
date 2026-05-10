// ─── DR-5: Concurrent CLI Invocation Safety ──────────────────────────────────
//
// Integration test: when N callers race to append events to the same feature
// stream, the resulting store must contain every event exactly once with
// monotonic sequence numbers 1..N. The EventStore's per-PID lock used to
// force non-primary processes into sidecar mode (#1082); v2.11 deleted that
// fallback, so concurrent invocations now serialize via the in-process
// append mutex / `waitForLock: true`. This test pins the end-state.
//
// History: a previous version of this test spawned `tsx` subprocesses to
// reproduce cross-process contention (see git history: spawn-driver.ts and
// the original `spawnDriver` harness). That approach broke when the substrate
// flipped to `bun:sqlite` for the SQLite backend — `tsx` runs under Node, and
// Node rejects the `bun:` URL scheme with `ERR_UNSUPPORTED_ESM_URL_SCHEME`,
// even on the JSONL-only path that this test exercises (the import graph
// pulled in the backend module unconditionally). Issue #1324 tracked the
// migration.
//
// The in-process model exercises the same `EventStore.appendValidated` path
// the spawn driver invoked. The single shared store + `Promise.all` pattern
// reproduces the same end-state property the spawned version asserted on:
// every concurrent caller's append lands in the JSONL with a unique sequence
// and its idempotency key intact, with no half-written lines.
//
// Coverage caveat: cross-PID lock contention (the PidLockError path that
// fires when a second OS process holds `.event-store.lock`) is NOT exercised
// by this test. That contract is already pinned by the dedicated
// `F-022-1 / #1082: PID-lock contention contract` block below, which seeds
// a live-PID lock file directly without spawning a child.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { EventStore, PidLockError } from './store.js';
import { buildValidatedEvent } from './event-factory.js';
import type { WorkflowEvent } from './schemas.js';

// ─── Test Harness ───────────────────────────────────────────────────────────

const STREAM_ID = 'concurrency-canary';
const CONCURRENCY = 10;

// ─── Test ──────────────────────────────────────────────────────────────────

describe('DR-5: concurrent CLI append safety', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-concurrency-'));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('ConcurrentCliEventAppend_SameFeatureId_ProducesConsistentStore', async () => {
    // Arrange: a single shared EventStore. Concurrent appends model the
    // CLI-on-CLI contention case post-#1082 — the in-process append mutex
    // serializes writers onto the same stream, just as `waitForLock: true`
    // serializes cross-process callers.
    const store = new EventStore(stateDir);
    await store.initialize();

    // Act: fire CONCURRENCY appends in parallel against the same stream,
    // each carrying a distinct idempotency key. `expectedSequence` is
    // omitted so the store assigns sequences via its monotonic counter
    // (the same path the spawn driver used).
    const appends = Array.from({ length: CONCURRENCY }, (_, i) => {
      const event = buildValidatedEvent(STREAM_ID, 1, {
        type: 'task.completed',
        data: { taskId: `t-${i}`, verified: false },
      });
      return store.appendValidated(STREAM_ID, event, {
        idempotencyKey: `concurrent-${i}`,
      });
    });
    const acks = await Promise.all(appends);

    // Sanity: every append produced a numeric sequence.
    expect(acks.length).toBe(CONCURRENCY);
    for (const ack of acks) {
      expect(typeof ack.sequence).toBe('number');
    }

    // Read back through the same store (in-process model — the original
    // subprocess version had to open a fresh EventStore because each
    // child held its own lock; here a single instance owns the lock for
    // the test lifetime). `query()` reads from the JSONL substrate, so
    // we still see exactly what was persisted.
    const events = await store.query(STREAM_ID);

    // Assertion 1: every event is present exactly once.
    expect(events.length).toBe(CONCURRENCY);

    // Assertion 2: sequences are the dense set 1..CONCURRENCY, no gaps, no dupes.
    const sequences = events.map((e) => e.sequence).sort((a, b) => a - b);
    const expected = Array.from({ length: CONCURRENCY }, (_, i) => i + 1);
    expect(sequences).toEqual(expected);

    // Assertion 3: every concurrent caller's idempotency key made it into
    // the store.
    const keys = new Set(
      events
        .map((e: WorkflowEvent) => e.idempotencyKey)
        .filter((k): k is string => typeof k === 'string'),
    );
    for (let i = 0; i < CONCURRENCY; i++) {
      expect(keys.has(`concurrent-${i}`)).toBe(true);
    }

    // Assertion 4: no half-written records. Every event round-trips
    // through `query()` with its full schema-required shape intact (type
    // tag, populated `data` payload). The original (pre-#1259/#1323)
    // version of this test parsed JSONL line-by-line; v2.11 collapsed the
    // substrate to SQLite (#1323), so the equivalent property is "every
    // queried event satisfies the WorkflowEvent shape" — half-written
    // records would either be missing fields here or fail the read
    // entirely.
    for (const ev of events) {
      expect(typeof ev.type).toBe('string');
      expect(ev.type.length).toBeGreaterThan(0);
      expect(ev.streamId).toBe(STREAM_ID);
      expect(typeof ev.timestamp).toBe('string');
    }

    // Assertion 5: no hook-event sidecar leftovers (would indicate writes
    // had been diverted out of the main store). The sidecar fallback
    // (#1082) was deleted in v2.11; this is a regression guard that the
    // file does not silently reappear.
    const sidecarPath = path.join(stateDir, `${STREAM_ID}.hook-events.jsonl`);
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  }, 60_000);
});

// ─── F-022-1 / v2.11 #1082: PID-lock contention contract ────────────────────
//
// When a CLI caller passes `waitForLock: true` and the lock remains held for
// longer than `waitForLockTimeoutMs`, `initialize()` MUST throw `PidLockError`
// so the CLI adapter can return a non-zero exit code for the operator to
// retry.
//
// When `waitForLock` is omitted (default), `initialize()` MUST throw
// `PidLockError` immediately. v2.11 (#1082) deleted the sidecar fallback
// that previously absorbed contention — the server path now hard-fails on
// lock contention so any silent mid-degradation surfaces as an explicit
// startup error.

describe('F-022-1 / #1082: PID-lock contention contract', () => {
  let seedDir: string;

  beforeEach(async () => {
    seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-pid-lock-'));
  });

  afterEach(async () => {
    await fs.rm(seedDir, { recursive: true, force: true });
  });

  /** Seed the lock file with a PID that is guaranteed to be alive. */
  async function seedLiveLock(stateDir: string): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, '.event-store.lock'),
      String(process.pid),
      'utf-8',
    );
  }

  it('CliCallerWithWaitForLockTrue_LockHeldLongerThanTimeout_ThrowsPidLockError', async () => {
    await seedLiveLock(seedDir);

    const store = new EventStore(seedDir);
    await expect(
      store.initialize({
        waitForLock: true,
        waitForLockTimeoutMs: 50,
        waitForLockInitialDelayMs: 5,
        waitForLockMaxDelayMs: 10,
      }),
    ).rejects.toBeInstanceOf(PidLockError);
  });

  it('CliCallerWithWaitForLockFalse_LockHeld_ThrowsPidLockErrorImmediately', async () => {
    await seedLiveLock(seedDir);

    // v2.11 (#1082): default-mode init hard-throws on contention. Sidecar
    // fallback was deleted alongside the JSONL substrate it side-channeled.
    const store = new EventStore(seedDir);
    const start = Date.now();
    await expect(store.initialize()).rejects.toBeInstanceOf(PidLockError);
    const elapsed = Date.now() - start;
    // Must throw fast — no fallback wait deadline.
    expect(elapsed).toBeLessThan(500);
  });
});
