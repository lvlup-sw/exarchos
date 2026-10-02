// Tests for `resolveOneshotState`, the shared check behind `finalize-oneshot.ts` and `request-synthesize.ts`.
// It translates resolver errors, treats an empty projection as no workflow, and checks the oneshot
// workflow type. The handler suites cover it end to end.

import { describe, it, expect, vi } from 'vitest';
import type { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { resolveOneshotState } from '../../../../src/verbs/tasks/oneshot-state.js';

let _seq = 0;
function ev(type: string, data: Record<string, unknown>): WorkflowEvent {
  _seq += 1;
  return {
    streamId: 'test-stream',
    sequence: _seq,
    timestamp: '2026-04-11T00:00:00.000Z',
    type,
    schemaVersion: '1.0',
    data,
  } as WorkflowEvent;
}

/** An event-store stub whose `query` returns the seeded events. */
function storeReturning(events: WorkflowEvent[]): EventStore {
  return { query: vi.fn(async () => events) } as unknown as EventStore;
}

/** An event-store stub whose `query` throws, for the `EVENT_STORE_ERROR` path. */
function storeThrowing(): EventStore {
  return {
    query: vi.fn(async () => {
      throw new Error('boom');
    }),
  } as unknown as EventStore;
}

describe('resolveOneshotState (shared oneshot validation, DR-10)', () => {
  it('ResolveOneshotState_ValidOneshot_ReturnsOk', async () => {
    const store = storeReturning([
      ev('workflow.started', {
        featureId: 'feat-oneshot-1',
        workflowType: 'oneshot',
        synthesisPolicy: 'on-request',
      }),
    ]);

    const result = await resolveOneshotState({
      featureId: 'feat-oneshot-1',
      eventStore: store,
      action: 'finalize_oneshot',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.workflowType).toBe('oneshot');
      expect(result.state.featureId).toBe('feat-oneshot-1');
    }
  });

  /** The message carries the action label, so the error of each caller names its own verb. */
  it('ResolveOneshotState_NonOneshot_ReturnsInvalidWorkflowTypeWithActionLabel', async () => {
    const store = storeReturning([
      ev('workflow.started', { featureId: 'feat-full-1', workflowType: 'feature' }),
    ]);

    const result = await resolveOneshotState({
      featureId: 'feat-full-1',
      eventStore: store,
      action: 'request_synthesize',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.success).toBe(false);
      expect(result.error.error?.code).toBe('INVALID_WORKFLOW_TYPE');
      expect(result.error.error?.message).toContain('request_synthesize');
      expect(result.error.error?.message).toContain('workflowType=feature');
    }
  });

  /**
   * With no events, the resolver returns a zero-initialized projection with empty `featureId` and `createdAt`.
   * The sentinel treats that projection as no workflow.
   */
  it('ResolveOneshotState_EmptyProjection_ReturnsStateNotFound', async () => {
    const store = storeReturning([]);

    const result = await resolveOneshotState({
      featureId: 'never-created',
      eventStore: store,
      action: 'finalize_oneshot',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error?.code).toBe('STATE_NOT_FOUND');
      expect(result.error.error?.message).toBe(
        'State not found for feature: never-created',
      );
    }
  });

  /** `resolveOneshotState` translates `EVENT_STORE_ERROR` into the `STATE_NOT_FOUND` code that the oneshot handlers expect. */
  it('ResolveOneshotState_EventStoreError_TranslatesToStateNotFound', async () => {
    const store = storeThrowing();

    const result = await resolveOneshotState({
      featureId: 'feat-x',
      eventStore: store,
      action: 'finalize_oneshot',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.error?.code).toBe('STATE_NOT_FOUND');
    }
  });
});
