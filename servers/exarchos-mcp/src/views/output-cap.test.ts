// ─── DR-3 bounded view output: item cap + measured-size summary (WLM-6 T006) ──
//
// Covers the two inventory reads that could dump unbounded rows — `pipeline`
// (handleViewPipeline) and `worktrees` (handleViewWorktrees):
//   - a deterministic item cap when `limit` is omitted;
//   - a counts-by-group summary when the capped payload would still blow the
//     resolved output-token threshold;
//   - fail-open degrade to the item cap when the threshold cannot be resolved;
//   - byte-identical output below cap AND threshold (no small-inventory regression).
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';
import type { ToolResult } from '../format.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { handleViewPipeline, resetMaterializerCache } from './tools.js';
import {
  DEFAULT_VIEW_ITEM_CAP,
  PIPELINE_DEFAULT_ITEM_CAP,
  SUMMARY_FIRST_PAGE_ITEMS,
  estimateOutputTokens,
} from './output-cap.js';
import type { QualityHintsConfig } from '../capabilities/resolver.js';
import { handleAcquireWorktree, handleViewWorktrees } from '../orchestrate/worktree/handlers.js';
import type { GitWorktreeProbe } from '../orchestrate/worktree/manager.js';
import type { ProcessSource } from '../orchestrate/worktree/pure/process-identity.js';

// A config that resolves to a TINY threshold so any non-trivial payload trips
// the measured-size summary (32000 * 0.00001 ≈ 0.32 tokens).
const TINY_THRESHOLD_CONFIG: QualityHintsConfig = { qualityHints: { outputTokenThreshold: 0.00001 } };
// A config whose fraction is NaN → the resolved threshold is non-finite → the
// handler must FAIL-OPEN to the item cap (never a summary off a garbage threshold).
const NAN_THRESHOLD_CONFIG: QualityHintsConfig = { qualityHints: { outputTokenThreshold: Number.NaN } };

const dirs: string[] = [];
afterEach(async () => {
  resetMaterializerCache();
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d) await rmrfAsync(d);
  }
});

async function newStore(): Promise<{ stateDir: string; store: EventStore }> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm6-t006-'));
  dirs.push(stateDir);
  const store = new EventStore(stateDir);
  await store.initialize();
  resetMaterializerCache();
  return { stateDir, store };
}

/** Seed `n` distinct non-terminal workflows (one `workflow.started` each). */
async function seedWorkflows(store: EventStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const featureId = `wf-${String(i).padStart(3, '0')}`;
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
    });
  }
}

