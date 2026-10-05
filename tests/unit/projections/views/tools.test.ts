/**
 * Tests for the view contract on the inventory views and the analytic views.
 *
 * Each view is compact by default, and `detail: true` restores the full rows. A list-shaped view
 * returns `page` metadata. A scoped view reports `scope` and `unscopedTotal`, so a caller can see
 * that rows are hidden. Each default response stays under the effective token budget of its action.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resetMaterializerCache,
  handleViewDelegationTimeline,
  handleViewTeamPerformance,
  handleViewWorkflowStatus,
  handleViewTasks,
  handleViewCodeQuality,
  handleViewEvalResults,
  handleViewQualityHints,
  handleViewQualityCorrelation,
  handleViewQualityAttribution,
  handleViewSessionProvenance,
  handleViewDelegationReadiness,
  handleViewSynthesisReadiness,
  handleViewShepherdStatus,
  handleViewProvenance,
  handleViewConvergence,
} from '../../../../src/projections/views/tools.js';
import { EventStore } from '../../../../src/events/store.js';
import { TOOL_REGISTRY, resolveEconomyBudget } from '../../../../src/registry.js';
import { estimateOutputTokens, DEFAULT_VIEW_ITEM_CAP } from '../../../../src/dispatch/core/economy.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The effective response budget of a view action, which the dispatch core enforces. */
function effectiveBudget(action: string): number {
  const viewTool = TOOL_REGISTRY.find((t) => t.name === 'exarchos_view')!;
  const descriptor = viewTool.actions.find((a) => a.name === action)!;
  return resolveEconomyBudget(descriptor);
}

async function seedAssignedTask(
  store: EventStore,
  streamId: string,
  taskId: string,
  teammateName: string,
  correlationId?: string,
): Promise<void> {
  await store.append(streamId, {
    type: 'team.task.assigned',
    ...(correlationId ? { correlationId, operationId: `op-${correlationId}` } : {}),
    data: {
      taskId,
      teammateName,
      worktreePath: `/tmp/wt-${taskId}`,
      modules: ['auth'],
    },
  });
}

