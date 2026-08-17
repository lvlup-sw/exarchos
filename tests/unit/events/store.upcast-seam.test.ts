import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// #1556 wiring proof. Mock the read-time upcasting seam so it stamps every
// event it folds. If EventStore.query / queryByType route their backend rows
// through migrateEvents (the single choke point the no-bypass gate enforces),
// the stamp MUST appear on read. The behavioural upcasting logic itself is
// proven in event-migration.test.ts with fixture migrations; this file proves
// only that the store readers are wired to the seam.
vi.mock('../../../src/events/event-migration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/events/event-migration.js')>();
  return {
    ...actual,
    migrateEvents: vi.fn((events: ReadonlyArray<Record<string, unknown>>) =>
      events.map((e) => ({ ...e, _seamApplied: true })),
    ),
  };
});

import { EventStore } from '../../../src/events/store.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('EventStore read-time upcasting seam (#1556)', () => {
  let tempDir: string;
  let store: EventStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'exarchos-upcast-seam-'));
    store = new EventStore(tempDir);
    await store.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  it('Query_BackendRows_RoutedThroughMigrateEventsSeam', async () => {
    await store.append('feat-x', { type: 'workflow.started', data: { featureId: 'feat-x' } });

    const events = await store.query('feat-x');

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>)._seamApplied).toBe(true);
  });

  it('QueryByType_SqliteFastPath_RoutedThroughMigrateEventsSeam', async () => {
    await store.append('feat-y', { type: 'task.assigned', data: { taskId: 't1' } });
    await store.append('feat-y/sub', { type: 'task.assigned', data: { taskId: 't2' } });

    const events = await store.queryByType('task.assigned', { streamPrefix: 'feat-y' });

    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const e of events) {
      expect((e as Record<string, unknown>)._seamApplied).toBe(true);
    }
  });
});