describe('pipeline — DR-3 item cap + measured-size summary', () => {
  // ORACLE CHANGE (DR-2, task 006): the pipeline default window shrank from the
  // shared DEFAULT_VIEW_ITEM_CAP (50) to PIPELINE_DEFAULT_ITEM_CAP (10). The
  // worktrees view keeps 50, pinned by its own tests below.
  it('Pipeline_NoLimit_AppliesDefaultCap', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, PIPELINE_DEFAULT_ITEM_CAP + 5);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; total: number; summary?: unknown };
    // Capped, NOT summarized (default threshold is huge for tiny rows).
    expect(data.summary).toBeUndefined();
    expect(data.workflows).toHaveLength(PIPELINE_DEFAULT_ITEM_CAP);
    expect(data.total).toBe(PIPELINE_DEFAULT_ITEM_CAP + 5);
    // The narrow affordance is advertised because the cap truncated the inventory.
    expect(result.next_actions?.[0]?.verb).toBe('pipeline');
  });

  it('Pipeline_OverSizeThreshold_ReturnsSummary', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, 8);

    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
      TINY_THRESHOLD_CONFIG,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      summary?: { total: number; byPhase: Record<string, number>; firstPage: unknown[] };
      workflows?: unknown[];
      truncated?: boolean;
    };
    // Summary shape replaced per-item detail.
    expect(data.workflows).toBeUndefined();
    expect(data.truncated).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.summary!.total).toBe(8);
    expect(data.summary!.byPhase.started).toBe(8);
    expect(data.summary!.firstPage.length).toBeLessThanOrEqual(SUMMARY_FIRST_PAGE_ITEMS);
    expect(result.next_actions?.[0]?.verb).toBe('pipeline');
  });

  it('Pipeline_ThresholdResolutionFails_DegradesToCap', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, PIPELINE_DEFAULT_ITEM_CAP + 5);

    // NaN threshold → resolution fails → degrade to the capped DETAIL (never a
    // summary off a garbage threshold, never an unbounded dump).
    const result = await handleViewPipeline(
      { includeCompleted: true },
      stateDir,
      store,
      NAN_THRESHOLD_CONFIG,
    );

    expect(result.success).toBe(true);
    const data = result.data as { workflows?: unknown[]; total: number; summary?: unknown };
    expect(data.summary).toBeUndefined();
    expect(data.workflows).toHaveLength(PIPELINE_DEFAULT_ITEM_CAP);
    expect(data.total).toBe(PIPELINE_DEFAULT_ITEM_CAP + 5);
  });

  it('Pipeline_UnderCapAndThreshold_Unchanged', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, 3);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    // ORACLE CHANGE (DR-2/DR-3, task 006): the small inventory still returns
    // per-item detail with NO summary/truncation and NO narrow affordance, but
    // the payload now also carries the explicit `page` object and `unscopedTotal`
    // (legacy `total` retained as an alias). `page.hasMore` is false — the whole
    // inventory fits the window.
    // ORACLE CHANGE (DR-7, task 007): every response additionally carries
    // `data.scope` (the effective scope mode). This direct handler call supplies
    // no caller key and no explicit scope, so it is unscoped ⇒ `scope === 'all'`.
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['page', 'scope', 'total', 'unscopedTotal', 'workflows']);
    expect((data.workflows as unknown[]).length).toBe(3);
    expect(data.total).toBe(3);
    expect(data.unscopedTotal).toBe(3);
    expect(data.scope).toBe('all');
    expect(data.page).toEqual({ total: 3, offset: 0, limit: PIPELINE_DEFAULT_ITEM_CAP, hasMore: false });
    expect(result.next_actions).toBeUndefined();
  });
});

