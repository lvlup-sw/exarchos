import type { EventStore } from './store.js';
import type { WorkflowEvent } from './schemas.js';
import type { ProjectionReducer } from '../projections/types.js';

// Shared test fixtures for decide / aggregateStream / withSession suites.
// Lives outside `*.test.ts` so importers don't pull in describe-block
// side effects when the harness collects modules.

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