/** The inventory views: `delegation_timeline`, `team_performance`, `workflow_status` and `tasks`. */
describe('DR-8 inventory view contract (Task 013)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-views-contract-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  /**
   * The compact rows omit the `assignedAt` and `completedAt` timestamps, and `detail: true`
   * restores them. An explicit `limit` narrows the window and sets `page.hasMore`.
   */
  it('viewsContract_ListShaped_ReturnPageMetadataAndHonorDetail', async () => {
    const streamId = 'contract-list';
    await seedAssignedTask(store, streamId, 'task-1', 'w1');
    await seedAssignedTask(store, streamId, 'task-2', 'w2');
    await seedAssignedTask(store, streamId, 'task-3', 'w3');

    const compact = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as {
      page: { total: number; offset: number; limit: number; hasMore: boolean };
      tasks: Array<Record<string, unknown>>;
    };
    expect(compactData.page).toEqual({
      total: 3,
      offset: 0,
      limit: DEFAULT_VIEW_ITEM_CAP,
      hasMore: false,
    });
    expect(compactData.tasks).toHaveLength(3);
    for (const row of compactData.tasks) {
      expect(row).toHaveProperty('taskId');
      expect(row).not.toHaveProperty('assignedAt');
      expect(row).not.toHaveProperty('completedAt');
    }

    const detailed = await handleViewDelegationTimeline(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedData = detailed.data as { tasks: Array<Record<string, unknown>> };
    for (const row of detailedData.tasks) {
      expect(row).toHaveProperty('assignedAt');
      expect(row).toHaveProperty('completedAt');
    }

    const paged = await handleViewDelegationTimeline(
      { workflowId: streamId, limit: 1, offset: 0 },
      tmpDir,
      store,
    );
    const pagedData = paged.data as {
      page: { total: number; limit: number; hasMore: boolean };
      tasks: unknown[];
    };
    expect(pagedData.tasks).toHaveLength(1);
    expect(pagedData.page).toMatchObject({ total: 3, limit: 1, hasMore: true });
  });

  /**
   * The stream holds 120 tasks, more than `DEFAULT_VIEW_ITEM_CAP`. The compact rows and the
   * default cap must keep the response under the effective budget.
   */
  it('viewsContract_MigratedView_StaysUnderEffectiveBudget', async () => {
    const streamId = 'contract-budget';
    for (let i = 0; i < 120; i++) {
      await seedAssignedTask(store, streamId, `t${i}`, 'w');
    }

    const result = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    expect(result.success).toBe(true);

    const budget = effectiveBudget('delegation_timeline');
    const data = result.data as { tasks: unknown[] };
    expect(data.tasks.length).toBe(DEFAULT_VIEW_ITEM_CAP);
    expect(estimateOutputTokens(result.data)).toBeLessThanOrEqual(budget);
  });

  /**
   * The correlation filter is the scope of this view. One of the two tasks is in scope, but
   * `unscopedTotal` still reports both, and a `next_actions` entry points to the hidden row.
   * A call with no filter reports the scope `all`.
   */
  it('viewsContract_ScopedView_ReportsUnscopedTotal', async () => {
    const streamId = 'contract-scope';
    await seedAssignedTask(store, streamId, 'task-X', 'wx', 'cor-X');
    await seedAssignedTask(store, streamId, 'task-Y', 'wy', 'cor-Y');

    const result = await handleViewDelegationTimeline(
      { workflowId: streamId, correlationId: 'cor-X' },
      tmpDir,
      store,
    );
    expect(result.success).toBe(true);
    const data = result.data as {
      scope: string;
      unscopedTotal: number;
      page: { total: number };
      tasks: Array<{ taskId: string }>;
    };

    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0].taskId).toBe('task-X');
    expect(data.scope).toBe('correlation');
    expect(data.page.total).toBe(1);
    expect(data.unscopedTotal).toBe(2);

    expect(result.next_actions?.some((a) => a.verb === 'delegation_timeline')).toBe(true);

    const unscoped = await handleViewDelegationTimeline({ workflowId: streamId }, tmpDir, store);
    const unscopedData = unscoped.data as { scope: string; unscopedTotal: number };
    expect(unscopedData.scope).toBe('all');
    expect(unscopedData.unscopedTotal).toBe(2);
  });

  /**
   * The compact response drops the `modules` roll-up and the `moduleExpertise` of each teammate.
   * `detail: true` restores both.
   */
  it('viewsContract_TeamPerformance_CompactByDefault_DetailRestoresModules', async () => {
    const streamId = 'contract-team';
    await store.append(streamId, {
      type: 'team.task.completed',
      data: {
        taskId: 'task-1',
        teammateName: 'worker-1',
        durationMs: 5000,
        filesChanged: ['src/auth/login.ts'],
        testsPassed: true,
        qualityGateResults: {},
      },
    });

    const compact = await handleViewTeamPerformance({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as {
      teammates: Record<string, Record<string, unknown>>;
      modules?: unknown;
    };
    expect(compactData.teammates).toHaveProperty('worker-1');
    expect(compactData.modules).toBeUndefined();
    expect(compactData.teammates['worker-1']).not.toHaveProperty('moduleExpertise');

    const detailed = await handleViewTeamPerformance(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedData = detailed.data as {
      modules: Record<string, unknown>;
      teammates: Record<string, Record<string, unknown>>;
    };
    expect(detailedData).toHaveProperty('modules');
    expect(detailedData.teammates['worker-1']).toHaveProperty('moduleExpertise');
  });

  /** The compact response keeps the public fields and omits the internal `_taskStore`. */
  it('viewsContract_WorkflowStatus_CompactStripsInternalTaskStore', async () => {
    const streamId = 'contract-status';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: 'status-feature', workflowType: 'feature' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Build' },
    });

    const compact = await handleViewWorkflowStatus({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactData = compact.data as Record<string, unknown>;
    expect(compactData.featureId).toBe('status-feature');
    expect(compactData).not.toHaveProperty('_taskStore');

    const detailed = await handleViewWorkflowStatus(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    expect((detailed.data as Record<string, unknown>)).toHaveProperty('_taskStore');
  });

  /**
   * `data` stays a bare array, so `page`, `scope` and `unscopedTotal` go on `_meta`. The compact
   * rows drop `artifacts` and `duration`, and `detail: true` restores them. A status filter gives
   * the scope `filtered`, and `unscopedTotal` still reports both tasks.
   */
  it('viewsContract_Tasks_FilterScope_ReportsUnscopedTotalOnMeta', async () => {
    const streamId = 'contract-tasks';
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't1', title: 'Task 1', branch: 'feat/t1' },
    });
    await store.append(streamId, {
      type: 'task.assigned',
      data: { taskId: 't2', title: 'Task 2', branch: 'feat/t2' },
    });
    await store.append(streamId, {
      type: 'task.completed',
      data: { taskId: 't1', artifacts: ['a.ts'], duration: 30 },
    });

    const all = await handleViewTasks({ workflowId: streamId }, tmpDir, store);
    expect(all.success).toBe(true);
    expect(Array.isArray(all.data)).toBe(true);
    const allMeta = all._meta as {
      page: { total: number; offset: number; limit: number; hasMore: boolean };
      scope: string;
      unscopedTotal: number;
    };
    expect(allMeta.page).toEqual({
      total: 2,
      offset: 0,
      limit: DEFAULT_VIEW_ITEM_CAP,
      hasMore: false,
    });
    expect(allMeta.scope).toBe('all');
    expect(allMeta.unscopedTotal).toBe(2);
    const completed = (all.data as Array<Record<string, unknown>>).find((t) => t.taskId === 't1')!;
    expect(completed).not.toHaveProperty('artifacts');
    expect(completed).not.toHaveProperty('duration');

    const filtered = await handleViewTasks(
      { workflowId: streamId, filter: { status: 'completed' } },
      tmpDir,
      store,
    );
    const filteredMeta = filtered._meta as {
      page: { total: number };
      scope: string;
      unscopedTotal: number;
    };
    expect((filtered.data as unknown[]).length).toBe(1);
    expect(filteredMeta.scope).toBe('filtered');
    expect(filteredMeta.page.total).toBe(1);
    expect(filteredMeta.unscopedTotal).toBe(2);

    const detailed = await handleViewTasks(
      { workflowId: streamId, detail: true },
      tmpDir,
      store,
    );
    const detailedCompleted = (detailed.data as Array<Record<string, unknown>>).find(
      (t) => t.taskId === 't1',
    )!;
    expect(detailedCompleted).toHaveProperty('artifacts');
  });
});

