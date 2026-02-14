import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventStore } from './store.js';
import { handleEventQuery, resetModuleEventStore } from './tools.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'event-tools-test-'));
  resetModuleEventStore();
});

afterEach(async () => {
  resetModuleEventStore();
  await rm(tempDir, { recursive: true, force: true });
});

// ─── Prototype Pollution Prevention ─────────────────────────────────────────

describe('handleEventQuery field projection', () => {
  it('should filter out __proto__ from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started', data: { foo: 'bar' } });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', '__proto__', 'sequence'] },
      tempDir,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).toHaveProperty('sequence', 1);
    expect(projected[0]).not.toHaveProperty('__proto__');
  });

  it('should filter out constructor from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'constructor'] },
      tempDir,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).not.toHaveProperty('constructor');
  });

  it('should filter out prototype from fields', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'prototype'] },
      tempDir,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type', 'workflow.started');
    expect(projected[0]).not.toHaveProperty('prototype');
  });

  it('should return empty projection when all fields are unsafe', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', { type: 'workflow.started' });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['__proto__', 'constructor', 'prototype'] },
      tempDir,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(Object.keys(projected[0])).toHaveLength(0);
  });

  it('should allow safe fields through', async () => {
    const store = new EventStore(tempDir);
    await store.append('my-workflow', {
      type: 'workflow.started',
      data: { featureId: 'test' },
    });

    const result = await handleEventQuery(
      { stream: 'my-workflow', fields: ['type', 'sequence', 'streamId', 'timestamp'] },
      tempDir,
    );

    expect(result.success).toBe(true);
    const projected = result.data as Record<string, unknown>[];
    expect(projected).toHaveLength(1);
    expect(projected[0]).toHaveProperty('type');
    expect(projected[0]).toHaveProperty('sequence');
    expect(projected[0]).toHaveProperty('streamId');
    expect(projected[0]).toHaveProperty('timestamp');
  });
});
