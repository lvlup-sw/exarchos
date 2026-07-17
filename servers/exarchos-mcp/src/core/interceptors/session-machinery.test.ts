/**
 * F-05 — `runSessionMachineryConsumedInterceptor` swallow-path observability.
 *
 * The interceptor is documented as "logged-and-swallowed" — failures must
 * never propagate into the dispatch return path. Prior to F-05 the catch
 * was bare (`catch {}`), making T-12 regressions invisible to oncall.
 * This test pins the warn emission so the swallow path stays observable.
 *
 * Plan: docs/plans/archive/2026-05-09-rehydration-machinery-fixes.md (F-05)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// IMPORTANT: mock the logger module BEFORE importing the SUT so the
// interceptor closure captures the spy reference, not the real pino child.
// `vi.hoisted` is required because `vi.mock` is hoisted above module-level
// `const` declarations — without it the spy would be in the TDZ when the
// factory runs.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../logger.js', () => ({
  workflowLogger: {
    warn: warnSpy,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  runSessionMachineryConsumedInterceptor,
  __resetMachineryConsumedCache,
} from './session-machinery.js';
import type { EventStore } from '../../event-store/store.js';

describe('runSessionMachineryConsumedInterceptor — F-05 swallow-path warn', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    __resetMachineryConsumedCache();
  });

  it('emits workflowLogger.warn when EventStore.query throws (swallow path)', async () => {
    const failingStore = {
      query: vi.fn().mockRejectedValue(new Error('boom — synthetic store failure')),
      append: vi.fn(),
    } as unknown as EventStore;

    // The interceptor MUST NOT propagate the error.
    await expect(
      runSessionMachineryConsumedInterceptor(failingStore, 'feature-xyz', 'task_complete'),
    ).resolves.toBeUndefined();

    // The swallow path MUST emit a structured warn so oncall sees regressions.
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, message] = warnSpy.mock.calls[0]!;
    expect(ctx).toMatchObject({
      streamId: 'feature-xyz',
      actionVerb: 'task_complete',
    });
    // Structured `err` field — same convention as handleRehydrate / buildDegradedResponse.
    expect(ctx).toHaveProperty('err');
    expect(typeof message).toBe('string');
    expect(message).toMatch(/session-machinery interceptor swallowed error/i);
  });

  it('does not emit warn on the happy path (no rehydrated event present)', async () => {
    const cleanStore = {
      query: vi.fn().mockResolvedValue([]), // no workflow.rehydrated → early return
      append: vi.fn(),
    } as unknown as EventStore;

    await runSessionMachineryConsumedInterceptor(cleanStore, 'feature-xyz', 'task_complete');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