// ─── DR-2 / DR-3 (task 006): small default window + page object + order ───────
//
// Small pipeline-specific default window (10), an explicit `page` metadata
// object in both branches, deterministic `_asOf`-desc ordering, and a hard
// token budget for the default call.
describe('pipeline — DR-2/DR-3 window + page metadata + deterministic order', () => {
  /** Seed one workflow.started per id with an EXPLICIT timestamp (for order). */
  async function seedTimed(store: EventStore, featureId: string, isoTs: string): Promise<void> {
    await store.append(featureId, {
      type: 'workflow.started',
      data: { featureId, workflowType: 'feature' },
      timestamp: isoTs,
    });
  }

  /** Seed a workflow whose full detail row is token-HEAVY (many tasks). */
  async function seedManyTasks(store: EventStore, featureId: string, taskCount: number): Promise<void> {
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
          tasks: Array.from({ length: taskCount }, (_, i) => ({ id: `T${i}`, status: 'pending' })),
        },
      },
    });
  }

  it('Pipeline_NoLimit_ReturnsAtMostTen', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, PIPELINE_DEFAULT_ITEM_CAP + 5);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; total: number; page: { limit: number } };
    expect(data.workflows.length).toBeLessThanOrEqual(10);
    expect(data.workflows).toHaveLength(PIPELINE_DEFAULT_ITEM_CAP);
    expect(data.page.limit).toBe(PIPELINE_DEFAULT_ITEM_CAP);
    expect(data.total).toBe(PIPELINE_DEFAULT_ITEM_CAP + 5);
  });

  it('Pipeline_ExplicitLimit_Honored', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, DEFAULT_VIEW_ITEM_CAP + 5); // 55

    // An explicit limit of 50 must be honored verbatim (well beyond the default 10).
    const result = await handleViewPipeline({ includeCompleted: true, limit: 50 }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; total: number; page: { limit: number; hasMore: boolean } };
    expect(data.workflows).toHaveLength(50);
    expect(data.page.limit).toBe(50);
    expect(data.total).toBe(55);
    expect(data.page.hasMore).toBe(true); // 50 shown of 55
  });

  it('Pipeline_PageObject_TotalOffsetLimitHasMore', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, 15);

    // Detail branch: page.hasMore === offset + workflows.length < page.total.
    const first = await handleViewPipeline({ includeCompleted: true, offset: 0, limit: 10 }, stateDir, store);
    const firstData = first.data as { workflows: unknown[]; page: { total: number; offset: number; limit: number; hasMore: boolean } };
    expect(firstData.page).toEqual({ total: 15, offset: 0, limit: 10, hasMore: true });
    expect(firstData.page.hasMore).toBe(0 + firstData.workflows.length < firstData.page.total);

    const second = await handleViewPipeline({ includeCompleted: true, offset: 10, limit: 10 }, stateDir, store);
    const secondData = second.data as { workflows: unknown[]; page: { total: number; offset: number; limit: number; hasMore: boolean } };
    expect(secondData.page).toEqual({ total: 15, offset: 10, limit: 10, hasMore: false });
    expect(secondData.page.hasMore).toBe(10 + secondData.workflows.length < secondData.page.total);
  });

  it('PipelineSummary_PageObject_HasMoreFromFirstPage', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, 15);

    // Tiny threshold forces the summary fallback. Summary branch:
    // page.hasMore === page.total > firstPage.length.
    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store, TINY_THRESHOLD_CONFIG);

    expect(result.success).toBe(true);
    const data = result.data as {
      summary: { firstPage: unknown[]; total: number };
      page: { total: number; offset: number; limit: number; hasMore: boolean };
    };
    expect(data.page.total).toBe(15);
    expect(data.page.hasMore).toBe(true);
    expect(data.page.hasMore).toBe(data.page.total > data.summary.firstPage.length);
  });

  it('Pipeline_ConsecutiveOffsets_PartitionSortedSequence', async () => {
    const { stateDir, store } = await newStore();
    // Distinct, increasing timestamps → deterministic `_asOf`-DESC order is the
    // reverse of insertion order (wf-011 newest … wf-000 oldest).
    const baseMs = Date.parse('2026-06-01T00:00:00.000Z');
    const n = 12;
    for (let i = 0; i < n; i++) {
      await seedTimed(store, `wf-${String(i).padStart(3, '0')}`, new Date(baseMs + i * 1000).toISOString());
    }
    const expectedOrder = Array.from({ length: n }, (_, i) => `wf-${String(n - 1 - i).padStart(3, '0')}`);

    const ids = async (offset: number, limit: number): Promise<string[]> => {
      const r = await handleViewPipeline({ includeCompleted: true, offset, limit }, stateDir, store);
      return (r.data as { workflows: Array<{ featureId: string }> }).workflows.map((w) => w.featureId);
    };

    const page1 = await ids(0, 6);
    const page2 = await ids(6, 6);

    // Independent order oracle: two windows partition the SAME sorted sequence.
    expect(page1).toEqual(expectedOrder.slice(0, 6));
    expect(page2).toEqual(expectedOrder.slice(6, 12));
    // Disjoint + complete.
    expect(new Set([...page1, ...page2]).size).toBe(n);
  });

  it('Pipeline_TieBreak_FeatureIdAscendingOnEqualAsOf', async () => {
    const { stateDir, store } = await newStore();
    // Same timestamp on all three → ties broken by featureId ASCENDING.
    const ts = '2026-06-01T00:00:00.000Z';
    await seedTimed(store, 'wf-charlie', ts);
    await seedTimed(store, 'wf-alpha', ts);
    await seedTimed(store, 'wf-bravo', ts);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);
    const ids = (result.data as { workflows: Array<{ featureId: string }> }).workflows.map((w) => w.featureId);
    expect(ids).toEqual(['wf-alpha', 'wf-bravo', 'wf-charlie']);
  });

  it('Pipeline_DefaultCall_UnderTokenBudget', async () => {
    const { stateDir, store } = await newStore();
    // Representative many-task workflows: full detail rows would be token-heavy,
    // but the compact default entries + small window keep the payload tiny.
    for (let i = 0; i < 12; i++) {
      await seedManyTasks(store, `heavy-${String(i).padStart(2, '0')}`, 20);
    }

    // Default call: no limit, no config (default threshold — NOT summarized).
    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; summary?: unknown };
    // Compact per-item detail, not the summary fallback.
    expect(data.summary).toBeUndefined();
    expect(data.workflows).toHaveLength(PIPELINE_DEFAULT_ITEM_CAP);
    // DR-2 economy criterion, operationalized.
    expect(estimateOutputTokens(result.data)).toBeLessThan(1000);
  });
});