interface Page {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

function asRecord(data: unknown): Record<string, unknown> {
  return data as Record<string, unknown>;
}

/**
 * The analytic views: `code_quality`, `eval_results`, `quality_hints`, `quality_correlation`,
 * `quality_attribution`, `session_provenance`, `delegation_readiness`, `synthesis_readiness`,
 * `shepherd_status`, `provenance` and `convergence`.
 */
describe('DR-8 analytic view contract (Task 024)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-views-analytic-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  async function seedGate(
    streamId: string,
    details: Record<string, unknown>,
    passed = true,
  ): Promise<void> {
    await store.append(streamId, {
      type: 'gate.executed',
      data: { gateName: 'typecheck', layer: 'build', passed, duration: 100, details },
    });
  }

  async function seedEvalRun(streamId: string, suiteId: string, runId: string): Promise<void> {
    await store.append(streamId, {
      type: 'eval.run.completed',
      data: { runId, suiteId, total: 10, passed: 8, failed: 2, avgScore: 0.8, duration: 5000, regressions: [] },
    });
  }

  /**
   * A skill filter on `code_quality` gives the scope `filtered`. The records before the filter are
   * two skills and one shared `typecheck` gate, so `unscopedTotal` is 3. The list-shaped
   * `provenance` view carries `page`.
   */
  it('viewsContract_AnalyticViews_ReturnPageAndScopeMetadata', async () => {
    const scopeStream = 'analytic-scope';
    await seedGate(scopeStream, { skill: 'delegation' });
    await seedGate(scopeStream, { skill: 'synthesis' });

    const scoped = await handleViewCodeQuality(
      { workflowId: scopeStream, skill: 'delegation' },
      tmpDir,
      store,
    );
    expect(scoped.success).toBe(true);
    const scopedData = asRecord(scoped.data);
    expect(scopedData.scope).toBe('filtered');
    expect(scopedData.unscopedTotal).toBe(3);
    expect(scoped.next_actions?.some((a) => a.verb === 'code_quality')).toBe(true);

    const unscoped = await handleViewCodeQuality({ workflowId: scopeStream }, tmpDir, store);
    expect(asRecord(unscoped.data).scope).toBe('all');

    const pageStream = 'analytic-page';
    await store.append(pageStream, {
      type: 'workflow.started',
      data: { featureId: pageStream, workflowType: 'feature' },
    });
    const paged = await handleViewProvenance({ workflowId: pageStream }, tmpDir, store);
    expect(paged.success).toBe(true);
    const page = asRecord(paged.data).page as Page;
    expect(page).toBeDefined();
    expect(page).toEqual(
      expect.objectContaining({
        total: expect.any(Number),
        offset: 0,
        limit: DEFAULT_VIEW_ITEM_CAP,
        hasMore: expect.any(Boolean),
      }),
    );
  });

