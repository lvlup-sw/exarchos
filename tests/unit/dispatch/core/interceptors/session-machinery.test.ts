/**
 * Tests for the swallow path of `runSessionMachineryConsumedInterceptor`. The interceptor must
 * keep a store failure out of the dispatch result, and it must log a warning for that failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The logger mock must exist before the import of the interceptor, so the interceptor gets this
 * spy. `vi.hoisted` is necessary because `vi.mock` runs before module-level `const` declarations.
 */
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock('../../../../../src/logger.js', () => ({
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
} from '../../../../../src/dispatch/core/interceptors/session-machinery.js';
import type { EventStore } from '../../../../../src/events/store.js';

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

    await expect(
      runSessionMachineryConsumedInterceptor(failingStore, 'feature-xyz', 'task_complete'),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, message] = warnSpy.mock.calls[0];
    expect(ctx).toMatchObject({
      streamId: 'feature-xyz',
      actionVerb: 'task_complete',
    });
    expect(ctx).toHaveProperty('err');
    expect(typeof message).toBe('string');
    expect(message).toMatch(/session-machinery interceptor swallowed error/i);
  });

  /** The empty query result holds no `workflow.rehydrated` event, so the interceptor returns early. */
  it('does not emit warn on the happy path (no rehydrated event present)', async () => {
    const cleanStore = {
      query: vi.fn().mockResolvedValue([]),
      append: vi.fn(),
    } as unknown as EventStore;

    await runSessionMachineryConsumedInterceptor(cleanStore, 'feature-xyz', 'task_complete');

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
