import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  describe('hasProjection', () => {
    it('should return true for a registered projection', () => {
      materializer.register('counter', counterProjection);
      expect(materializer.hasProjection('counter')).toBe(true);
    });

    it('should return false for an unregistered projection', () => {
      expect(materializer.hasProjection('nonexistent')).toBe(false);
    });

    it('should return false after checking a name that was never registered', () => {
      materializer.register('counter', counterProjection);
      expect(materializer.hasProjection('other')).toBe(false);
    });
  });

  describe('getProjection', () => {
    it('should return the projection for a registered view name', () => {
      materializer.register('counter', counterProjection);
      const projection = materializer.getProjection<CounterView>('counter');
      expect(projection).toBeDefined();
      expect(projection).toBe(counterProjection);
    });

    it('should return undefined for an unregistered view name', () => {
      const projection = materializer.getProjection<CounterView>('nonexistent');
      expect(projection).toBeUndefined();
    });

    it('should return the correct projection when multiple are registered', () => {
      interface OtherView { value: string }
      const otherProjection: ViewProjection<OtherView> = {
        init: () => ({ value: '' }),
        apply: (view, event) => ({ value: event.type }),
      };

      materializer.register('counter', counterProjection);
      materializer.register('other', otherProjection);

      expect(materializer.getProjection('counter')).toBe(counterProjection);
      expect(materializer.getProjection('other')).toBe(otherProjection);
    });
  });

  describe('getState', () => {
    it('should return undefined when no state has been materialized', () => {
      const state = materializer.getState<CounterView>('test-stream', 'counter');
      expect(state).toBeUndefined();
    });

    it('should return the cached view state after materialization', () => {
      materializer.register('counter', counterProjection);
      const events = [makeEvent(1, 'event.one'), makeEvent(2, 'event.two')];
      materializer.materialize<CounterView>('test-stream', 'counter', events);

      const state = materializer.getState<CounterView>('test-stream', 'counter');
      expect(state).toBeDefined();
      expect(state!.view.count).toBe(2);
      expect(state!.view.lastType).toBe('event.two');
      expect(state!.highWaterMark).toBe(2);
    });

    it('should return undefined for a different stream that has not been materialized', () => {
      materializer.register('counter', counterProjection);
      materializer.materialize<CounterView>('stream-a', 'counter', [makeEvent(1, 'a')]);

      const state = materializer.getState<CounterView>('stream-b', 'counter');
      expect(state).toBeUndefined();
    });
  });

  describe('loadState', () => {
    it('should load pre-existing state that can be retrieved with getState', () => {
      const preloaded: CounterView = { count: 100, lastType: 'preloaded' };
      materializer.loadState('test-stream', 'counter', preloaded, 100);

      const state = materializer.getState<CounterView>('test-stream', 'counter');
      expect(state).toBeDefined();
      expect(state!.view.count).toBe(100);
      expect(state!.view.lastType).toBe('preloaded');
      expect(state!.highWaterMark).toBe(100);
    });

    it('should allow materialize to continue from loaded state', () => {
      materializer.register('counter', counterProjection);
      const preloaded: CounterView = { count: 50, lastType: 'event.50' };
      materializer.loadState('test-stream', 'counter', preloaded, 50);

      // Feed events 1-55; only 51-55 should be processed incrementally
      const events = Array.from({ length: 55 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );
      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);

      expect(view.count).toBe(55); // 50 preloaded + 5 new
      expect(view.lastType).toBe('event.55');
    });

    it('should overwrite previously loaded state', () => {
      materializer.loadState('test-stream', 'counter', { count: 10, lastType: 'a' }, 10);
      materializer.loadState('test-stream', 'counter', { count: 20, lastType: 'b' }, 20);

      const state = materializer.getState<CounterView>('test-stream', 'counter');
      expect(state!.view.count).toBe(20);
      expect(state!.highWaterMark).toBe(20);
    });
  });

  describe('materialize_WithoutSnapshotStore', () => {
    it('should work correctly without a snapshot store configured', () => {
      // Default materializer has no snapshot store
      materializer.register('counter', counterProjection);

      const events = Array.from({ length: 100 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      // Should not throw even though we exceed the default snapshot interval
      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);
      expect(view.count).toBe(100);
      expect(view.lastType).toBe('event.100');
    });
  });

  describe('materialize_SnapshotIntervalNotCrossed', () => {
    it('should not create a snapshot when interval has not been crossed', async () => {
      const snapshotStore = new SnapshotStore(tmpdir());
      const saveSpy = vi.spyOn(snapshotStore, 'save');

      const mat = new ViewMaterializer({ snapshotStore, snapshotInterval: 50 });
      mat.register('counter', counterProjection);

      // Process only 10 events — well below the 50-event interval
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      mat.materialize<CounterView>('test-stream', 'counter', events);

      // save should NOT have been called since we're below the interval
      expect(saveSpy).not.toHaveBeenCalled();

      saveSpy.mockRestore();
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

  describe('NoSnapshotStore_SkipsSnapshotting', () => {
    it('should process 100+ events without error when no snapshotStore is configured', () => {
      const materializer = new ViewMaterializer();
      materializer.register('counter', counterProjection);

      const events = Array.from({ length: 110 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      const view = materializer.materialize<CounterView>('test-stream', 'counter', events);

      expect(view.count).toBe(110);
      expect(view.lastType).toBe('event.110');
    });
  });

  describe('SnapshotIntervalNotCrossed_NoSnapshotCreated', () => {
    it('should not create a snapshot when event count is below the interval', async () => {
      const snapshotStore = new SnapshotStore(tempDir);
      const materializer = new ViewMaterializer({ snapshotStore, snapshotInterval: 50 });
      materializer.register('counter', counterProjection);

      // Process only 10 events (below the 50-event snapshot interval)
      const events = Array.from({ length: 10 }, (_, i) =>
        makeEvent(i + 1, `event.${i + 1}`),
      );

      materializer.materialize<CounterView>('test-stream', 'counter', events);

      // Allow async operations to settle
      await new Promise((resolve) => setTimeout(resolve, 50));

      const snapshot = await snapshotStore.load<CounterView>('test-stream', 'counter');
      expect(snapshot).toBeUndefined();
    });
  });
});
