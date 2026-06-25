/**
 * `handleViewPipeline` integration tests for #1359 / PR4 T14 + T15.
 *
 * Covers the response-envelope additions:
 *   - `data.projectionAsOf` — ISO timestamp of the most-recent folded event
 *     across the union of materialized streams.
 *   - `_meta.projectionLag` — sparse millisecond delta surfaced only when
 *     the projection is stale beyond PROJECTION_LAG_THRESHOLD_MS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { handleViewPipeline, resetMaterializerCache } from './tools.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

let tempDir: string;
let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), 'view-pipeline-pr4-'));
  stateDir = tempDir;
  store = new EventStore(tempDir);
  resetMaterializerCache();
});

afterEach(async () => {
  resetMaterializerCache();
  await rmrfAsync(tempDir);
});

describe('handleViewPipeline — projectionAsOf + projectionLag (#1359 / PR4)', () => {
  it('ViewPipeline_FoldedEvents_ExposesProjectionAsOf', async () => {
    const featureId = 'view-asof';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'task.assigned',
      data: { taskId: 'T1' },
    });

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta?.projectionAsOf).toBe('string');
    expect(Number.isFinite(Date.parse(meta!.projectionAsOf as string))).toBe(true);
  });

  it('ViewPipeline_StatePatchedCompleteTask_CountsViaTasksById', async () => {
    // Bug A end-to-end: a state.patched without paired task.* events must
    // still surface accurate counters because the view folds plan tasks
    // through `tasksById`.
    const featureId = 'view-state-patched';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: {
        featureId,
        fields: ['tasks'],
        patch: {
          tasks: [
            { id: 'A', status: 'complete' },
            { id: 'B', status: 'pending' },
            { id: 'C', status: 'complete' },
          ],
        },
      },
    });

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      workflows: ReadonlyArray<{
        featureId: string;
        taskCount: number;
        completedCount: number;
      }>;
    };
    const ours = data.workflows.find((w) => w.featureId === featureId);
    expect(ours).toBeDefined();
    expect(ours!.taskCount).toBe(3);
    expect(ours!.completedCount).toBe(2);
  });

  it('ViewPipeline_StaleProjection_ExposesMetaProjectionLag', async () => {
    const featureId = 'view-lag';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });

    const futureMs = Date.now() + 60_000;
    vi.useFakeTimers();
    vi.setSystemTime(new Date(futureMs));
    try {
      const result = await handleViewPipeline(
        { includeCompleted: true },
        stateDir,
        store,
      );
      expect(result.success).toBe(true);
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta).toBeDefined();
      expect(typeof meta?.projectionLag).toBe('number');
      expect(meta?.projectionLag as number).toBeGreaterThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});
