// ─── Request Synthesize Handler Tests (T11) ────────────────────────────────
//
// Exercises handleRequestSynthesize:
//   - Appends `synthesize.requested` event when workflow is oneshot
//   - Rejects non-oneshot workflow types (feature/debug/refactor)
//   - Rejects missing workflow state
//   - Idempotent across multiple calls (append semantics; count >= 1 suffices
//     for the downstream guard)
//   - Captures optional `reason` in event data
//   - Emits an ISO-8601 timestamp parseable as a Date
// ────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolResult } from '../format.js';
import type { EventStore } from '../event-store/store.js';

// ─── Mock fs (resolve-state reads workflow state via node:fs) ──────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { existsSync, readFileSync } from 'node:fs';
import { handleRequestSynthesize } from './request-synthesize.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeOneshotState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    featureId: 'feat-oneshot-1',
    workflowType: 'oneshot',
    // `implementing` is the primary request-synthesize phase per the
    // registry gating + runtime guard. `plan` is also accepted for the
    // "I already know I'll want a PR" early-signal path.
    phase: 'implementing',
    createdAt: '2026-04-11T00:00:00.000Z',
    oneshot: { synthesisPolicy: 'on-request' },
    ...overrides,
  });
}

function makeFeatureState(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    featureId: 'feat-full-1',
    workflowType: 'feature',
    phase: 'delegate',
    createdAt: '2026-04-11T00:00:00.000Z',
    ...overrides,
  });
}

interface AppendCall {
  streamId: string;
  event: {
    type: string;
    data?: Record<string, unknown>;
  };
}

/**
 * Minimal EventStore stub exposing `append()` and `query()`. The resolver
 * falls back to the event-store path when the on-disk state file is
 * missing, so we also stub `query()` to return an empty event list —
 * the resulting zero-initialized projection then trips the STATE_NOT_FOUND
 * sentinel in `handleRequestSynthesize`.
 */
function makeMockEventStore(): {
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
  const querySpy = vi.fn(async () => []);
  const store = { append: appendSpy, query: querySpy } as unknown as EventStore;
  return { store, calls, appendSpy };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('handleRequestSynthesize', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('handleRequestSynthesize_appendsSynthesizeRequestedEvent', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState());
    const { store, calls } = makeMockEventStore();

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
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

  it('handleRequestSynthesize_isIdempotentAcrossMultipleCalls', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState());
    const { store, calls } = makeMockEventStore();

    const first = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });
    const second = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    // Both calls succeed — append semantics, not dedup
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    // Two events appended; downstream guard uses count >= 1 semantics,
    // so replays remain safe even with multiple requests.
    expect(calls).toHaveLength(2);
    expect(calls[0].event.type).toBe('synthesize.requested');
    expect(calls[1].event.type).toBe('synthesize.requested');
  });

  it('handleRequestSynthesize_rejectsNonOneshotWorkflow', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeFeatureState());
    const { store, calls } = makeMockEventStore();

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-full-1',
      stateFile: '/tmp/feat-full-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_WORKFLOW_TYPE');
    expect(result.error?.message).toMatch(/oneshot/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_capturesOptionalReason', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState());
    const { store, calls } = makeMockEventStore();

    const reason = 'Reviewer asked for a PR instead of direct commit';
    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      reason,
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    const data = calls[0].event.data as Record<string, unknown>;
    expect(data.reason).toBe(reason);

    const resultData = result.data as { eventAppended: boolean; reason?: string };
    expect(resultData.reason).toBe(reason);
  });

  it('handleRequestSynthesize_rejectsNonExistentWorkflow', async () => {
    mockExistsSync.mockReturnValue(false);
    const { store, calls } = makeMockEventStore();

    const result: ToolResult = await handleRequestSynthesize({
      featureId: 'feat-missing',
      stateFile: '/tmp/feat-missing.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('STATE_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_timestampIsISOString', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState());
    const { store, calls } = makeMockEventStore();

    await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(calls).toHaveLength(1);
    const data = calls[0].event.data as Record<string, unknown>;
    const ts = data.timestamp as string;
    const parsed = new Date(ts);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // Confirm it's a full ISO-8601 string (Zod datetime() accepts only this form).
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  // ─── Runtime phase guard (mirrors the registry gating) ────────────────────

  it('handleRequestSynthesize_acceptsPlanPhase', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState({ phase: 'plan' }));
    const { store, calls } = makeMockEventStore();

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_completed', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState({ phase: 'completed' }));
    const { store, calls } = makeMockEventStore();

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(result.error?.message).toMatch(/completed/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_cancelled', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState({ phase: 'cancelled' }));
    const { store, calls } = makeMockEventStore();

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(result.error?.message).toMatch(/cancelled/);
    expect(calls).toHaveLength(0);
  });

  it('handleRequestSynthesize_rejectsTerminalPhases_synthesize', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState({ phase: 'synthesize' }));
    const { store, calls } = makeMockEventStore();

    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateFile: '/tmp/feat-oneshot-1.state.json',
      eventStore: store,
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_PHASE');
    expect(calls).toHaveLength(0);
  });

  // ─── stateDir fallback (replaces hardcoded .exarchos/state path) ──────────

  it('handleRequestSynthesize_derivesStateFileFromStateDir', async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(makeOneshotState());
    const { store, calls } = makeMockEventStore();

    // No `stateFile` provided; the handler should derive one from
    // `stateDir + featureId` rather than the old hardcoded
    // `.exarchos/state/...` path.
    const result = await handleRequestSynthesize({
      featureId: 'feat-oneshot-1',
      stateDir: '/custom/state/dir',
      eventStore: store,
    });

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    // Resolver should have been asked to read from the derived path.
    expect(mockExistsSync).toHaveBeenCalledWith('/custom/state/dir/feat-oneshot-1.state.json');
  });
});
