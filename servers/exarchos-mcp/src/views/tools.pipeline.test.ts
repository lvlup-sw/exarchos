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
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { EventStore } from '../event-store/store.js';
import { handleViewPipeline, resetMaterializerCache } from './tools.js';
import { handleView } from './composite.js';
import { deriveRepoKey } from '../utils/paths.js';
import type { DispatchContext } from '../core/dispatch.js';
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

  it('PipelineSummary_LastPageOffset_HasMoreFalse', async () => {
    // Regression (shepherd / Seer + CodeRabbit): the summary-fallback
    // `page.hasMore` must account for the paging `offset`. With 5 rows and
    // offset 3, the window is the final 2 rows — `hasMore` must be false. The
    // prior formula (`total > firstPage.length`) ignored the offset and returned
    // true, telling a caller already on the last page that more rows remained.
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
    // Summary fallback fired (tiny threshold) …
    expect(data.summary).toBeDefined();
    // … and the final-window page reports no further rows.
    expect(data.page).toMatchObject({ total: 5, offset: 3, hasMore: false });
  });

  it('PipelineSummary_MidPage_HasMoreTrue', async () => {
    // Complement: a non-final window still advertises more rows, so the
    // offset-aware fix does not suppress a legitimate `hasMore`.
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

  it('PipelineSummary_WindowExceedsPreviewCap_HasMoreFromWindow', async () => {
    // Regression (Sentry): the summary `page.hasMore` must derive from the full
    // offset/limit window, NOT the capped `firstPage` preview. With 15 rows and
    // limit 25, the window covers all 15 but `firstPage` caps at 10 — so keying
    // off `firstPage.length` (10 < 15) would spuriously report more pages. The
    // window covers everything, so `hasMore` must be false (matching detail).
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
    // Summary fallback fired, and the whole result set is within the window.
    expect(data.summary).toBeDefined();
    expect(data.page).toMatchObject({ total: 15, hasMore: false });
  });
});

// ─── DR-6 / DR-7 (task 007): repo-scoped default view + perceivability ───────
//
// Scope resolution precedence (pinned): scope:'all' → unfiltered; explicit
// repoRoot → filter to deriveRepoKey(repoRoot); else composite-supplied caller
// key → filter to it; else (direct call, no key) → unscoped; scope:'repo' with
// no resolvable key → structured error. `data.scope`/`data.unscopedTotal` ride
// every response; the scope-all escape hatch fires whenever `unscopedTotal >
// page.total`. Git-spawning cases carry ≥15s per-test timeouts per the vitest
// spawn-flake memory.
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
      // Drive the row to a terminal phase ('completed') so the terminal filter
      // (includeCompleted=false) elides it — used by the ordering-guard test.
      await store.append(featureId, {
        type: 'workflow.transition',
        data: { featureId, from: 'started', to: 'completed' },
      });
    }
  }

  it('Pipeline_CompositeDispatch_FiltersToCallerRepo', async () => {
    // The composite computes the caller key from `ctx.cwd` and threads it — a
    // workflow started in another repo must NOT appear in the caller's default.
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

  it('Pipeline_DirectHandlerNoKey_Unscoped', async () => {
    // A direct handler call with no caller key and no explicit scope stays
    // UNSCOPED by construction — this is what preserves the existing suites'
    // semantics without per-test edits.
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

  it('Pipeline_ScopeRepoWithoutKey_ReturnsStructuredError', async () => {
    // scope:'repo' explicitly requested but no repoRoot arg and no caller key —
    // never a silent unscoped result; a structured, self-correcting error.
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

  it('Pipeline_ScopeAll_IncludesLegacyUnscopedRows', async () => {
    // scope:'all' reproduces the full cross-repo inventory INCLUDING legacy rows
    // that carry no `repoRoot` (undefined) — those match only unscoped/'all'.
    await seedStarted('legacy'); // no repoRoot
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

  it('Pipeline_ExplicitRepoRoot_NormalizedBeforeMatch', async () => {
    // ── Worktree-form: a linked-worktree path input matches a row seeded with
    //    the MAIN-checkout key (deriveRepoKey collapses worktrees to one key),
    //    and a legacy (no-repoRoot) row is excluded from the scoped result. ──
    const mainRoot = fs.mkdtempSync(path.join(tmpdir(), 'pipe-drk-main-'));
    const wtParent = fs.mkdtempSync(path.join(tmpdir(), 'pipe-drk-wt-'));
    const wtPath = path.join(wtParent, 'linked');
    const git = (args: string[]) =>
      execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      git(['init', '-q', mainRoot]);
      git(['-C', mainRoot, 'config', 'user.email', 'test@example.com']);
      git(['-C', mainRoot, 'config', 'user.name', 'Test']);
      git(['-C', mainRoot, 'commit', '-q', '--allow-empty', '-m', 'init']);
      git(['-C', mainRoot, 'worktree', 'add', '-q', wtPath]);

      const mainKey = deriveRepoKey(mainRoot);
      await seedStarted('wt-scoped', { repoRoot: mainKey });
      await seedStarted('wt-legacy'); // no repoRoot — must not appear under repo scope

      // Called with the WORKTREE path; the handler derives the SAME key.
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
      fs.rmSync(mainRoot, { recursive: true, force: true });
      fs.rmSync(wtParent, { recursive: true, force: true });
    }

    // ── Windows-form: a backslash `C:\…` input normalizes to the POSIX key
    //    form before comparison (#1620), so it matches a POSIX-seeded row. ──
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

  it('Pipeline_MixedState_EmitsScopeAllHintWithHiddenCount', async () => {
    // Scoped-NONEMPTY with additional hidden other-repo rows: the escape-hatch
    // hint still fires (mixed steady state) and reports the exact hidden count.
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
    // Hidden count = unscopedTotal - page.total = 5 - 2 = 3.
    expect(hint!.reason).toContain('3');
  }, 20000);

  it('Pipeline_ScopeAll_NoEscapeHatchHint', async () => {
    // scope:'all' hides nothing, so no escape hatch. Crucially, seed COMPLETED
    // (terminal) rows: because `unscopedTotal` is computed POST-terminal-filter,
    // those rows are NOT counted and must NOT be mis-attributed as repo-hidden
    // (the ordering guard — a pre-terminal `unscopedTotal` would falsely fire).
    await seedStarted('active-1', { repoRoot: '/r/1' });
    await seedStarted('active-2', { repoRoot: '/r/2' });
    await seedStarted('done-1', { repoRoot: '/r/3', terminal: true });
    await seedStarted('done-2', { repoRoot: '/r/4', terminal: true });
    await seedStarted('done-3', { repoRoot: '/r/5', terminal: true });

    const result = await handleViewPipeline({ scope: 'all' }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all');
    // Terminal rows dropped from BOTH counts (post-terminal-filter ordering).
    expect(data.total).toBe(2);
    expect(data.unscopedTotal).toBe(2);
    const hint = (result.next_actions ?? []).find((a) => a.hint?.includes('--scope all'));
    expect(hint).toBeUndefined();
  });

  it('Pipeline_Data_CarriesScopeAndUnscopedTotal', async () => {
    // Every response reports `data.scope` (effective mode) and
    // `data.unscopedTotal` (pre-scope count) — always-on perceivability.
    await seedStarted('d1', { repoRoot: '/r/1' });
    await seedStarted('d2', { repoRoot: '/r/2' });

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as ScopeData;
    expect(data.scope).toBe('all'); // direct call, no key → unscoped/all
    expect(data.unscopedTotal).toBe(2);
  });
});
