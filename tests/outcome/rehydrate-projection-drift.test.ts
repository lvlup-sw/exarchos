// ─── T-017 — rehydrate / view.pipeline projection drift outcome (GREEN) ────
//
// Encodes the #1359 regression: `rehydrate.taskProgress` and
// `view.pipeline.completedCount` projections undercount when task
// statuses are mutated through `workflow.update({tasks: [...]})` WITHOUT
// the paired `task.assigned` + `task.completed` event emission.
//
// Flipped from `it.fails(...)` to `it(...)` in PR4 of the v2.10.0-preview.4
// stack — atomic RED→GREEN flip alongside the projection fix
// (rehydrate canonical vocabulary + pipeline view state.patched fold).

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
// Side-effect import — registers the rehydration reducer with the
// process-wide default registry. Mirrors rehydrate.test.ts.
import '../../src/projections/rehydration/index.js';

interface TaskProgressEntry {
  readonly id: string;
  readonly status: string;
}

describe('rehydrate projection drift outcome (#1359)', () => {
  // Flipped to it() in #1359 PR4 (atomic RED→GREEN with the projection fix).
  it(
    'Rehydrate_TaskProgress_TracksCanonicalTaskStatus',
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'outcome-rehydrate-drift-'),
      );
      try {
        const eventStore = new EventStore(stateDir);
        const featureId = 'outcome-1359';

        // ─── 1. Init the feature workflow ──────────────────────────────
        const initResult = await handleInit(
          { featureId, workflowType: 'feature' },
          stateDir,
          eventStore,
        );
        expect(initResult.success).toBe(true);

        // ─── 2. Seed two tasks via workflow.update (NO task.assigned) ──
        // This is the entire point of the regression: agents update the
        // canonical `tasks` array via `workflow.update` without emitting
        // the paired `task.assigned` event, so the projection's task
        // counters silently drift away from the on-disk state.
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

        // ─── 3. Mutate tasks[0].status to 'complete' via workflow.update ──
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

        // ─── 4. Rehydrate + view.pipeline ──────────────────────────────
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

        // ─── 5. Assert projection tracks canonical state ───────────────
        // After PR #1359 lands, projections must reflect what the state
        // file says — not just what events have fired. Today
        // (pre-#1359) `taskProgress` is empty (or undercount) and
        // `completedCount` is 0 because no task.* events were emitted.
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
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );
});
