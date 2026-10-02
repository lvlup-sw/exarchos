// Tests for `handleRequestSynthesize`. The handler resolves state from the event
// store first, so the tests seed events that fold to the wanted state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../../../../src/format.js';
import type { EventStore } from '../../../../src/events/store.js';
import type { WorkflowEvent } from '../../../../src/events/schemas.js';
import { handleRequestSynthesize } from '../../../../src/verbs/team/request-synthesize.js';

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

/** Events folding to a oneshot workflow at `phase` (INITIAL_PHASE.oneshot = 'plan'). */
function oneshotEvents(phase = 'plan'): WorkflowEvent[] {
  const evs = [
    ev('workflow.started', {
      featureId: 'feat-oneshot-1',
      workflowType: 'oneshot',
      synthesisPolicy: 'on-request',
    }),
  ];
  if (phase !== 'plan') evs.push(ev('workflow.transition', { to: phase }));
  return evs;
}

/** Events folding to a feature workflow at `phase` (INITIAL_PHASE.feature = 'ideate'). */
function featureEvents(phase = 'ideate'): WorkflowEvent[] {
  const evs = [
    ev('workflow.started', { featureId: 'feat-full-1', workflowType: 'feature' }),
  ];
  if (phase !== 'ideate') evs.push(ev('workflow.transition', { to: phase }));
  return evs;
}

interface AppendCall {
  streamId: string;
  event: {
    type: string;
    data?: Record<string, unknown>;
  };
}

/**
 * An `EventStore` stub. `query()` returns the seeded events for the resolver to fold,
 * and `append()` records each call.
 */
function makeMockEventStore(events: WorkflowEvent[] = []): {
  store: EventStore;
  calls: AppendCall[];
  appendSpy: ReturnType<typeof vi.fn>;
} {
  const calls: AppendCall[] = [];
  const appendSpy = vi.fn(async (streamId: string, event: AppendCall['event']) => {
    calls.push({ streamId, event });
    return {
      streamId,
      sequence: calls.length,
      type: event.type,
      timestamp: new Date().toISOString(),
      data: event.data ?? {},
    };
  });
  const querySpy = vi.fn(async () => events);
  const store = { append: appendSpy, query: querySpy } as unknown as EventStore;
  return { store, calls, appendSpy };
}

describe('handleRequestSynthesize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleRequestSynthesize_appendsSynthesizeRequestedEvent', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('implementing'));

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].streamId).toBe('feat-oneshot-1');
    expect(calls[0].event.type).toBe('synthesize.requested');
    const data = calls[0].event.data as Record<string, unknown>;
    expect(data.featureId).toBe('feat-oneshot-1');
    expect(typeof data.timestamp).toBe('string');

    const resultData = result.data as { eventAppended: boolean; reason?: string };
    expect(resultData.eventAppended).toBe(true);
  });

  /** Each call appends an event. The guard checks only that at least one event exists, so a repeated request is safe. */
  it('handleRequestSynthesize_isIdempotentAcrossMultipleCalls', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('implementing'));

    const first = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });
    const second = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].event.type).toBe('synthesize.requested');
    expect(calls[1].event.type).toBe('synthesize.requested');
  });

  it('handleRequestSynthesize_rejectsNonOneshotWorkflow', async () => {
    const { store, calls } = makeMockEventStore(featureEvents('delegate'));

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-full-1',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_WORKFLOW_TYPE');
    expect(result.error?.message).toMatch(/oneshot/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_capturesOptionalReason', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('implementing'));

    const reason = 'Reviewer asked for a PR instead of direct commit';
    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      reason,
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const data = calls[0].event.data as Record<string, unknown>;
    expect(data.reason).toBe(reason);

    const resultData = result.data as { eventAppended: boolean; reason?: string };
    expect(resultData.reason).toBe(reason);
  });

  /** With no events, the resolver folds an empty projection and returns `STATE_NOT_FOUND`. */
  it('handleRequestSynthesize_rejectsNonExistentWorkflow', async () => {
    const { store, calls } = makeMockEventStore([]);

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-missing',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  /** The timestamp must be a full ISO-8601 string, because Zod `datetime()` rejects other forms. */
  it('handleRequestSynthesize_timestampIsISOString', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('implementing'));

    await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(calls).toHaveLength(1);
    const data = calls[0].event.data as Record<string, unknown>;
    const ts = data.timestamp as string;
    const parsed = new Date(ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('handleRequestSynthesize_acceptsPlanPhase', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('plan'));

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_completed', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('completed'));

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(result.error?.message).toMatch(/completed/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_cancelled', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('cancelled'));

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(result.error?.message).toMatch(/cancelled/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_synthesize', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('synthesize'));

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(calls).toHaveLength(0);
  });

  /** With `stateDir` and an event store, the handler still resolves state from the events. */
  it('handleRequestSynthesize_resolvesFromEventsWhenGivenStateDir', async () => {
    const { store, calls } = makeMockEventStore(oneshotEvents('implementing'));

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateDir: '/custom/state/dir',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
