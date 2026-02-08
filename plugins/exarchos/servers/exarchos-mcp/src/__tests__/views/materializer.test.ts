import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ViewMaterializer } from '../../views/materializer.js';
import { SnapshotStore } from '../../views/snapshot-store.js';
import type { ViewProjection } from '../../views/materializer.js';
import type { WorkflowEvent } from '../../event-store/schemas.js';

// ─── Test View: simple counter ─────────────────────────────────────────────

interface CounterView {
  count: number;
  lastType: string;
}

const counterProjection: ViewProjection<CounterView> = {
  init: () => ({ count: 0, lastType: '' }),
  apply: (view, event) => ({
    count: view.count + 1,
    lastType: event.type,
  }),
};

function makeEvent(seq: number, type: string, streamId = 'test-stream'): WorkflowEvent {
  return {
    streamId,
    sequence: seq,
    timestamp: new Date().toISOString(),
    type,
    schemaVersion: '1.0',
  };
}

// ─── A07: View Materializer Engine ─────────────────────────────────────────

describe('ViewMaterializer', () => {
  let materializer: ViewMaterializer;

  beforeEach(() => {
    materializer = new ViewMaterializer();
  });

  describe('ProcessEvents_UpdatesView', () => {
    it('should process events through a registered projection and update view state', () => {
      materializer.register('counter', counterProjection);

      const events = [
        makeEvent(1, 'workflow.started'),
        makeEvent(2, 'task.assigned'),
        makeEvent(3, 'task.completed'),
      ];

      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);

      expect(view.count).toBe(3);
      expect(view.lastType).toBe('task.completed');
    });
  });

  describe('IncrementalUpdate_OnlyProcessesNewEvents', () => {
    it('should only process events past the high-water mark on subsequent calls', () => {
      materializer.register('counter', counterProjection);

      const batch1 = [
        makeEvent(1, 'event.one'),
        makeEvent(2, 'event.two'),
        makeEvent(3, 'event.three'),
        makeEvent(4, 'event.four'),
        makeEvent(5, 'event.five'),
      ];

      // First materialization: processes all 5
      const view1 = materializer.materialize<CounterView>('test-stream', 'counter', batch1);
      expect(view1.count).toBe(5);

      // Second batch: events 1-5 plus 3 new ones (6, 7, 8)
      const batch2 = [
        ...batch1,
        makeEvent(6, 'event.six'),
        makeEvent(7, 'event.seven'),
        makeEvent(8, 'event.eight'),
      ];

      // Incremental materialization: should only process 3 new events
      const view2 = materializer.materialize<CounterView>('test-stream', 'counter', batch2);
      expect(view2.count).toBe(8);
      expect(view2.lastType).toBe('event.eight');
    });
  });

  describe('EmptyStream_ReturnsDefaultView', () => {
    it('should return the default view state when no events are provided', () => {
      materializer.register('counter', counterProjection);

      const view = materializer.materialize<CounterView>('empty-stream', 'counter', []);

      expect(view.count).toBe(0);
      expect(view.lastType).toBe('');
    });
  });

  describe('MultipleViews', () => {
    it('should support multiple registered projections independently', () => {
      interface TypeCollector {
        types: string[];
      }

      const typeProjection: ViewProjection<TypeCollector> = {
        init: () => ({ types: [] }),
        apply: (view, event) => ({ types: [...view.types, event.type] }),
      };

      materializer.register('counter', counterProjection);
      materializer.register('types', typeProjection);

      const events = [
        makeEvent(1, 'workflow.started'),
        makeEvent(2, 'task.assigned'),
      ];

      const counter = materializer.materialize<CounterView>('test-stream', 'counter', events);
      const types = materializer.materialize<TypeCollector>('test-stream', 'types', events);

      expect(counter.count).toBe(2);
      expect(types.types).toEqual(['workflow.started', 'task.assigned']);
    });
  });

  describe('UnregisteredView', () => {
    it('should throw when materializing an unregistered view', () => {
      expect(() =>
        materializer.materialize('test-stream', 'nonexistent', []),
      ).toThrow();
    });
  });

  describe('HighWaterMark_PerStream', () => {
    it('should track high-water marks independently per stream', () => {
      materializer.register('counter', counterProjection);

      const streamAEvents = [makeEvent(1, 'a.one'), makeEvent(2, 'a.two')];
      const streamBEvents = [makeEvent(1, 'b.one')];

      const viewA = materializer.materialize<CounterView>('stream-a', 'counter', streamAEvents);
      const viewB = materializer.materialize<CounterView>('stream-b', 'counter', streamBEvents);

      expect(viewA.count).toBe(2);
      expect(viewB.count).toBe(1);

      // Add more to stream-a, stream-b unchanged
      const moreA = [...streamAEvents, makeEvent(3, 'a.three')];
      const viewA2 = materializer.materialize<CounterView>('stream-a', 'counter', moreA);
      const viewB2 = materializer.materialize<CounterView>('stream-b', 'counter', streamBEvents);

      expect(viewA2.count).toBe(3);
      expect(viewB2.count).toBe(1);
    });
  });
});

