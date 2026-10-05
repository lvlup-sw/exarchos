import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { test as fcTest } from '@fast-check/vitest';
import fc from 'fast-check';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { mergeSidecarEvents, type MergeResult } from '../../../src/storage/sidecar-merger.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

/**
 * Appends one raw JSONL line to `{streamId}.hook-events.jsonl`, the sidecar
 * file that the merger reads.
 */
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
  const filePath = path.join(stateDir, `${streamId}.hook-events.jsonl`);
  await fs.appendFile(filePath, JSON.stringify(line) + '\n', 'utf-8');
}

describe('mergeSidecarEvents', () => {
  let tempDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-merger-test-'));
    eventStore = new EventStore(tempDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('mergeSidecarEvents_SingleEvent_AppendsToMainStream', async () => {
    await writeSidecarLine(tempDir, 'my-feature', {
      type: 'team.task.completed',
      data: { taskId: 'task-001', teammateName: 'worker-1' },
      idempotencyKey: 'my-feature:team.task.completed:task-001',
    });

    const result = await mergeSidecarEvents(tempDir, eventStore);

    expect(result.merged).toBe(1);
    const events = await eventStore.query('my-feature');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('team.task.completed');
    expect(events[0].idempotencyKey).toBe('my-feature:team.task.completed:task-001');
  });

  it('mergeSidecarEvents_WithIdempotencyKey_DeduplicatesOnRetry', async () => {
    const event = {
      type: 'team.task.completed' as const,
      data: { taskId: 'task-dup' },
      idempotencyKey: 'my-feature:team.task.completed:task-dup',
    };

    await writeSidecarLine(tempDir, 'my-feature', event);
    await mergeSidecarEvents(tempDir, eventStore);

    await writeSidecarLine(tempDir, 'my-feature', event);

    const result = await mergeSidecarEvents(tempDir, eventStore);

    expect(result.skipped).toBe(1);
    expect(result.merged).toBe(0);
    const events = await eventStore.query('my-feature');
    expect(events).toHaveLength(1);
  });

  it('mergeSidecarEvents_DeletesSidecarAfterMerge', async () => {
    await writeSidecarLine(tempDir, 'my-feature', {
      type: 'team.task.completed',
      data: { taskId: 'task-del' },
      idempotencyKey: 'my-feature:team.task.completed:task-del',
    });

    const sidecarPath = path.join(tempDir, 'my-feature.hook-events.jsonl');

    const statBefore = await fs.stat(sidecarPath);
    expect(statBefore.isFile()).toBe(true);

    await mergeSidecarEvents(tempDir, eventStore);

    await expect(fs.stat(sidecarPath)).rejects.toThrow();
  });

  it('mergeSidecarEvents_EmptySidecar_NoopAndDelete', async () => {
    const sidecarPath = path.join(tempDir, 'empty-stream.hook-events.jsonl');
    await fs.writeFile(sidecarPath, '', 'utf-8');

    const result = await mergeSidecarEvents(tempDir, eventStore);

    expect(result.merged).toBe(0);
    expect(result.errors).toBe(0);

    await expect(fs.stat(sidecarPath)).rejects.toThrow();
  });

  it('mergeSidecarEvents_CorruptLine_SkipsAndContinues', async () => {
    const sidecarPath = path.join(tempDir, 'corrupt-stream.hook-events.jsonl');
    const validEvent = JSON.stringify({
      type: 'team.task.completed',
      data: { taskId: 'task-ok' },
      timestamp: new Date().toISOString(),
      idempotencyKey: 'corrupt-stream:team.task.completed:task-ok',
    });
    await fs.writeFile(
      sidecarPath,
      'NOT VALID JSON\n' + validEvent + '\n',
      'utf-8',
    );

    const result = await mergeSidecarEvents(tempDir, eventStore);

    expect(result.merged).toBe(1);
    expect(result.errors).toBe(1);

    const events = await eventStore.query('corrupt-stream');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('team.task.completed');
  });

  it('mergeSidecarEvents_NoSidecarFiles_ReturnsZero', async () => {
    const result = await mergeSidecarEvents(tempDir, eventStore);

    expect(result.merged).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  fcTest.prop(
    [
      fc.array(
        fc.record({
          taskId: fc.stringMatching(/^task-[a-z0-9]{1,8}$/),
          teammateName: fc.stringMatching(/^worker-[a-z0-9]{1,4}$/),
        }),
        { minLength: 1, maxLength: 5 },
      ),
    ],
    { numRuns: 20 },
  )(
    'mergeSidecarEvents_Idempotent_RemergeProducesNoDuplicates',
    async (eventInputs) => {
      const propDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidecar-prop-'));
      const propStore = new EventStore(propDir);
      await propStore.initialize();

      try {
        for (const input of eventInputs) {
          await writeSidecarLine(propDir, 'prop-stream', {
            type: 'team.task.completed',
            data: { taskId: input.taskId, teammateName: input.teammateName },
            idempotencyKey: `prop-stream:team.task.completed:${input.taskId}`,
          });
        }

        await mergeSidecarEvents(propDir, propStore);
        const countAfterFirst = (await propStore.query('prop-stream')).length;

        for (const input of eventInputs) {
          await writeSidecarLine(propDir, 'prop-stream', {
            type: 'team.task.completed',
            data: { taskId: input.taskId, teammateName: input.teammateName },
            idempotencyKey: `prop-stream:team.task.completed:${input.taskId}`,
          });
        }

        await mergeSidecarEvents(propDir, propStore);
        const countAfterSecond = (await propStore.query('prop-stream')).length;

        expect(countAfterSecond).toBe(countAfterFirst);
      } finally {
        await rmrfAsync(propDir);
      }
    },
  );
});
