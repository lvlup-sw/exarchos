import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { AtomicAppender } from './atomic-appender.js';
import { EventStore } from './store.js';
import {
  createRegistry,
  type ProjectionRegistry,
} from '../projections/registry.js';
import type { ProjectionReducer } from '../projections/types.js';
import type { WorkflowEvent } from './schemas.js';

/**
 * Wave 3 Tasks 3.3 – 3.7 — `decide<TState>` primitive (R-2).
 *
 * The primitive's purpose: make load → fold → decide → append one
 * transactional operation with OCC baked in. Mirrors Marten's
 * `FetchForWriting<T>(streamId)` semantics on a per-stream consistency
 * boundary.
 */

// ─── Fixture reducer (stream-scoped) ─────────────────────────────────────────

export interface FixtureState {
  readonly count: number;
  readonly latest: string | undefined;
}

export function makeFixtureReducer(
  id: string,
  scope: 'stream' | 'global',
): ProjectionReducer<FixtureState, WorkflowEvent> {
  return {
    id,
    version: 1,
    scope,
    initial: { count: 0, latest: undefined },
    apply(state, event) {
      if (event.type !== 'task.assigned') return state;
      const data = event.data as { taskId?: string } | undefined;
      const tid = typeof data?.taskId === 'string' ? data.taskId : undefined;
      if (!tid) return state;
      return { count: state.count + 1, latest: tid };
    },
  };
}

export async function seedStream(
  eventStore: EventStore,
  streamId: string,
  count: number,
): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await eventStore.append(streamId, {
      type: 'task.assigned',
      data: { taskId: `T-${i}` },
    });
  }
}

describe('decide<TState> — happy-path round-trip (Task 3.3)', () => {
  let stateDir: string;
  let eventStore: EventStore;
  let appender: AtomicAppender;
  let registry: ProjectionRegistry;
  const streamId = 'feature/decide-happy';

  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(tmpdir(), 'decide-test-'));
    eventStore = new EventStore(stateDir);
    await eventStore.initialize();
    // Reuse the EventStore's underlying appender so reads + writes share
    // one SqliteBackend handle (matches how the production wiring threads
    // the singleton appender).
    appender = eventStore.getAppender() as AtomicAppender;
    registry = createRegistry();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it('Decide_CommitsEventsReturnedByDecideFunction', async () => {
    const reducer = makeFixtureReducer('fixture@v1', 'stream');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    // Seed stream with 2 events (sequences 1, 2).
    await seedStream(eventStore, streamId, 2);

    // Decide returns ONE event.
    const result = await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      (state, ctx) => {
        // The reducer fold consumed both seed events.
        expect(state.count).toBe(2);
        expect(state.latest).toBe('T-2');
        // ctx reflects the tail at fetch-time.
        expect(ctx.streamId).toBe(streamId);
        expect(ctx.version).toBe(2);
        expect(typeof ctx.now()).toBe('string');
        return [{ type: 'task.completed', data: { taskId: 'T-2' } }];
      },
      { registry },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe('committed');
    expect(result.sequences).toEqual([3]);

    // Tail is now at 3; the appended event is observable via query.
    const events = await eventStore.query(streamId);
    expect(events).toHaveLength(3);
    expect(events[2].type).toBe('task.completed');
    expect(events[2].sequence).toBe(3);
  });

  it('Decide_PassesNowFunctionForDeterministicTimestamps', async () => {
    const reducer = makeFixtureReducer('fixture@v1', 'stream');
    registry.register(
      reducer as unknown as Parameters<typeof registry.register>[0],
    );

    let observedNow: string | undefined;
    await appender.decide<FixtureState>(
      streamId,
      'fixture@v1',
      (_state, ctx) => {
        observedNow = ctx.now();
        return [];
      },
      { registry, alwaysEnforceConsistency: false },
    );

    // The now() function returns an ISO-8601 string at fetch time.
    expect(observedNow).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
