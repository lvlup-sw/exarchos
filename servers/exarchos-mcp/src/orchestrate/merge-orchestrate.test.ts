// ─── handleMergeOrchestrate tests (T11) ────────────────────────────────────
//
// T11 — happy path. Top-level orchestrator handler that composes preflight
// (T06/T07) with executor (T15) and emits the `merge.preflight` event for
// observability. Asserts:
//   1. on preflight pass + execute success returns
//      { success: true, data: { phase: 'completed', mergeSha, rollbackSha,
//        preflight } }.
//   2. emits `merge.preflight` exactly once (direct stream append, NOT
//      wrapped in `gate.executed` — the dedicated schema (T03) is top-level).
//
// Out of scope (T12/T13/T14):
//   • preflight-fail abort branch
//   • dryRun
//   • resume
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EventStore } from '../event-store/store.js';
import type { DispatchContext } from '../core/dispatch.js';

import { handleMergeOrchestrate } from './merge-orchestrate.js';

// ─── Test helpers ──────────────────────────────────────────────────────────

function makeMockEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue({
      sequence: 1,
      type: 'merge.preflight',
      timestamp: new Date().toISOString(),
    }),
  } as unknown as EventStore;
}

function makeMockCtx(overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    stateDir: '/tmp/test-state',
    eventStore: makeMockEventStore(),
    enableTelemetry: false,
    ...overrides,
  };
}

const MERGE_SHA = 'a'.repeat(40);
const ROLLBACK_SHA = 'b'.repeat(40);

const PASSING_PREFLIGHT = {
  passed: true,
  ancestry: { passed: true, missing: [] as string[], target: 'main' },
  currentBranchProtection: { blocked: false, branch: 'feat/x' },
  worktree: { isMain: true, repoRoot: '/repo' },
  drift: {
    clean: true,
    uncommittedFiles: [] as string[],
    indexStale: false,
    detachedHead: false,
  },
};

describe('handleMergeOrchestrate (T11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleMergeOrchestrate_PreflightAndExecutePass_ReturnsCompletedToolResult', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        rollbackSha: ROLLBACK_SHA,
      },
    });

    const result = await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        // DI: bypass real preflight composer + executor
        preflight,
        executeMerge,
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      phase: 'completed',
      mergeSha: MERGE_SHA,
      rollbackSha: ROLLBACK_SHA,
      preflight: PASSING_PREFLIGHT,
    });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(executeMerge).toHaveBeenCalledTimes(1);
  });

  it('handleMergeOrchestrate_Always_EmitsMergePreflightEventOnce', async () => {
    const ctx = makeMockCtx();
    const preflight = vi.fn().mockResolvedValue(PASSING_PREFLIGHT);
    const executeMerge = vi.fn().mockResolvedValue({
      success: true,
      data: {
        phase: 'completed' as const,
        mergeSha: MERGE_SHA,
        rollbackSha: ROLLBACK_SHA,
      },
    });

    await handleMergeOrchestrate(
      {
        featureId: 'feat-x',
        sourceBranch: 'feat/x',
        targetBranch: 'main',
        taskId: 'T11',
        strategy: 'squash',
        preflight,
        executeMerge,
      },
      ctx,
    );

    // Filter to merge.preflight emissions only — handleExecuteMerge is
    // mocked here, so the only append in this test should be preflight.
    const appendMock = ctx.eventStore.append as ReturnType<typeof vi.fn>;
    const preflightCalls = appendMock.mock.calls.filter(
      (call) => (call[1] as { type?: string } | undefined)?.type === 'merge.preflight',
    );
    expect(preflightCalls).toHaveLength(1);
    expect(preflightCalls[0]).toEqual([
      'feat-x',
      {
        type: 'merge.preflight',
        data: {
          taskId: 'T11',
          sourceBranch: 'feat/x',
          targetBranch: 'main',
          passed: true,
        },
      },
    ]);
  });
});
