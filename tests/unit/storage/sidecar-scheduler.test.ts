import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import {
  startPeriodicMerge,
  type DrainResult,
  type PeriodicMergeHandle,
} from '../../../src/storage/sidecar-scheduler.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

const SIDECAR_SUFFIX = '.hook-events.jsonl';

/** Appends one raw JSONL line to the sidecar file of a stream. */
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

/** Lists the directory entries whose name contains `suffix`. */
async function listFiles(dir: string, suffix: string): Promise<string[]> {
  const entries = await fs.readdir(dir);
  return entries.filter((f) => f.includes(suffix));
}

describe('startPeriodicMerge', () => {
  let tempDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-scheduler-test-'));
    eventStore = new EventStore(tempDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('startPeriodicMerge_ReturnsCleanupHandle', async () => {
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000);
    try {
      expect(handle).toBeDefined();
      expect(typeof handle.stop).toBe('function');
    } finally {
      handle.stop();
    }
  });

  /** With `immediate: true`, the first drain completes before `startPeriodicMerge` returns. */
  it('startPeriodicMerge_FiresImmediatelyWhenImmediate', async () => {
    await writeSidecarLine(tempDir, 'imm-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-imm-1' },
      idempotencyKey: 'imm-stream:team.task.completed:task-imm-1',
    });

    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    try {
      const events = await eventStore.query('imm-stream');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('team.task.completed');

      const sidecarFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(sidecarFiles).toHaveLength(0);
    } finally {
      handle.stop();
    }
  });

  /**
   * After the drain, no sidecar file and no drain file remain, and the store
   * holds the event. The test does not observe the rename itself.
   */
  it('startPeriodicMerge_DrainRenamesThenProcessesThenUnlinks', async () => {
    await writeSidecarLine(tempDir, 'drain-stream', {
      type: 'team.task.completed',
      data: { taskId: 'task-drain-1' },
      idempotencyKey: 'drain-stream:team.task.completed:task-drain-1',
    });

    const beforeFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
    expect(beforeFiles).toHaveLength(1);

    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    try {
      const afterSidecar = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(afterSidecar).toHaveLength(0);

      const allFiles = await fs.readdir(tempDir);
      const drainFiles = allFiles.filter((f) => f.includes('.drain-'));
      expect(drainFiles).toHaveLength(0);

      const events = await eventStore.query('drain-stream');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('team.task.completed');
      expect(events[0].idempotencyKey).toBe('drain-stream:team.task.completed:task-drain-1');
    } finally {
      handle.stop();
    }
  });

  /** After `stop()`, no drain runs, so the sidecar file stays. */
  it('startPeriodicMerge_CleanupStopsInterval', async () => {
    vi.useFakeTimers();
    try {
      const handle = await startPeriodicMerge(tempDir, eventStore, 1000);

      await writeSidecarLine(tempDir, 'stop-stream', {
        type: 'team.task.completed',
        data: { taskId: 'task-stop-1' },
        idempotencyKey: 'stop-stream:team.task.completed:task-stop-1',
      });

      handle.stop();

      await vi.advanceTimersByTimeAsync(5000);

      const sidecarFiles = await listFiles(tempDir, SIDECAR_SUFFIX);
      expect(sidecarFiles).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The test writes the second batch after the first drain returns. Then a
   * second scheduler drains that batch.
   */
  it('startPeriodicMerge_ConcurrentWritesDuringDrain_NoEventLoss', async () => {
    const totalEvents = 10;
    for (let i = 0; i < totalEvents; i++) {
      await writeSidecarLine(tempDir, 'concurrent-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-concurrent-${i}` },
        idempotencyKey: `concurrent-stream:team.task.completed:task-concurrent-${i}`,
      });
    }

    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });

    const additionalEvents = 5;
    for (let i = totalEvents; i < totalEvents + additionalEvents; i++) {
      await writeSidecarLine(tempDir, 'concurrent-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-concurrent-${i}` },
        idempotencyKey: `concurrent-stream:team.task.completed:task-concurrent-${i}`,
      });
    }

    handle.stop();
    const handle2 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle2.stop();

    const events = await eventStore.query('concurrent-stream');
    expect(events).toHaveLength(totalEvents + additionalEvents);

    const taskIds = events.map((e) => (e.data as Record<string, unknown>).taskId as string);
    for (let i = 0; i < totalEvents + additionalEvents; i++) {
      expect(taskIds).toContain(`task-concurrent-${i}`);
    }
  });

  /** The second drain reads the same idempotency keys again and must add no event. */
  it('startPeriodicMerge_ConcurrentWritesDuringDrain_NoDuplicates', async () => {
    const eventCount = 5;
    for (let i = 0; i < eventCount; i++) {
      await writeSidecarLine(tempDir, 'dedup-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-dedup-${i}` },
        idempotencyKey: `dedup-stream:team.task.completed:task-dedup-${i}`,
      });
    }

    const handle1 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle1.stop();

    for (let i = 0; i < eventCount; i++) {
      await writeSidecarLine(tempDir, 'dedup-stream', {
        type: 'team.task.completed',
        data: { taskId: `task-dedup-${i}` },
        idempotencyKey: `dedup-stream:team.task.completed:task-dedup-${i}`,
      });
    }

    const handle2 = await startPeriodicMerge(tempDir, eventStore, 60_000, { immediate: true });
    handle2.stop();

    const events = await eventStore.query('dedup-stream');
    expect(events).toHaveLength(eventCount);

    const keys = events
      .map((e) => e.idempotencyKey)
      .filter(Boolean);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(eventCount);
  });

  /** The store already holds the first event, so the drain merges one event and skips one. */
  it('startPeriodicMerge_EmitsObservability', async () => {
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

    await eventStore.append(
      'obs-stream',
      { type: 'team.task.completed', data: { taskId: 'task-obs-1' } },
      { idempotencyKey: 'obs-stream:team.task.completed:task-obs-1' },
    );

    let drainResult: DrainResult | undefined;
    const handle = await startPeriodicMerge(tempDir, eventStore, 60_000, {
      immediate: true,
      onDrain: (result) => { drainResult = result; },
    });
    handle.stop();

    expect(drainResult).toBeDefined();
    expect(typeof drainResult!.merged).toBe('number');
    expect(typeof drainResult!.skipped).toBe('number');
    expect(typeof drainResult!.errors).toBe('number');
    expect(typeof drainResult!.durationMs).toBe('number');
    expect(drainResult!.durationMs).toBeGreaterThanOrEqual(0);

    expect(drainResult!.merged).toBe(1);
    expect(drainResult!.skipped).toBe(1);
    expect(drainResult!.errors).toBe(0);
  });
});
