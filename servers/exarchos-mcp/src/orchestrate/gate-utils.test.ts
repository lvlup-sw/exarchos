// ─── Gate Utils Tests ─────────────────────────────────────────────────────────

import { describe, it, expect, vi } from 'vitest';
import { emitGateEvent, resolveRepoRoot, AUTO_REPO_ROOT } from './gate-utils.js';
import type { EventStore } from '../event-store/store.js';

describe('emitGateEvent', () => {
  // ─── Test 1: Valid input appends gate.executed event ─────────────────────

  it('emitGateEvent_ValidInput_AppendsGateExecutedEvent', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-1', 'test-gate', 'CI', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledOnce();
    expect(mockStore.append).toHaveBeenCalledWith('stream-1', {
      type: 'gate.executed',
      data: { gateName: 'test-gate', layer: 'CI', passed: true },
    });
  });

  // ─── Test 2: With details includes details in payload ────────────────────

  it('emitGateEvent_WithDetails_IncludesDetailsInPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };
    const details = { passCount: 10, failCount: 2 };

    // Act
    await emitGateEvent(mockStore as any, 'stream-2', 'test-suite', 'CI', false, details);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-2', {
      type: 'gate.executed',
      data: { gateName: 'test-suite', layer: 'CI', passed: false, details },
    });
  });

  // ─── Test 3: With custom layer uses provided layer ───────────────────────

  it('emitGateEvent_WithCustomLayer_UsesProvidedLayer', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-3', 'design-check', 'design', true);

    // Assert
    expect(mockStore.append).toHaveBeenCalledWith('stream-3', {
      type: 'gate.executed',
      data: { gateName: 'design-check', layer: 'design', passed: true },
    });
  });

  // ─── Test 4: Without details omits details from payload ──────────────────

  it('emitGateEvent_WithoutDetails_OmitsDetailsFromPayload', async () => {
    // Arrange
    const mockStore = { append: vi.fn().mockResolvedValue(undefined) };

    // Act
    await emitGateEvent(mockStore as any, 'stream-4', 'post-merge', 'post-merge', true);

    // Assert
    const calledEvent = mockStore.append.mock.calls[0][1];
    expect(calledEvent.data).not.toHaveProperty('details');
  });
});

// ─── resolveRepoRoot (#1330 / T-04) ────────────────────────────────────────

describe('resolveRepoRoot', () => {
  function storeWith(events: Array<{ type: string; data: unknown }>): EventStore {
    return { query: vi.fn().mockResolvedValue(events) } as unknown as EventStore;
  }

  it('resolveRepoRoot_NoRepoRoot_DefaultsToProcessCwd', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot({ featureId: 'feat-1' }, store);
    expect(result).toEqual({ ok: true, repoRoot: process.cwd() });
  });

  it('resolveRepoRoot_LiteralPath_ReturnedVerbatim', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: '/home/user/project' },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/home/user/project' });
    // No event lookup needed for a literal path.
    expect((store.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('resolveRepoRoot_AutoWithWorktreePathArg_PrefersArg', async () => {
    const store = storeWith([
      { type: 'worktree.created', data: { taskId: 'task-9', worktreePath: '/from/event' } },
    ]);
    const result = await resolveRepoRoot(
      {
        featureId: 'feat-1',
        repoRoot: AUTO_REPO_ROOT,
        worktreePath: '/from/arg',
        taskId: 'task-9',
      },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/from/arg' });
    // The explicit arg wins; no event lookup performed.
    expect((store.query as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('resolveRepoRoot_AutoNoArg_ResolvesLatestWorktreeCreatedEventForTask', async () => {
    const store = storeWith([
      { type: 'worktree.created', data: { taskId: 'task-9', worktreePath: '/old' } },
      { type: 'worktree.created', data: { taskId: 'other', worktreePath: '/wrong-task' } },
      { type: 'worktree.created', data: { taskId: 'task-9', worktreePath: '/latest' } },
    ]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: AUTO_REPO_ROOT, taskId: 'task-9' },
      store,
    );
    expect(result).toEqual({ ok: true, repoRoot: '/latest' });
  });

  it('resolveRepoRoot_AutoUnresolvable_ReturnsError', async () => {
    const store = storeWith([]);
    const result = await resolveRepoRoot(
      { featureId: 'feat-1', repoRoot: AUTO_REPO_ROOT, taskId: 'task-9' },
      store,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('task-9');
  });
});
