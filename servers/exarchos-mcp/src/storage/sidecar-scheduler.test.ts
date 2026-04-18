import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../event-store/store.js';
import {
  startPeriodicMerge,
  type DrainResult,
  type PeriodicMergeHandle,
} from './sidecar-scheduler.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const SIDECAR_SUFFIX = '.hook-events.jsonl';

/** Write a raw sidecar JSONL line directly (bypasses writeHookEvent for precise control). */
async function writeSidecarLine(
  stateDir: string,
  streamId: string,
  event: { type: string; data: Record<string, unknown>; idempotencyKey?: string; timestamp?: string },
): Promise<void> {
  const line: Record<string, unknown> = {
    type: event.type,
    data: event.data,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  if (event.idempotencyKey) line.idempotencyKey = event.idempotencyKey;
  const filePath = path.join(stateDir, `${streamId}${SIDECAR_SUFFIX}`);
  await fs.appendFile(filePath, JSON.stringify(line) + '\n', 'utf-8');
}

/** List files in a directory matching a suffix. */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.includes(suffix));
}

// ─── Test Suite ─────────────────────────────────────────────────────────────

describe('startPeriodicMerge', () => {
  let tempDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-scheduler-test-'));
    eventStore = new EventStore(tempDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ─── Test 1: Returns cleanup handle ──────────────────────────────────────

  it('startPeriodicMerge_ReturnsCleanupHandle', async () => {
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000);
    try {
      expect(handle).toBeDefined();
      expect(typeof handle.stop).toBe('function');
    } finally {
      handle.stop();
    }
  });

  // ─── Test 2: Fires immediately when immediate: true ──────────────────────

  it('startPeriodicMerge_FiresImmediatelyWhenImmediate', async () => {
    // Arrange: write a sidecar event
    await writeSidecarLine(tempDir, 'imm-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-imm-1' },
      idempotencyKey: 'imm-stream:team.task.completed:task-imm-1',
    });

    // Act: start with immediate: true -- first drain fires before returning
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    try {
      // Assert: sidecar event should already be merged
      const events = await eventStore.query('imm-stream');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('team.task.completed');

      // The original sidecar file should be gone (processed and unlinked)
      const sidecarFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(sidecarFiles).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  // ─── Test 3: Drain renames, processes, then unlinks ──────────────────────

  it('startPeriodicMerge_DrainRenamesThenProcessesThenUnlinks', async () => {
    // Arrange: write a sidecar event
    await writeSidecarLine(tempDir, 'drain-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-drain-1' },
      idempotencyKey: 'drain-stream:team.task.completed:task-drain-1',
    });

    // Verify sidecar file exists before drain
    const beforeFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
    expect(beforeFiles).toHaveLength(1);

    // Act: run one drain cycle via immediate mode
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    try {
      // Assert: original sidecar file is gone
      const afterSidecar = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(afterSidecar).toHaveLength(0);

      // Assert: no drain files remain (they should be unlinked after processing)
      const allFiles = await fs.readdir(tempDir);
      const drainFiles = allFiles.filter((f) => f.includes('.drain-'));
      expect(drainFiles).toHaveLength(0);

      // Assert: events merged into EventStore
      const events = await eventStore.query('drain-stream');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('team.task.completed');
      expect(events[0].idempotencyKey).toBe('drain-stream:team.task.completed:task-drain-1');
    } finally {
      handle.stop();
    }
  });

  // ─── Test 4: Cleanup stops interval ──────────────────────────────────────

  it('startPeriodicMerge_CleanupStopsInterval', async () => {
    vi.useFakeTimers();
    try {
      const handle = await startPeriodicMerge(tempDir, eventStore, 1000);

      // Write a sidecar event after starting the scheduler
      await writeSidecarLine(tempDir, 'stop-stream', {
        type: 'team.task.completed',
        data: { taskId: 'task-stop-1' },
        idempotencyKey: 'stop-stream:team.task.completed:task-stop-1',
      });

      // Stop the scheduler before the interval fires
      handle.stop();

      // Advance time past multiple intervals
      await vi.advanceTimersByTimeAsync(5000);

      // The sidecar file should still exist (no drain occurred after stop)
      const sidecarFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(sidecarFiles).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ─── Test 5: Concurrent writes during drain -- no event loss ─────────────

  it('startPeriodicMerge_ConcurrentWritesDuringDrain_NoEventLoss', async () => {
    // Arrange: write initial sidecar events
    const totalEvents = 10;
    for (let i = 0; i < totalEvents; i++) {
      await writeSidecarLine(tempDir, 'concurrent-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-concurrent-${i}` },
        idempotencyKey: `concurrent-stream:team.task.completed:task-concurrent-${i}`,
      });
    }

    // Act: run drain with immediate
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });

    // Write more events concurrently (simulating sidecar writes during/after drain)
    const additionalEvents = 5;
    for (let i = totalEvents; i < totalEvents + additionalEvents; i++) {
      await writeSidecarLine(tempDir, 'concurrent-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-concurrent-${i}` },
        idempotencyKey: `concurrent-stream:team.task.completed:task-concurrent-${i}`,
      });
    }

    // Run another drain cycle manually by stopping and restarting with immediate
    handle.stop();
    const handle2 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle2.stop();

    // Assert: ALL events should be present
    const events = await eventStore.query('concurrent-stream');
    expect(events).toHaveLength(totalEvents + additionalEvents);

    // Verify no gaps in task IDs
    const taskIds = events.map((e) => (e.data as Record<string, unknown>).taskId as string);
    for (let i = 0; i < totalEvents + additionalEvents; i++) {
      expect(taskIds).toContain(`task-concurrent-${i}`);
    }
  });

  // ─── Test 6: Concurrent writes during drain -- no duplicates ─────────────

  it('startPeriodicMerge_ConcurrentWritesDuringDrain_NoDuplicates', async () => {
    // Arrange: write sidecar events with specific idempotency keys
    const eventCount = 5;
    for (let i = 0; i < eventCount; i++) {
      await writeSidecarLine(tempDir, 'dedup-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-dedup-${i}` },
        idempotencyKey: `dedup-stream:team.task.completed:task-dedup-${i}`,
      });
    }

    // Act: drain once
    const handle1 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle1.stop();

    // Write the SAME events again (simulating retry/double-write)
    for (let i = 0; i < eventCount; i++) {
      await writeSidecarLine(tempDir, 'dedup-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-dedup-${i}` },
        idempotencyKey: `dedup-stream:team.task.completed:task-dedup-${i}`,
      });
    }

    // Drain again
    const handle2 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle2.stop();

    // Assert: exactly eventCount events (no duplicates)
    const events = await eventStore.query('dedup-stream');
    expect(events).toHaveLength(eventCount);

    // Verify each idempotency key appears exactly once
    const keys = events
      .map((e) => e.idempotencyKey)
      .filter(Boolean);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(eventCount);
  });

  // ─── Test 7: Emits observability ─────────────────────────────────────────

  it('startPeriodicMerge_EmitsObservability', async () => {
    // Arrange: write sidecar events (some that will merge, some that will dedup)
    await writeSidecarLine(tempDir, 'obs-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-obs-1' },
      idempotencyKey: 'obs-stream:team.task.completed:task-obs-1',
    });
    await writeSidecarLine(tempDir, 'obs-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-obs-2' },
      idempotencyKey: 'obs-stream:team.task.completed:task-obs-2',
    });

    // Pre-merge one event so the second drain will have a skip
    await eventStore.append(
      'obs-stream',
      { type: 'team.task.completed', data: { taskId: 'task-obs-1' } },
      { idempotencyKey: 'obs-stream:team.task.completed:task-obs-1' },
    );

    // Act: drain with immediate and capture the result via onDrain callback
    let drainResult: DrainResult | undefined;
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, {
      immediate: true,
      onDrain: (result) => { drainResult = result; },
    });
    handle.stop();

    // Assert: observability data is present
    expect(drainResult).toBeDefined();
    expect(typeof drainResult!.merged).toBe('number');
    expect(typeof drainResult!.skipped).toBe('number');
    expect(typeof drainResult!.errors).toBe('number');
    expect(typeof drainResult!.durationMs).toBe('number');
    expect(drainResult!.durationMs).toBeGreaterThanOrEqual(0);

    // Should have merged 1 new event and skipped 1 duplicate
    expect(drainResult!.merged).toBe(1);
    expect(drainResult!.skipped).toBe(1);
    expect(drainResult!.errors).toBe(0);
  });
});
