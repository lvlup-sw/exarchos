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
import type { QualityHintsConfig } from '../capabilities/resolver.js';

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

// ─── DR-4 (task 004): phantom exclusion from page AND totals ─────────────────
//
// A feature-named stream that carries events but never a `workflow.started`
// event folds to a degenerate row (empty featureId). Such a row must never
// appear in the page and must never be counted in `page.total`/`unscopedTotal`,
// in any scope mode. `includeCompleted: true` is used to isolate the phantom
// filter from the terminal-phase filter (a phantom's phase is '' — non-terminal
// — so without the DR-4 filter it would otherwise leak through regardless).
describe('handleViewPipeline — DR-4 phantom exclusion (task 004)', () => {
  it('Pipeline_StreamWithoutStarted_ExcludedFromPageAndTotals', async () => {
    // A stream with a task event but NO workflow.started foundation.
    await store.append('phantom-stream', {
      type: 'task.assigned',
      data: { taskId: 'T1' },
    });

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      workflows?: ReadonlyArray<{ featureId: string }>;
      total?: number;
    };
    // No empty-featureId row surfaces …
    expect((data.workflows ?? []).some((w) => w.featureId === '')).toBe(false);
    expect(data.workflows ?? []).toHaveLength(0);
    // … and the total does not count it.
    expect(data.total).toBe(0);
  });

  it('Pipeline_PhantomAndReal_TotalsCountOnlyReal', async () => {
    // One genuine workflow (has workflow.started) …
    await store.append('real-feature', {
      type: 'workflow.started',
      data: { featureId: 'real-feature', workflowType: 'feature' },
    });
    // … alongside a phantom (events, but no workflow.started foundation).
    await store.append('phantom-a', {
      type: 'task.assigned',
      data: { taskId: 'T1' },
    });
    await store.append('phantom-b', {
      type: 'state.patched',
      data: { fields: ['tasks'], patch: { tasks: [{ id: 'X', status: 'pending' }] } },
    });

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      workflows: ReadonlyArray<{ featureId: string }>;
      total: number;
    };
    // Only the real workflow appears; the total counts it alone.
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0]?.featureId).toBe('real-feature');
    expect(data.workflows.every((w) => w.featureId !== '')).toBe(true);
    expect(data.total).toBe(1);
  });
});

// ─── DR-1 (task 005): compact default entries + schema-level detail flag ─────
//
// By default a pipeline entry carries only summary fields and OMITS the
// unbounded per-task `tasksById` map. `detail: true` restores the full row.
// The per-entry `hasMore` (stack-position eviction flag) survives compaction.
// `summary.firstPage` rows are compacted identically.
describe('handleViewPipeline — DR-1 compact entries + detail flag (task 005)', () => {
  // Threshold so tiny any non-trivial payload trips the summary fallback.
  const TINY_THRESHOLD: QualityHintsConfig = { qualityHints: { outputTokenThreshold: 0.00001 } };

  async function seedWithTasks(featureId: string, statuses: string[]): Promise<void> {
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    await store.append(featureId, {
      type: 'state.patched',
      data: {
        featureId,
        fields: ['tasks'],
        patch: { tasks: statuses.map((status, i) => ({ id: `T${i}`, status })) },
      },
    });
  }

  it('Pipeline_Default_OmitsTasksById', async () => {
    await seedWithTasks('compact-omit', ['complete', 'pending']);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>> };
    const entry = data.workflows.find((w) => w.featureId === 'compact-omit');
    expect(entry).toBeDefined();
    expect('tasksById' in entry!).toBe(false);
  });

  it('Pipeline_DetailTrue_IncludesTasksById', async () => {
    await seedWithTasks('compact-detail', ['complete', 'pending']);

    const result = await handleViewPipeline(
      { includeCompleted: true, detail: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { workflows: Array<Record<string, unknown>> };
    const entry = data.workflows.find((w) => w.featureId === 'compact-detail');
    expect(entry).toBeDefined();
    expect('tasksById' in entry!).toBe(true);
    expect(entry!.tasksById).toMatchObject({ T0: 'complete' });
    expect(Object.keys(entry!.tasksById as Record<string, unknown>)).toContain('T1');
  });

  it('Pipeline_Default_CountsPresent', async () => {
    await seedWithTasks('compact-counts', ['complete', 'complete', 'failed', 'pending']);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as {
      workflows: Array<{
        featureId: string;
        taskCount: number;
        completedCount: number;
        failedCount: number;
        tasksById?: unknown;
      }>;
    };
    const entry = data.workflows.find((w) => w.featureId === 'compact-counts');
    expect(entry).toBeDefined();
    // Counts are present and correct WITHOUT the per-task map beside them.
    expect(entry!.taskCount).toBe(4);
    expect(entry!.completedCount).toBe(2);
    expect(entry!.failedCount).toBe(1);
    expect(entry!.tasksById).toBeUndefined();
  });

  it('Pipeline_CompactEntry_RetainsEvictionHasMore', async () => {
    const featureId = 'compact-eviction';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
    // MAX_STACK_POSITIONS is 100 — the 101st fill evicts and sets the per-entry
    // `hasMore` eviction flag. That flag is unrelated to page-level paging and
    // must survive DR-1 compaction.
    for (let i = 0; i < 101; i++) {
      await store.append(featureId, {
        type: 'stack.position-filled',
        data: { position: i, taskId: `T${i}` },
      });
    }

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as {
      workflows: Array<{ featureId: string; hasMore?: boolean; tasksById?: unknown }>;
    };
    const entry = data.workflows.find((w) => w.featureId === featureId);
    expect(entry).toBeDefined();
    // Compacted (no task map) …
    expect(entry!.tasksById).toBeUndefined();
    // … but the eviction `hasMore` is retained through compaction.
    expect(entry!.hasMore).toBe(true);
  });

  it('PipelineSummary_FirstPage_Compacted', async () => {
    // Enough task-heavy workflows that the tiny-threshold summary fallback
    // fires; its firstPage rows must be compacted (no tasksById), counts intact.
    for (let i = 0; i < 5; i++) {
      await seedWithTasks(`sum-${i}`, ['complete', 'pending', 'failed']);
    }

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
      TINY_THRESHOLD,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      summary?: { firstPage: Array<Record<string, unknown>>; total: number };
      workflows?: unknown[];
    };
    expect(data.workflows).toBeUndefined();
    expect(data.summary).toBeDefined();
    expect(data.summary!.firstPage.length).toBeGreaterThan(0);
    for (const row of data.summary!.firstPage) {
      expect('tasksById' in row).toBe(false);
      expect(typeof row.taskCount).toBe('number');
    }
  });
});
