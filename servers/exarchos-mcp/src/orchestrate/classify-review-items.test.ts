import { describe, it, expect, vi } from 'vitest';
import { handleClassifyReviewItems } from './classify-review-items.js';
import type { ActionItem } from '../review/types.js';
import type { EventStore } from '../event-store/store.js';

function makeItem(overrides: Partial<ActionItem> = {}): ActionItem {
  return {
    type: 'comment-reply',
    pr: 1,
    description: 'sample',
    severity: 'major',
    normalizedSeverity: 'MEDIUM',
    ...overrides,
  };
}

function makeEventStore(): EventStore {
  return {
    append: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    batchAppend: vi.fn().mockResolvedValue(undefined),
  } as unknown as EventStore;
}

describe('handleClassifyReviewItems', () => {
  it('OrchestrateClassifyReviewItems_GivenItems_ReturnsClassificationResult', async () => {
    const items: ActionItem[] = [
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'HIGH' }),
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'MEDIUM' }),
      makeItem({ file: 'src/b.ts', normalizedSeverity: 'LOW' }),
    ];

    const result = await handleClassifyReviewItems({
      featureId: 'test-feature',
      actionItems: items,
    });

    expect(result.success).toBe(true);
    const data = result.data as {
      groups: Array<{ file: string | null; recommendation: string }>;
      summary: { totalItems: number; directCount: number; delegateCount: number };
    };
    expect(data.groups.length).toBe(2);
    expect(data.summary.totalItems).toBe(3);
  });

  it('OrchestrateClassifyReviewItems_OnInvocation_EmitsDispatchClassifiedEvent', async () => {
    const eventStore = makeEventStore();
    const items: ActionItem[] = [
      makeItem({ file: 'src/a.ts', normalizedSeverity: 'HIGH' }),
      makeItem({ file: 'src/b.ts', normalizedSeverity: 'MEDIUM' }),
      makeItem({ file: 'src/c.ts', normalizedSeverity: 'LOW' }),
      makeItem({ file: 'src/c.ts', normalizedSeverity: 'LOW' }),
    ];

    await handleClassifyReviewItems({
      featureId: 'test-feature',
      actionItems: items,
      eventStore,
    });

    expect(eventStore.append).toHaveBeenCalledTimes(1);
    const [streamId, event] = (eventStore.append as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(streamId).toBe('test-feature');
    expect(event.type).toBe('dispatch.classified');
    expect(event.data.severityDistribution).toEqual({ high: 1, medium: 1, low: 2 });
    expect(event.data.groupCount).toBe(3);
  });

  it('OrchestrateClassifyReviewItems_MissingFeatureId_ReturnsInvalidInput', async () => {
    const result = await handleClassifyReviewItems({
      featureId: '',
      actionItems: [],
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('OrchestrateClassifyReviewItems_NoEventStore_StillReturnsResult', async () => {
    const result = await handleClassifyReviewItems({
      featureId: 'test-feature',
      actionItems: [makeItem()],
    });
    expect(result.success).toBe(true);
  });

  it('OrchestrateClassifyReviewItems_DispatchClassifiedEvent_UsesIdempotencyKey', async () => {
    const eventStore = makeEventStore();
    const items: ActionItem[] = [makeItem({ threadId: 'thread-1' })];
    await handleClassifyReviewItems({
      featureId: 'feat-x',
      actionItems: items,
      eventStore,
    });

    const opts = (eventStore.append as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts).toBeDefined();
    expect(opts.idempotencyKey).toBeDefined();
    expect(opts.idempotencyKey).toMatch(/^feat-x:dispatch\.classified:[0-9a-f]{16}$/);
  });

  it('OrchestrateClassifyReviewItems_SameInputs_ProducesSameIdempotencyKey', async () => {
    const eventStore1 = makeEventStore();
    const eventStore2 = makeEventStore();
    const items: ActionItem[] = [
      makeItem({ threadId: 'thread-1', file: 'src/a.ts' }),
      makeItem({ threadId: 'thread-2', file: 'src/b.ts' }),
    ];
    await handleClassifyReviewItems({ featureId: 'feat-x', actionItems: items, eventStore: eventStore1 });
    await handleClassifyReviewItems({ featureId: 'feat-x', actionItems: items, eventStore: eventStore2 });

    const key1 = (eventStore1.append as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;
    const key2 = (eventStore2.append as ReturnType<typeof vi.fn>).mock.calls[0][2].idempotencyKey;
    expect(key1).toBe(key2);
  });
});
