/**
 * `handleViewPipeline` integration tests.
 *
 * They cover the `_meta` fields, the exclusion of streams with no `workflow.started`, compact rows
 * and the `detail` flag, the summary fallback, and the repo scope.
 * `_meta.projectionAsOf` is the newest `_asOf` of the folded streams. `_meta.projectionLag` shows
 * only when the lag exceeds `PROJECTION_LAG_THRESHOLD_MS`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { handleViewPipeline, resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import { deriveRepoKey } from '../../../../src/utils/paths.js';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { execFileAsync } from '../../../../tools/test-helpers/spawn.js';
import { rmrfAsync, rmrf } from '../../../../tools/test-helpers/temp-dir.js';
import type { QualityHintsConfig } from '../../../../src/workflow/capabilities/resolver.js';

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

  /** A `state.patched` with no `task.*` event must still give correct counters, because the view folds plan tasks. */
  it('ViewPipeline_StatePatchedCompleteTask_CountsViaTasksById', async () => {
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

/**
 * A stream with events but no `workflow.started` folds to a row with an empty `featureId`. That row
 * must not show in the page, and `total` must not count it. `includeCompleted: true` turns the
 * terminal-phase filter off, so only the empty-`featureId` filter can drop the row.
 */
describe('handleViewPipeline — DR-4 phantom exclusion (task 004)', () => {
  it('Pipeline_StreamWithoutStarted_ExcludedFromPageAndTotals', async () => {
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
    expect((data.workflows ?? []).some((w) => w.featureId === '')).toBe(false);
    expect(data.workflows ?? []).toHaveLength(0);
    expect(data.total).toBe(0);
  });

  it('Pipeline_PhantomAndReal_TotalsCountOnlyReal', async () => {
    await store.append('real-feature', {
      type: 'workflow.started',
      data: { featureId: 'real-feature', workflowType: 'feature' },
    });
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
    expect(data.workflows).toHaveLength(1);
    expect(data.workflows[0]?.featureId).toBe('real-feature');
    expect(data.workflows.every((w) => w.featureId !== '')).toBe(true);
    expect(data.total).toBe(1);
  });
});

/**
 * A pipeline row holds summary fields by default and omits the unbounded `tasksById` map.
 * `detail: true` restores the full row. The row `hasMore`, which is the stack eviction flag, stays
 * in a compact row. The `summary.firstPage` rows are compact in the same way.
 * Each payload exceeds `TINY_THRESHOLD`, so a call that passes it takes the summary fallback.
 */
describe('handleViewPipeline — DR-1 compact entries + detail flag (task 005)', () => {
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
    expect(entry!.taskCount).toBe(4);
    expect(entry!.completedCount).toBe(2);
    expect(entry!.failedCount).toBe(1);
    expect(entry!.tasksById).toBeUndefined();
  });

  /**
   * `MAX_STACK_POSITIONS` is 100, so the 101st position evicts one and sets the row `hasMore`.
   * That flag is not the paging flag of the page, and a compact row must keep it.
   */
  it('Pipeline_CompactEntry_RetainsEvictionHasMore', async () => {
    const featureId = 'compact-eviction';
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
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
    expect(entry!.tasksById).toBeUndefined();
    expect(entry!.hasMore).toBe(true);
  });

  /** The `firstPage` rows of the summary fallback must be compact, with the counts intact. */
  it('PipelineSummary_FirstPage_Compacted', async () => {
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

  /**
   * The summary `page.hasMore` must account for `offset`. With 5 rows and offset 3, the window is
   * the last 2 rows, so `hasMore` must be false.
   */
  it('PipelineSummary_LastPageOffset_HasMoreFalse', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWithTasks(`page-${i}`, ['complete', 'pending', 'failed']);
    }

    const result = await handleViewPipeline(
      { includeCompleted: true, offset: 3, limit: 10 },
      stateDir,
      store,
      TINY_THRESHOLD,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      summary?: unknown;
      page?: { total: number; offset: number; hasMore: boolean };
    };
    expect(data.summary).toBeDefined();
    expect(data.page).toMatchObject({ total: 5, offset: 3, hasMore: false });
  });

  /** A window that is not the last one must still report more rows. */
  it('PipelineSummary_MidPage_HasMoreTrue', async () => {
    for (let i = 0; i < 5; i++) {
      await seedWithTasks(`more-${i}`, ['complete', 'pending', 'failed']);
    }

    const result = await handleViewPipeline(
      { includeCompleted: true, offset: 0, limit: 2 },
      stateDir,
      store,
      TINY_THRESHOLD,
    );

    expect(result.success).toBe(true);
    const data = result.data as { page?: { hasMore: boolean } };
    expect(data.page?.hasMore).toBe(true);
  });

  /**
   * The summary `page.hasMore` must come from the full window, not from the `firstPage` preview.
   * With 15 rows and limit 25, the window holds all rows, but `firstPage` holds only 10.
   * Thus `hasMore` must be false.
   */
  it('PipelineSummary_WindowExceedsPreviewCap_HasMoreFromWindow', async () => {
    for (let i = 0; i < 15; i++) {
      await seedWithTasks(`win-${i}`, ['complete', 'pending', 'failed']);
    }

    const result = await handleViewPipeline(
      { includeCompleted: true, offset: 0, limit: 25 },
      stateDir,
      store,
      TINY_THRESHOLD,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      summary?: unknown;
      page?: { total: number; hasMore: boolean };
    };
    expect(data.summary).toBeDefined();
    expect(data.page).toMatchObject({ total: 15, hasMore: false });
  });
});