// ─── A10: View Snapshot Mechanism ──────────────────────────────────────────

describe('SnapshotStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'snapshot-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('should save and load a snapshot', async () => {
    const store = new SnapshotStore(tempDir);
    const viewData: CounterView = { count: 42, lastType: 'event.last' };

    await store.save('my-stream', 'counter', viewData, 42);

    const snapshot = await store.load<CounterView>('my-stream', 'counter');
    expect(snapshot).toBeDefined();
    expect(snapshot!.view.count).toBe(42);
    expect(snapshot!.view.lastType).toBe('event.last');
    expect(snapshot!.highWaterMark).toBe(42);
  });

  it('should return undefined for nonexistent snapshot', async () => {
    const store = new SnapshotStore(tempDir);
    const snapshot = await store.load<CounterView>('nonexistent', 'counter');
    expect(snapshot).toBeUndefined();
  });

  it('should overwrite previous snapshot', async () => {
    const store = new SnapshotStore(tempDir);

    await store.save('my-stream', 'counter', { count: 10, lastType: 'a' }, 10);
    await store.save('my-stream', 'counter', { count: 20, lastType: 'b' }, 20);

    const snapshot = await store.load<CounterView>('my-stream', 'counter');
    expect(snapshot!.view.count).toBe(20);
    expect(snapshot!.highWaterMark).toBe(20);
  });
});

describe('ViewMaterializer with Snapshots', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'materializer-snapshot-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('After50Events_CreatesSnapshot', () => {
    it('should create a snapshot file after processing 50 events', async () => {
      const snapshotStore = new SnapshotStore(tempDir);
      const materializer = new ViewMaterializer({ snapshotStore, snapshotInterval: 50 });
      materializer.register('counter', counterProjection);

      const events = Array.from({ length: 50 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      materializer.materialize<CounterView>('test-stream', 'counter', events);

      // Allow async snapshot write to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const snapshot = await snapshotStore.load<CounterView>('test-stream', 'counter');
      expect(snapshot).toBeDefined();
      expect(snapshot!.highWaterMark).toBe(50);
      expect(snapshot!.view.count).toBe(50);
    });
  });

  describe('WithSnapshot_RebuildsFromSnapshot', () => {
    it('should rebuild from snapshot and only process new events', async () => {
      const snapshotStore = new SnapshotStore(tempDir);

      // Save a snapshot at sequence 50
      await snapshotStore.save(
        'test-stream',
        'counter',
        { count: 50, lastType: 'event.50' },
        50,
      );

      // New materializer loads snapshot
      const materializer = new ViewMaterializer({ snapshotStore, snapshotInterval: 50 });
      materializer.register('counter', counterProjection);

      // Load from snapshot
      await materializer.loadFromSnapshot('test-stream', 'counter');

      // Feed 60 events total (50 already snapshotted + 10 new)
      const events = Array.from({ length: 60 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);

      // Should have 50 (from snapshot) + 10 (new events) = 60
      expect(view.count).toBe(60);
      expect(view.lastType).toBe('event.60');
    });
  });

  describe('CorruptSnapshot_RebuildsFromScratch', () => {
    it('should rebuild from scratch when snapshot is corrupt', async () => {
      const snapshotStore = new SnapshotStore(tempDir);

      // Write a corrupt snapshot file directly
      const snapshotPath = path.join(tempDir, 'test-stream.counter.snapshot.json');
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(snapshotPath), { recursive: true });
      await writeFile(snapshotPath, 'not valid json{{{', 'utf-8');

      const materializer = new ViewMaterializer({ snapshotStore, snapshotInterval: 50 });
      materializer.register('counter', counterProjection);

      // loadFromSnapshot should handle corrupt gracefully
      await materializer.loadFromSnapshot('test-stream', 'counter');

      // Process events from scratch
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);

      // Should rebuild from scratch: 10 events processed
      expect(view.count).toBe(10);
    });
  });
});
