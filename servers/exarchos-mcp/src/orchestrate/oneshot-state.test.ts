// ─── Shared oneshot-state resolver tests (DR-10) ────────────────────────────
//
// `resolveOneshotState` is the extracted-shared validation that
// finalize-oneshot and request-synthesize both funnel through: resolver-error
// translation, empty-projection "no workflow exists" sentinel, and the
// oneshot workflow-type check. These tests pin that contract directly (the
// handler suites exercise it end-to-end).

import { describe, it, expect, vi } from 'vitest';
import type { EventStore } from '../event-store/store.js';
import type { WorkflowEvent } from '../event-store/schemas.js';
import { resolveOneshotState } from './oneshot-state.js';

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

/** Event-store stub whose `query` folds the seeded events (event-store-first). */
function storeReturning(events: WorkflowEvent[]): EventStore {
  return { query: vi.fn(async () => events) } as unknown as EventStore;
}

/** Event-store stub whose `query` throws — drives the EVENT_STORE_ERROR path. */
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
      // The action label is threaded into the message so each caller's error
      // reads with its own verb.
      expect(result.error.error?.message).toContain('request_synthesize');
      expect(result.error.error?.message).toContain('workflowType=feature');
    }
  });

  it('ResolveOneshotState_EmptyProjection_ReturnsStateNotFound', async () => {
    // No events → the resolver returns a zero-initialized projection
    // (featureId: '', createdAt: '') which the sentinel treats as "no workflow".
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

  it('ResolveOneshotState_EventStoreError_TranslatesToStateNotFound', async () => {
    const store = storeThrowing();

    const result = await resolveOneshotState({
      featureId: 'feat-x',
      eventStore: store,
      action: 'finalize_oneshot',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // EVENT_STORE_ERROR is translated into the STATE_NOT_FOUND taxonomy the
      // oneshot handlers expect.
      expect(result.error.error?.code).toBe('STATE_NOT_FOUND');
    }
  });
});
