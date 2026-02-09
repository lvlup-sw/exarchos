import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SyncEngine } from '../../sync/engine.js';
import { Outbox } from '../../sync/outbox.js';
import { SyncStateManager } from '../../sync/sync-state.js';
import { ConflictResolver } from '../../sync/conflict.js';
import { EventStore } from '../../event-store/store.js';
import type { BasileusClient } from '../../sync/client.js';
import type { SyncConfig } from '../../sync/types.js';

function mockClient(overrides?: Record<string, unknown>): BasileusClient {
  return {
    appendEvents: vi.fn().mockResolvedValue({ accepted: 1, streamVersion: 1 }),
    registerWorkflow: vi.fn(),
    getEventsSince: vi.fn().mockResolvedValue([]),
    getPipeline: vi.fn(),
    getPendingCommands: vi.fn(),
    ...overrides,
  } as unknown as BasileusClient;
}

const defaultConfig: SyncConfig = {
  mode: 'dual',
  syncIntervalMs: 30000,
  batchSize: 50,
  maxRetries: 10,
  remote: {
    apiBaseUrl: 'https://api.test',
    apiToken: 'test-token',
    exarchosId: 'test',
    timeoutMs: 5000,
  },
};

describe('SyncEngine', () => {
  let tempDir: string;
  let outbox: Outbox;
  let syncState: SyncStateManager;
  let conflictResolver: ConflictResolver;
  let eventStore: EventStore;
  let client: BasileusClient;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'engine-test-'));
    outbox = new Outbox(tempDir);
    syncState = new SyncStateManager(tempDir);
    conflictResolver = new ConflictResolver();
    eventStore = new EventStore(tempDir);
    client = mockClient();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createEngine(
    clientOverride?: BasileusClient,
    configOverride?: Partial<SyncConfig>,
  ): SyncEngine {
    return new SyncEngine(
      clientOverride ?? client,
      eventStore,
      outbox,
      conflictResolver,
      syncState,
      { ...defaultConfig, ...configOverride },
    );
  }

  // ─── pushEvents ────────────────────────────────────────────────────────

  describe('pushEvents', () => {
    it('should drain outbox and update HWM on success', async () => {
      const engine = createEngine();

      await outbox.addEntry('test-stream', {
        streamId: 'test-stream',
        sequence: 1,
        timestamp: '2026-02-08T00:00:00.000Z',
        type: 'task.completed',
        schemaVersion: '1.0',
      });

      const result = await engine.pushEvents('test-stream');

      expect(result.count).toBe(1);
      expect(result.errors).toHaveLength(0);

      const state = await syncState.load('test-stream');
      expect(state.localHighWaterMark).toBe(1);
    });

    it('should return noop when no outbox entries', async () => {
      const engine = createEngine();

      const result = await engine.pushEvents('test-stream');

      expect(result.count).toBe(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should return partial result with errors on client failure', async () => {
      const failClient = mockClient({
        appendEvents: vi.fn().mockRejectedValue(new Error('server down')),
      });
      const engine = createEngine(failClient);

      await outbox.addEntry('test-stream', {
        streamId: 'test-stream',
        sequence: 1,
        timestamp: '2026-02-08T00:00:00.000Z',
        type: 'task.completed',
        schemaVersion: '1.0',
      });

      const result = await engine.pushEvents('test-stream');

      expect(result.count).toBe(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // ─── pullEvents ────────────────────────────────────────────────────────

  describe('pullEvents', () => {
    it('should fetch from client and append locally', async () => {
      const pullClient = mockClient({
        getEventsSince: vi.fn().mockResolvedValue([
          {
            streamId: 'test-stream',
            sequence: 1,
            timestamp: '2026-02-08T00:00:00.000Z',
            type: 'workflow.started',
            source: 'remote',
            schemaVersion: '1.0',
            data: { featureId: 'test' },
          },
        ]),
      });
      const engine = createEngine(pullClient);

      const result = await engine.pullEvents('test-stream');

      expect(result.count).toBe(1);
      expect(result.conflicts).toHaveLength(0);

      const events = await eventStore.query('test-stream');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('workflow.started');
    });

    it('should return noop when no new events', async () => {
      const engine = createEngine();

      const result = await engine.pullEvents('test-stream');

      expect(result.count).toBe(0);
      expect(result.conflicts).toHaveLength(0);
    });

    it('should update remoteHWM after pulling', async () => {
      const pullClient = mockClient({
        getEventsSince: vi.fn().mockResolvedValue([
          {
            streamId: 'test-stream',
            sequence: 5,
            timestamp: '2026-02-08T00:00:00.000Z',
            type: 'task.completed',
            schemaVersion: '1.0',
          },
        ]),
      });
      const engine = createEngine(pullClient);

      await engine.pullEvents('test-stream');

      const state = await syncState.load('test-stream');
      expect(state.remoteHighWaterMark).toBe(5);
    });

    it('should delegate conflict detection to resolver', async () => {
      // Add a local event first
      await eventStore.append('test-stream', {
        type: 'phase.transitioned',
        data: { from: 'ideate', to: 'plan' },
      });

      const pullClient = mockClient({
        getEventsSince: vi.fn().mockResolvedValue([
          {
            streamId: 'test-stream',
            sequence: 1,
            timestamp: '2026-02-08T00:00:00.000Z',
            type: 'phase.transitioned',
            schemaVersion: '1.0',
            data: { from: 'ideate', to: 'delegate' },
          },
        ]),
      });
      const engine = createEngine(pullClient);

      const result = await engine.pullEvents('test-stream');

      expect(result.conflicts.length).toBeGreaterThan(0);
    });
  });

  // ─── sync ──────────────────────────────────────────────────────────────

  describe('sync', () => {
    it('should run push then pull for direction=both', async () => {
      const dualClient = mockClient({
        getEventsSince: vi.fn().mockResolvedValue([
          {
            streamId: 'test-stream',
            sequence: 1,
            timestamp: '2026-02-08T00:00:00.000Z',
            type: 'task.completed',
            schemaVersion: '1.0',
          },
        ]),
      });
      const engine = createEngine(dualClient);

      await outbox.addEntry('test-stream', {
        streamId: 'test-stream',
        sequence: 1,
        timestamp: '2026-02-08T00:00:00.000Z',
        type: 'workflow.started',
        schemaVersion: '1.0',
      });

      const result = await engine.sync('test-stream', 'both');

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(1);

      const state = await syncState.load('test-stream');
      expect(state.lastSyncAt).toBeTruthy();
      expect(state.lastSyncResult).toBe('success');
    });

    it('should only push when direction=push', async () => {
      const engine = createEngine();

      await outbox.addEntry('test-stream', {
        streamId: 'test-stream',
        sequence: 1,
        timestamp: '2026-02-08T00:00:00.000Z',
        type: 'workflow.started',
        schemaVersion: '1.0',
      });

      const result = await engine.sync('test-stream', 'push');

      expect(result.pushed).toBe(1);
      expect(result.pulled).toBe(0);
    });

    it('should only pull when direction=pull', async () => {
      const pullClient = mockClient({
        getEventsSince: vi.fn().mockResolvedValue([
          {
            streamId: 'test-stream',
            sequence: 1,
            timestamp: '2026-02-08T00:00:00.000Z',
            type: 'task.completed',
            schemaVersion: '1.0',
          },
        ]),
      });
      const engine = createEngine(pullClient);

      const result = await engine.sync('test-stream', 'pull');

      expect(result.pushed).toBe(0);
      expect(result.pulled).toBe(1);
    });
  });
});