// ─── worktrees ────────────────────────────────────────────────────────────────

const EMPTY_PROBE: GitWorktreeProbe = {
  listWorktrees: () => [],
  verifyHead: () => ({ head: null, upstream: null, mutable: false, reason: 'head-unresolved' }),
};
const FIXED_SOURCE: ProcessSource = {
  getStartTime: () => ({ status: 'present', startedAt: 'fixed-start' }),
};
const WT_DEPS = { gitProbe: EMPTY_PROBE, processSource: FIXED_SOURCE };

async function newWorktreeArm(
  config?: QualityHintsConfig,
): Promise<{ ctx: DispatchContext }> {
  const { stateDir, store } = await newStore();
  const ctx: DispatchContext = {
    stateDir,
    eventStore: store,
    enableTelemetry: false,
    ...(config !== undefined ? { config: config as DispatchContext['config'] } : {}),
  };
  return { ctx };
}

/** Reserve `n` distinct governed worktrees through the real acquire handler. */
async function seedWorktrees(ctx: DispatchContext, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await handleAcquireWorktree(
      { repoRoot: '/wlm6/repo', worktreeId: `/wlm6/wt-${String(i).padStart(3, '0')}` },
      ctx,
      WT_DEPS,
    );
    if (!res.success) throw new Error(`seed reserve failed: ${JSON.stringify(res.error)}`);
  }
}

describe('worktrees — DR-3 item cap + measured-size summary', () => {
  it('Worktrees_NoLimit_AppliesDefaultCap', async () => {
    const { ctx } = await newWorktreeArm();
    await seedWorktrees(ctx, DEFAULT_VIEW_ITEM_CAP + 5);

    const result: ToolResult = await handleViewWorktrees({}, ctx, WT_DEPS);

    expect(result.success).toBe(true);
    const data = result.data as { worktrees?: unknown[]; count: number; total?: number; truncated?: boolean; summary?: unknown };
    expect(data.summary).toBeUndefined();
    expect(data.worktrees).toHaveLength(DEFAULT_VIEW_ITEM_CAP);
    expect(data.count).toBe(DEFAULT_VIEW_ITEM_CAP);
    expect(data.total).toBe(DEFAULT_VIEW_ITEM_CAP + 5);
    expect(data.truncated).toBe(true);
    expect(result.next_actions?.[0]?.verb).toBe('worktrees');
  });

  it('Worktrees_OverSizeThreshold_ReturnsSummary', async () => {
    const { ctx } = await newWorktreeArm(TINY_THRESHOLD_CONFIG);
    await seedWorktrees(ctx, 6);

    const result = await handleViewWorktrees({}, ctx, WT_DEPS);

    expect(result.success).toBe(true);
    const data = result.data as {
      summary?: { total: number; byState: Record<string, number>; firstPage: unknown[] };
      worktrees?: unknown[];
      truncated?: boolean;
    };
    expect(data.worktrees).toBeUndefined();
    expect(data.truncated).toBe(true);
    expect(data.summary).toBeDefined();
    expect(data.summary!.total).toBe(6);
    expect(data.summary!.byState.reserved).toBe(6);
    expect(result.next_actions?.[0]?.verb).toBe('worktrees');
  });

  it('Worktrees_UnderCapAndThreshold_Unchanged', async () => {
    const { ctx } = await newWorktreeArm();
    await seedWorktrees(ctx, 2);

    const result = await handleViewWorktrees({}, ctx, WT_DEPS);

    expect(result.success).toBe(true);
    // Byte-identical to the pre-DR-3 payload: exactly { worktrees, count }.
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['count', 'worktrees']);
    expect((data.worktrees as unknown[]).length).toBe(2);
    expect(data.count).toBe(2);
    expect(result.next_actions).toBeUndefined();
  });
});
