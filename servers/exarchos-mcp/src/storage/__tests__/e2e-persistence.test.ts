import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import { EventStore } from '../../event-store/store.js';
import { SqliteBackend } from '../sqlite-backend.js';
import { hydrateAll } from '../hydration.js';
import { ViewMaterializer, type ViewProjection } from '../../views/materializer.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-persistence-'));
}

function makeEventInput(overrides: Record<string, unknown> = {}) {
  return {
    type: 'workflow.started' as const,
    ...overrides,
  };
}

// ─── E2E Round-Trip Tests ───────────────────────────────────────────────────

describe('E2E Persistence Round-Trip', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('roundTrip_SimpleEvents_FieldsPreservedAfterHydration', async () => {
    // Arrange: create EventStore with backend, append events
    const dbPath1 = path.join(tempDir, 'original.db');
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append 12 events via EventStore (dual-write: JSONL + SQLite)
    const appendedEvents: WorkflowEvent[] = [];
    for (let i = 0; i < 12; i++) {
      const event = await store.append('test-stream', makeEventInput({
        data: { index: i, label: `event-${i}` },
        correlationId: `corr-${i}`,
        source: 'e2e-test',
        agentId: i % 2 === 0 ? `agent-${i}` : undefined,
      }));
      appendedEvents.push(event);
    }

    // Close original backend
    backend1.close();

    // Act: create a FRESH backend from a new empty database and hydrate from JSONL
    const dbPath2 = path.join(tempDir, 'hydrated.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();

    await hydrateAll(backend2, stateDir);

    // Assert: all fields match
    const hydrated = backend2.queryEvents('test-stream');
    expect(hydrated).toHaveLength(12);

    for (let i = 0; i < appendedEvents.length; i++) {
      const original = appendedEvents[i];
      const recovered = hydrated[i];

      expect(recovered.streamId).toBe(original.streamId);
      expect(recovered.sequence).toBe(original.sequence);
      expect(recovered.type).toBe(original.type);
      expect(recovered.timestamp).toBe(original.timestamp);
      expect(recovered.correlationId).toBe(original.correlationId);
      expect(recovered.source).toBe(original.source);
      expect(recovered.schemaVersion).toBe(original.schemaVersion);
      expect(recovered.data).toEqual(original.data);
      if (original.agentId) {
        expect(recovered.agentId).toBe(original.agentId);
      }
    }

    backend2.close();
  });

  it('roundTrip_ComplexPayloads_NestedObjectsArraysNullsPreserved', async () => {
    // Arrange
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append events with complex data payloads
    const complexPayloads = [
      { nested: { deep: { value: 42 }, list: [1, 2, 3] } },
      { items: [{ name: 'a' }, { name: 'b', tags: ['x', 'y'] }] },
      { nullField: null, emptyString: '', zero: 0, falsy: false },
      { unicode: '\u00e9\u00e0\u00fc \u2603 \ud83d\ude00', special: 'line\nnewline\ttab' },
      { emptyObj: {}, emptyArr: [], nestedEmpty: { inner: {} } },
      { deeplyNested: { l1: { l2: { l3: { l4: { l5: 'deep' } } } } } },
    ];

    const appendedEvents: WorkflowEvent[] = [];
    for (const payload of complexPayloads) {
      const event = await store.append('complex-stream', makeEventInput({
        data: payload,
      }));
      appendedEvents.push(event);
    }

    backend1.close();

    // Act: fresh backend + hydrate
    const dbPath2 = path.join(tempDir, 'hydrated.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: all complex payloads preserved
    const hydrated = backend2.queryEvents('complex-stream');
    expect(hydrated).toHaveLength(complexPayloads.length);

    for (let i = 0; i < appendedEvents.length; i++) {
      expect(hydrated[i].data).toEqual(appendedEvents[i].data);
    }

    backend2.close();
  });

  it('roundTrip_MultipleStreams_HydratedIndependently', async () => {
    // Arrange
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Create events in 3 different streams
    const streamIds = ['stream-alpha', 'stream-beta', 'stream-gamma'];
    const eventCounts = [5, 3, 7];
    const appendedByStream = new Map<string, WorkflowEvent[]>();

    for (let s = 0; s < streamIds.length; s++) {
      const events: WorkflowEvent[] = [];
      for (let i = 0; i < eventCounts[s]; i++) {
        const event = await store.append(streamIds[s], makeEventInput({
          data: { stream: streamIds[s], index: i },
        }));
        events.push(event);
      }
      appendedByStream.set(streamIds[s], events);
    }

    backend1.close();

    // Act: fresh backend + hydrate
    const dbPath2 = path.join(tempDir, 'hydrated.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: each stream is independent and correct
    for (let s = 0; s < streamIds.length; s++) {
      const streamId = streamIds[s];
      const hydrated = backend2.queryEvents(streamId);
      const original = appendedByStream.get(streamId)!;

      expect(hydrated).toHaveLength(eventCounts[s]);

      for (let i = 0; i < original.length; i++) {
        expect(hydrated[i].streamId).toBe(streamId);
        expect(hydrated[i].sequence).toBe(original[i].sequence);
        expect(hydrated[i].data).toEqual(original[i].data);
      }

      // Verify sequence counter
      expect(backend2.getSequence(streamId)).toBe(eventCounts[s]);
    }

    // Verify streams don't bleed into each other
    const allStreams = backend2.listStreams();
    expect(allStreams.sort()).toEqual([...streamIds].sort());

    backend2.close();
  });

  it('roundTrip_SequenceNumbers_MonotonicAfterHydration', async () => {
    // Arrange
    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append 15 events
    for (let i = 0; i < 15; i++) {
      await store.append('seq-stream', makeEventInput({
        data: { value: i },
      }));
    }

    backend1.close();

    // Act: fresh backend + hydrate
    const dbPath2 = path.join(tempDir, 'hydrated.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Assert: sequences are strictly monotonically ascending
    const hydrated = backend2.queryEvents('seq-stream');
    expect(hydrated).toHaveLength(15);

    for (let i = 0; i < hydrated.length; i++) {
      expect(hydrated[i].sequence).toBe(i + 1);
      if (i > 0) {
        expect(hydrated[i].sequence).toBeGreaterThan(hydrated[i - 1].sequence);
      }
    }

    // getSequence should match the last event's sequence
    expect(backend2.getSequence('seq-stream')).toBe(15);

    backend2.close();
  });

  it('roundTrip_ViewMaterialization_IdenticalFromHydratedAndDirectWrite', async () => {
    // Arrange: a simple counter projection for verifying view materialization
    const counterProjection: ViewProjection<{ count: number; types: string[] }> = {
      init: () => ({ count: 0, types: [] }),
      apply: (view, event) => ({
        count: view.count + 1,
        types: [...view.types, event.type],
      }),
    };

    const stateDir = path.join(tempDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const dbPath1 = path.join(tempDir, 'original.db');
    const backend1 = new SqliteBackend(dbPath1);
    backend1.initialize();
    const store = new EventStore(stateDir, { backend: backend1 });

    // Append events with different types
    const eventTypes: Array<'workflow.started' | 'task.assigned' | 'task.completed' | 'gate.executed'> = [
      'workflow.started',
      'task.assigned',
      'task.completed',
      'gate.executed',
      'task.assigned',
      'task.completed',
    ];

    for (const type of eventTypes) {
      await store.append('view-stream', { type, data: {} });
    }

    // Materialize view from direct-write backend
    const materializer1 = new ViewMaterializer();
    materializer1.register('counter', counterProjection);
    const directEvents = backend1.queryEvents('view-stream');
    const directView = materializer1.materialize<{ count: number; types: string[] }>(
      'view-stream',
      'counter',
      directEvents,
    );

    backend1.close();

    // Act: hydrate into fresh backend
    const dbPath2 = path.join(tempDir, 'hydrated.db');
    const backend2 = new SqliteBackend(dbPath2);
    backend2.initialize();
    await hydrateAll(backend2, stateDir);

    // Materialize view from hydrated backend
    const materializer2 = new ViewMaterializer();
    materializer2.register('counter', counterProjection);
    const hydratedEvents = backend2.queryEvents('view-stream');
    const hydratedView = materializer2.materialize<{ count: number; types: string[] }>(
      'view-stream',
      'counter',
      hydratedEvents,
    );

    // Assert: views are identical
    expect(hydratedView).toEqual(directView);
    expect(hydratedView.count).toBe(eventTypes.length);
    expect(hydratedView.types).toEqual(eventTypes);

    backend2.close();
  });
});
