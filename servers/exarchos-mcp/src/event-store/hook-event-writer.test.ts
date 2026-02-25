import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeHookEvent, type HookEvent } from './hook-event-writer.js';

describe('writeHookEvent', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-event-writer-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writeHookEvent_ValidEvent_AppendsToSidecarFile', async () => {
    // Arrange
    const event: HookEvent = {
      type: 'team.task.completed',
      data: { taskId: 'task-001', teammateName: 'worker-1' },
    };

    // Act
    await writeHookEvent(tempDir, 'my-feature', event);

    // Assert
    const sidecarPath = path.join(tempDir, 'my-feature.hook-events.jsonl');
    const content = await fs.readFile(sidecarPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('team.task.completed');
    expect(parsed.data.taskId).toBe('task-001');
    expect(parsed.data.teammateName).toBe('worker-1');
  });

  it('writeHookEvent_NonExistentDir_CreatesFileAndAppends', async () => {
    // Arrange — stateDir exists but no sidecar file yet
    const event: HookEvent = {
      type: 'team.task.completed',
      data: { taskId: 'task-new' },
    };

    // Act
    await writeHookEvent(tempDir, 'new-stream', event);

    // Assert — file should have been created
    const sidecarPath = path.join(tempDir, 'new-stream.hook-events.jsonl');
    const stat = await fs.stat(sidecarPath);
    expect(stat.isFile()).toBe(true);

    const content = await fs.readFile(sidecarPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.type).toBe('team.task.completed');
  });

  it('writeHookEvent_MultipleEvents_AppendsInOrder', async () => {
    // Arrange
    const events: HookEvent[] = [
      { type: 'team.task.completed', data: { order: 1 } },
      { type: 'team.task.completed', data: { order: 2 } },
      { type: 'team.task.failed', data: { order: 3 } },
    ];

    // Act
    for (const event of events) {
      await writeHookEvent(tempDir, 'ordered-stream', event);
    }

    // Assert
    const sidecarPath = path.join(tempDir, 'ordered-stream.hook-events.jsonl');
    const content = await fs.readFile(sidecarPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    const parsed = lines.map((line) => JSON.parse(line));
    expect(parsed[0].data.order).toBe(1);
    expect(parsed[1].data.order).toBe(2);
    expect(parsed[2].data.order).toBe(3);
  });

  it('writeHookEvent_IncludesIdempotencyKey_KeyPresentInOutput', async () => {
    // Arrange
    const event: HookEvent = {
      type: 'team.task.completed',
      data: { taskId: 'task-idem' },
      idempotencyKey: 'my-feature:team.task.completed:task-idem',
    };

    // Act
    await writeHookEvent(tempDir, 'idem-stream', event);

    // Assert
    const sidecarPath = path.join(tempDir, 'idem-stream.hook-events.jsonl');
    const content = await fs.readFile(sidecarPath, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.idempotencyKey).toBe('my-feature:team.task.completed:task-idem');
  });

  it('writeHookEvent_IncludesTimestamp_DefaultsToNow', async () => {
    // Arrange
    const before = new Date().toISOString();
    const event: HookEvent = {
      type: 'team.task.completed',
      data: { taskId: 'task-ts' },
    };

    // Act
    await writeHookEvent(tempDir, 'ts-stream', event);

    // Assert
    const after = new Date().toISOString();
    const sidecarPath = path.join(tempDir, 'ts-stream.hook-events.jsonl');
    const content = await fs.readFile(sidecarPath, 'utf-8');
    const parsed = JSON.parse(content.trim());

    expect(parsed.timestamp).toBeDefined();
    expect(typeof parsed.timestamp).toBe('string');
    // Verify timestamp is between before and after
    expect(parsed.timestamp >= before).toBe(true);
    expect(parsed.timestamp <= after).toBe(true);
  });
});