/**
 * Scope order: `scope: 'all'` gives no filter. Next, an explicit `repoRoot` filters to its repo
 * key. Next, the handler filters to the caller key that the composite supplies. A direct call with
 * no key is unscoped, and `scope: 'repo'` with no key is an error. Each response holds
 * `data.scope` and `data.unscopedTotal`. A hint for `--scope all` shows when `unscopedTotal`
 * exceeds `total`.
 *
 * The tests that spawn git have a 20 s timeout. On a loaded machine, a git spawn can exceed the
 * default test timeout.
 */
describe('handleViewPipeline — DR-6/DR-7 repo scoping + perceivability (task 007)', () => {
  type Row = { featureId: string };
  interface ScopeData {
    workflows: Row[];
    total: number;
    unscopedTotal: number;
    scope: 'repo' | 'all';
  }

  async function seedStarted(
    featureId: string,
    opts?: { repoRoot?: string; terminal?: boolean },
  ): Promise<void> {
    await store.append(featureId, {
      type: 'workflow.started',
      data: {
        featureId,
        workflowType: 'feature',
        ...(opts?.repoRoot !== undefined ? { repoRoot: opts.repoRoot } : {}),
      },
    });
    if (opts?.terminal) {
      await store.append(featureId, {
        type: 'workflow.transition',
        data: { featureId, from: 'started', to: 'completed' },
      });
    }
  }

  /**
   * The composite derives the caller key from `ctx.cwd`. A workflow from another repo must not
   * show in the default result.
   */
  it('Pipeline_CompositeDispatch_FiltersToCallerRepo', async () => {
    const callerKey = deriveRepoKey(stateDir);
    await seedStarted('here-1', { repoRoot: callerKey });
    await seedStarted('there-1', { repoRoot: '/some/other/repo' });

    const ctx: DispatchContext = {
      stateDir,
      eventStore: store,
      enableTelemetry: false,
      cwd: stateDir,
    };
    const result = await handleView({ action: 'pipeline', includeCompleted: true }, ctx);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('repo');
    const ids = data.workflows.map((w) => w.featureId);
    expect(ids).toContain('here-1');
    expect(ids).not.toContain('there-1');
  }, 20000);

  /** A direct handler call with no caller key and no explicit scope is unscoped. */
  it('Pipeline_DirectHandlerNoKey_Unscoped', async () => {
    await seedStarted('a', { repoRoot: '/repo/a' });
    await seedStarted('b', { repoRoot: '/repo/b' });

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all');
    expect(data.total).toBe(2);
    const ids = data.workflows.map((w) => w.featureId);
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']));
  });

  /** `scope: 'repo'` with no `repoRoot` and no caller key gives a structured error, not an unscoped result. */
  it('Pipeline_ScopeRepoWithoutKey_ReturnsStructuredError', async () => {
    await seedStarted('x', { repoRoot: '/repo/x' });

    const result = await handleViewPipeline(
      { scope: 'repo', includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('SCOPE_UNRESOLVABLE');
    expect(result.error?.suggestedFix).toBeDefined();
    expect(result.error?.suggestedFix?.params).toMatchObject({
      action: 'pipeline',
      scope: 'all',
    });
  });

  /**
   * `pipeline` and `ps` share one `scope` field, so a `ps` scope can reach this handler. The
   * handler must not treat `workflow` or `worktree` as unscoped. It returns `INVALID_INPUT` with
   * the valid targets `repo` and `all`, and a `suggestedFix` that points to `ps`.
   */
  it('Pipeline_ScopeOutOfSubset_RejectedAsInvalidInput', async () => {
    await seedStarted('scope-reject', { repoRoot: '/repo/z' });

    const workflowResult = await handleViewPipeline(
      { scope: 'workflow', includeCompleted: true },
      stateDir,
      store,
    );
    expect(workflowResult.success).toBe(false);
    expect(workflowResult.error?.code).toBe('INVALID_INPUT');
    expect(workflowResult.error?.validTargets).toEqual(['repo', 'all']);
    expect(workflowResult.error?.suggestedFix?.params).toMatchObject({
      action: 'ps',
      scope: 'workflow',
    });

    const worktreeResult = await handleViewPipeline(
      { scope: 'worktree', includeCompleted: true },
      stateDir,
      store,
    );
    expect(worktreeResult.success).toBe(false);
    expect(worktreeResult.error?.code).toBe('INVALID_INPUT');
    expect(worktreeResult.error?.validTargets).toEqual(['repo', 'all']);
  });

  /** `scope: 'all'` also returns a row with no `repoRoot`. Such a row matches only an unscoped query. */
  it('Pipeline_ScopeAll_IncludesLegacyUnscopedRows', async () => {
    await seedStarted('legacy');
    await seedStarted('scoped', { repoRoot: '/repo/s' });

    const result = await handleViewPipeline(
      { scope: 'all', includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all');
    const ids = data.workflows.map((w) => w.featureId);
    expect(ids).toEqual(expect.arrayContaining(['legacy', 'scoped']));
  });

  /**
   * `deriveRepoKey` gives a linked worktree the key of its main checkout. Thus a worktree path as
   * `repoRoot` matches a row with the main key, and excludes a row with no `repoRoot`. A Windows
   * path with backslashes becomes the POSIX key form before the handler compares the keys.
   */
  it('Pipeline_ExplicitRepoRoot_NormalizedBeforeMatch', async () => {
    const mainRoot = fs.mkdtempSync(path.join(tmpdir(), 'pipe-drk-main-'));
    const wtParent = fs.mkdtempSync(path.join(tmpdir(), 'pipe-drk-wt-'));
    const wtPath = path.join(wtParent, 'linked');
    const git = (args: string[]) => execFileAsync('git', args);
    try {
      await git(['init', '-q', mainRoot]);
      await git(['-C', mainRoot, 'config', 'user.email', 'test@example.com']);
      await git(['-C', mainRoot, 'config', 'user.name', 'Test']);
      await git(['-C', mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init']);
      await git(['-C', mainRoot, 'worktree', 'add', '-q', wtPath]);

      const mainKey = deriveRepoKey(mainRoot);
      await seedStarted('wt-scoped', { repoRoot: mainKey });
      await seedStarted('wt-legacy');

      const result = await handleViewPipeline(
        { repoRoot: wtPath, includeCompleted: true },
        stateDir,
        store,
      );

      expect(result.success).toBe(true);
      const data = result.data as ScopeData;
      expect(data.scope).toBe('repo');
      const ids = data.workflows.map((w) => w.featureId);
      expect(ids).toContain('wt-scoped');
      expect(ids).not.toContain('wt-legacy');
    } finally {
      rmrf(mainRoot);
      rmrf(wtParent);
    }

    await seedStarted('win-scoped', { repoRoot: 'C:/Users/dev/win-repo' });
    const winResult = await handleViewPipeline(
      { repoRoot: 'C:\\Users\\dev\\win-repo', includeCompleted: true },
      stateDir,
      store,
    );

    expect(winResult.success).toBe(true);
    const winData = winResult.data as ScopeData;
    expect(winData.workflows.map((w) => w.featureId)).toContain('win-scoped');
  }, 20000);

  /**
   * The scoped result holds two rows, and the scope hides three rows of other repos. The hint must
   * still show, and its reason must hold the hidden count: `unscopedTotal - total`, which is 3.
   */
  it('Pipeline_MixedState_EmitsScopeAllHintWithHiddenCount', async () => {
    const key = deriveRepoKey(stateDir);
    await seedStarted('mine-1', { repoRoot: key });
    await seedStarted('mine-2', { repoRoot: key });
    await seedStarted('other-1', { repoRoot: '/repo/other-1' });
    await seedStarted('other-2', { repoRoot: '/repo/other-2' });
    await seedStarted('other-3', { repoRoot: '/repo/other-3' });

    const result = await handleViewPipeline(
      { repoRoot: stateDir, includeCompleted: true },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('repo');
    expect(data.total).toBe(2);
    expect(data.unscopedTotal).toBe(5);
    const hint = (result.next_actions ?? []).find((a) => a.hint?.includes('--scope all'));
    expect(hint).toBeDefined();
    expect(hint!.reason).toContain('3');
  }, 20000);

  /**
   * `scope: 'all'` hides nothing, so no hint shows. The handler counts `unscopedTotal` after the
   * terminal-phase filter. Thus the three completed rows are in neither count, and the handler
   * does not report them as hidden by the repo scope.
   */
  it('Pipeline_ScopeAll_NoEscapeHatchHint', async () => {
    await seedStarted('active-1', { repoRoot: '/r/1' });
    await seedStarted('active-2', { repoRoot: '/r/2' });
    await seedStarted('done-1', { repoRoot: '/r/3', terminal: true });
    await seedStarted('done-2', { repoRoot: '/r/4', terminal: true });
    await seedStarted('done-3', { repoRoot: '/r/5', terminal: true });

    const result = await handleViewPipeline({ scope: 'all' }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all');
    expect(data.total).toBe(2);
    expect(data.unscopedTotal).toBe(2);
    const hint = (result.next_actions ?? []).find((a) => a.hint?.includes('--scope all'));
    expect(hint).toBeUndefined();
  });

  /** Each response holds `data.scope` and `data.unscopedTotal`. A direct call with no key reports `all`. */
  it('Pipeline_Data_CarriesScopeAndUnscopedTotal', async () => {
    await seedStarted('d1', { repoRoot: '/r/1' });
    await seedStarted('d2', { repoRoot: '/r/2' });

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all');
    expect(data.unscopedTotal).toBe(2);
  });
});