  /**
   * 250 per-model records make the full projection exceed the effective budget. The compact
   * response drops `models`, which brings it under the budget. All events share one skill, so the
   * per-model records are the payload that the strip removes.
   */
  it('viewsContract_AnalyticView_StaysUnderEffectiveBudget', async () => {
    const streamId = 'analytic-budget';
    for (let i = 0; i < 250; i++) {
      await seedGate(streamId, { model: `model-${i}`, skill: 'delegation' });
    }

    const compact = await handleViewCodeQuality({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewCodeQuality({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);

    const budget = effectiveBudget('code_quality');
    expect(estimateOutputTokens(detail.data)).toBeGreaterThan(budget);
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(budget);
    expect(estimateOutputTokens(compact.data)).toBeLessThan(estimateOutputTokens(detail.data));
    expect(asRecord(compact.data).models).toBeUndefined();
    expect(asRecord(detail.data).models).toBeDefined();
  });

  it('viewsContract_CodeQuality_StaysUnderEffectiveBudget_StripsModelsByDefault', async () => {
    const streamId = 'cq';
    await seedGate(streamId, { model: 'm1', skill: 'delegation' });

    const compact = await handleViewCodeQuality({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewCodeQuality({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    expect(asRecord(compact.data).models).toBeUndefined();
    expect(asRecord(detail.data).models).toBeDefined();
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('code_quality'));
  });

  /** The test also checks that a skill filter gives the scope `filtered`. */
  it('viewsContract_EvalResults_StaysUnderEffectiveBudget_StripsCalibrationsByDefault', async () => {
    const streamId = 'er';
    await seedEvalRun(streamId, 'delegation', 'run-1');

    const compact = await handleViewEvalResults({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewEvalResults({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    expect(asRecord(compact.data).calibrations).toBeUndefined();
    expect(asRecord(detail.data).calibrations).toBeDefined();
    const scoped = await handleViewEvalResults({ workflowId: streamId, skill: 'delegation' }, tmpDir, store);
    expect(asRecord(scoped.data).scope).toBe('filtered');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('eval_results'));
  });

  it('viewsContract_QualityHints_StaysUnderEffectiveBudget_PagesHints', async () => {
    const streamId = 'qh';
    await seedGate(streamId, { skill: 'delegation' }, false);

    const compact = await handleViewQualityHints({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const page = asRecord(compact.data).page as Page;
    expect(page).toEqual(
      expect.objectContaining({ offset: 0, limit: DEFAULT_VIEW_ITEM_CAP, hasMore: expect.any(Boolean) }),
    );
    expect(asRecord(compact.data).scope).toBe('all');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('quality_hints'));
  });

  /** The compact skill row keeps `evalScore`. Only `detail: true` shows `regressionCount`. */
  it('viewsContract_QualityCorrelation_StaysUnderEffectiveBudget_StripsSkillTrendsByDefault', async () => {
    const streamId = 'qc';
    await seedGate(streamId, { skill: 'delegation' });
    await seedEvalRun(streamId, 'delegation', 'run-1');

    const compact = await handleViewQualityCorrelation({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewQualityCorrelation({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactSkill = asRecord(asRecord(compact.data).skills)['delegation'] as Record<string, unknown>;
    const detailSkill = asRecord(asRecord(detail.data).skills)['delegation'] as Record<string, unknown>;
    expect(compactSkill).toBeDefined();
    expect(compactSkill).toHaveProperty('evalScore');
    expect(compactSkill).not.toHaveProperty('regressionCount');
    expect(detailSkill).toHaveProperty('regressionCount');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('quality_correlation'));
  });

  it('viewsContract_QualityAttribution_StaysUnderEffectiveBudget_PagesEntriesStripsCorrelations', async () => {
    const streamId = 'qa';
    await seedGate(streamId, { skill: 'delegation' });
    await seedEvalRun(streamId, 'delegation', 'run-1');

    const compact = await handleViewQualityAttribution(
      { workflowId: streamId, dimension: 'skill' },
      tmpDir,
      store,
    );
    const detail = await handleViewQualityAttribution(
      { workflowId: streamId, dimension: 'skill', detail: true },
      tmpDir,
      store,
    );
    expect(compact.success).toBe(true);
    expect(asRecord(compact.data).page).toBeDefined();
    expect(asRecord(compact.data).correlations).toBeUndefined();
    expect(asRecord(detail.data).correlations).toBeDefined();
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('quality_attribution'));
  });

  it('viewsContract_SessionProvenance_StaysUnderEffectiveBudget_StripsFileListsByDefault', async () => {
    const sessionId = 'sess-1';
    await fs.mkdir(path.join(tmpDir, 'sessions'), { recursive: true });
    const events = [
      { t: 'tool', ts: '2026-01-01T00:00:00Z', tool: 'Read', cat: 'native', inB: 100, outB: 200, files: ['src/a.ts'], sid: sessionId },
      { t: 'tool', ts: '2026-01-01T00:01:00Z', tool: 'Write', cat: 'native', inB: 50, outB: 150, files: ['src/b.ts'], sid: sessionId },
    ];
    await fs.writeFile(
      path.join(tmpDir, 'sessions', `${sessionId}.events.jsonl`),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
      'utf-8',
    );

    const compact = await handleViewSessionProvenance({ sessionId }, tmpDir);
    const detail = await handleViewSessionProvenance({ sessionId, detail: true }, tmpDir);
    expect(compact.success).toBe(true);
    expect(asRecord(compact.data).files).toBeUndefined();
    expect(asRecord(detail.data).files).toBeDefined();
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('session_provenance'));
  });

  it('viewsContract_DelegationReadiness_StaysUnderEffectiveBudget_StripsTaskIdListsByDefault', async () => {
    const streamId = 'dr';
    await store.append(streamId, {
      type: 'team.task.assigned',
      data: { taskId: 'task-1', teammateName: 'w1', worktreePath: '/tmp/wt-1', modules: ['auth'] },
    });

    const compact = await handleViewDelegationReadiness({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewDelegationReadiness({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactWt = asRecord(asRecord(compact.data).worktrees);
    const detailWt = asRecord(asRecord(detail.data).worktrees);
    expect(compactWt).not.toHaveProperty('assignedTaskIds');
    expect(compactWt).not.toHaveProperty('readyTaskIds');
    expect(detailWt).toHaveProperty('assignedTaskIds');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('delegation_readiness'));
  });

  it('viewsContract_SynthesisReadiness_StaysUnderEffectiveBudget_StripsFindingsBreakdownByDefault', async () => {
    const streamId = 'sr';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });

    const compact = await handleViewSynthesisReadiness({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewSynthesisReadiness({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactReview = asRecord(asRecord(compact.data).review);
    const detailReview = asRecord(asRecord(detail.data).review);
    expect(compactReview).toHaveProperty('reviewPassed');
    expect(compactReview).not.toHaveProperty('findingsBySeverity');
    expect(detailReview).toHaveProperty('findingsBySeverity');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('synthesis_readiness'));
  });

  it('viewsContract_ShepherdStatus_StaysUnderEffectiveBudget_PagesPrs', async () => {
    const streamId = 'ss';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });

    const compact = await handleViewShepherdStatus({ workflowId: streamId }, tmpDir, store);
    expect(compact.success).toBe(true);
    const page = asRecord(compact.data).page as Page;
    expect(page).toEqual(
      expect.objectContaining({ offset: 0, limit: DEFAULT_VIEW_ITEM_CAP, hasMore: expect.any(Boolean) }),
    );
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('shepherd_status'));
  });

  it('viewsContract_Provenance_StaysUnderEffectiveBudget_StripsInternalTaskIdsPagesRequirements', async () => {
    const streamId = 'pv';
    await store.append(streamId, {
      type: 'workflow.started',
      data: { featureId: streamId, workflowType: 'feature' },
    });

    const compact = await handleViewProvenance({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewProvenance({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    expect(asRecord(compact.data).page).toBeDefined();
    expect(asRecord(compact.data)._completedTaskIds).toBeUndefined();
    expect(asRecord(detail.data)._completedTaskIds).toBeDefined();
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('provenance'));
  });

  it('viewsContract_Convergence_StaysUnderEffectiveBudget_StripsGateResultsByDefault', async () => {
    const streamId = 'cv';
    await store.append(streamId, {
      type: 'gate.executed',
      data: { gateName: 'design-completeness', layer: 'validation', passed: true, duration: 500, details: { dimension: 'D1' } },
    });

    const compact = await handleViewConvergence({ workflowId: streamId }, tmpDir, store);
    const detail = await handleViewConvergence({ workflowId: streamId, detail: true }, tmpDir, store);
    expect(compact.success).toBe(true);
    const compactDim = asRecord(asRecord(compact.data).dimensions)['D1'] as Record<string, unknown>;
    const detailDim = asRecord(asRecord(detail.data).dimensions)['D1'] as Record<string, unknown>;
    expect(compactDim).toBeDefined();
    expect(compactDim).toHaveProperty('converged');
    expect(compactDim).not.toHaveProperty('gateResults');
    expect(detailDim).toHaveProperty('gateResults');
    expect(estimateOutputTokens(compact.data)).toBeLessThanOrEqual(effectiveBudget('convergence'));
  });
});
