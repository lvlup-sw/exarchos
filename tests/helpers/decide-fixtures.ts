/**
 * Shared fixtures for the `decide`, `aggregateStream` and `withSession` suites.
 *
 * The file is not a `*.test.ts` file, so an import of it runs no `describe` block. It is
 * outside `src/`, because `seedStream` appends `task.assigned`. Inside the governed root,
 * each emitter census reads that append as a shipped emitter.
 */
import type { EventStore } from '../../src/events/store.js';
import type { WorkflowEvent } from '../../src/events/schemas.js';
import type { ProjectionReducer } from '../../src/projections/types.js';

export interface FixtureState {
  readonly count: number;
  readonly latest: string | undefined;
}

export function makeFixtureReducer(
  id: string,
  scope: 'stream' = 'stream',
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
