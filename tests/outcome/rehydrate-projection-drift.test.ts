/**
 * Outcome test for task counts when `workflow.update` writes the `tasks` array directly.
 *
 * The test appends no `task.assigned` or `task.completed` event. The `taskProgress` of rehydrate
 * and the `completedCount` of the pipeline view must still match the task statuses in the state.
 *
 * The bare import of `projections/rehydration/index.js` registers the rehydration reducer with the
 * default registry.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import {
  handleInit,
  handleUpdate,
} from '../../src/workflow/tools.js';
import { handleRehydrate } from '../../src/workflow/rehydrate.js';
import { handleViewPipeline } from '../../src/projections/views/tools.js';
import '../../src/projections/rehydration/index.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

interface TaskProgressEntry {
  readonly id: string;
  readonly status: string;
}

describe('rehydrate projection drift outcome (#1359)', () => {
  /**
   * One update seeds two pending tasks, and a second update sets the first task to `complete`. The
   * two projections must show the statuses from the updates.
   */
  it(
    'Rehydrate_TaskProgress_TracksCanonicalTaskStatus',
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'outcome-rehydrate-drift-'),
      );
      try {
        const eventStore = new EventStore(stateDir);
        const featureId = 'outcome-1359';

        const initResult = await handleInit(
          { featureId, workflowType: 'feature' },
          stateDir,
          eventStore,
        );
        expect(initResult.success).toBe(true);

        const seedTasks = [
          { id: 'T001', title: 'first', status: 'pending', blockedBy: [] },
          { id: 'T002', title: 'second', status: 'pending', blockedBy: [] },
        ];
        const seedResult = await handleUpdate(
          { featureId, updates: { tasks: seedTasks } },
          stateDir,
          eventStore,
        );
        expect(seedResult.success).toBe(true);

        const mutatedTasks = [
          { id: 'T001', title: 'first', status: 'complete', blockedBy: [] },
          { id: 'T002', title: 'second', status: 'pending', blockedBy: [] },
        ];
        const mutateResult = await handleUpdate(
          { featureId, updates: { tasks: mutatedTasks } },
          stateDir,
          eventStore,
        );
        expect(mutateResult.success).toBe(true);

        const rehydrate = await handleRehydrate(
          { featureId },
          { eventStore, stateDir },
        );
        expect(rehydrate.success).toBe(true);
        const rehydrateDoc = rehydrate.data as {
          taskProgress: readonly TaskProgressEntry[];
        };

        const pipeline = await handleViewPipeline(
          { includeCompleted: true },
          stateDir,
          eventStore,
        );
        expect(pipeline.success).toBe(true);
        const pipelineData = pipeline.data as {
          workflows: ReadonlyArray<{
            featureId: string;
            completedCount: number;
            taskCount: number;
          }>;
        };
        const ourPipeline = pipelineData.workflows.find(
          (w) => w.featureId === featureId,
        );
        expect(ourPipeline).toBeDefined();

        const byId = new Map(
          (rehydrateDoc.taskProgress ?? []).map(
            (t) => [t.id, t.status] as const,
          ),
        );
        expect(byId.get('T001')).toBe('complete');
        expect(byId.get('T002')).toBe('pending');

        const expectedCompleted = mutatedTasks.filter(
          (t) => t.status === 'complete',
        ).length;
        expect(ourPipeline!.completedCount).toBe(expectedCompleted);
      } finally {
        await rmrfAsync(stateDir);
      }
    },
  );
});
