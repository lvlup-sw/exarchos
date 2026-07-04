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
import { DEFAULT_VIEW_ITEM_CAP, SUMMARY_FIRST_PAGE_ITEMS } from './output-cap.js';
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
  it('Pipeline_NoLimit_AppliesDefaultCap', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, DEFAULT_VIEW_ITEM_CAP + 5);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    const data = result.data as { workflows: unknown[]; total: number; summary?: unknown };
    // Capped, NOT summarized (default threshold is huge for tiny rows).
    expect(data.summary).toBeUndefined();
    expect(data.workflows).toHaveLength(DEFAULT_VIEW_ITEM_CAP);
    expect(data.total).toBe(DEFAULT_VIEW_ITEM_CAP + 5);
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
    await seedWorkflows(store, DEFAULT_VIEW_ITEM_CAP + 5);

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
    expect(data.workflows).toHaveLength(DEFAULT_VIEW_ITEM_CAP);
    expect(data.total).toBe(DEFAULT_VIEW_ITEM_CAP + 5);
  });

  it('Pipeline_UnderCapAndThreshold_Unchanged', async () => {
    const { stateDir, store } = await newStore();
    await seedWorkflows(store, 3);

    const result = await handleViewPipeline({ includeCompleted: true }, stateDir, store);

    expect(result.success).toBe(true);
    // Byte-identical to the pre-DR-3 payload: exactly { workflows, total }, no
    // summary/truncated/total-echo, and no narrow affordance on the envelope.
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['total', 'workflows']);
    expect((data.workflows as unknown[]).length).toBe(3);
    expect(data.total).toBe(3);
    expect(result.next_actions).toBeUndefined();
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
