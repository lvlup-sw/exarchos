import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkflowEvent } from '../../event-store/schemas.js';
import type { WorkflowState } from '../../workflow/types.js';
import type { StorageBackend, EventSender } from '../backend.js';
import { InMemoryBackend, VersionConflictError } from '../memory-backend.js';
import { SqliteBackend } from '../sqlite-backend.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEvent(overrides: Partial<WorkflowEvent> = {}): WorkflowEvent {
  return {
    streamId: 'test-stream',
    sequence: 1,
    timestamp: '2025-01-15T10:00:00.000Z',
    type: 'workflow.started',
    schemaVersion: '1.0',
    ...overrides,
  } as WorkflowEvent;
}

function makeState(overrides: Partial<WorkflowState> = {}): WorkflowState {
  return {
    version: '1.1',
    featureId: 'test-feature',
    workflowType: 'feature',
    phase: 'ideate',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: { design: null, plan: null, pr: null },
    tasks: [],
    worktrees: {},
    reviews: {},
    integration: null,
    synthesis: {
      integrationBranch: null,
      mergeOrder: [],
      mergedBranches: [],
      prUrl: null,
      prFeedback: [],
    },
    _version: 1,
    _history: {},
    _checkpoint: {
      timestamp: '1970-01-01T00:00:00Z',
      phase: 'init',
      summary: 'Initial state',
      operationsSince: 0,
      fixCycleCount: 0,
      lastActivityTimestamp: '1970-01-01T00:00:00Z',
      staleAfterMinutes: 120,
    },
    ...overrides,
  } as WorkflowState;
}

function makeSender(result: { accepted: number; streamVersion: number } = { accepted: 1, streamVersion: 1 }): EventSender {
  return {
    appendEvents: () => Promise.resolve(result),
  };
}

function makeFailingSender(): EventSender {
  return {
    appendEvents: () => { throw new Error('Send failed'); },
  };
}

// ─── Parameterized Contract Tests ───────────────────────────────────────────

describe.each([
  ['InMemoryBackend', () => {
    const backend = new InMemoryBackend();
    backend.initialize();
    return { backend, cleanup: () => { backend.close(); } };
  }],
  ['SqliteBackend', () => {
    const dir = mkdtempSync(join(tmpdir(), 'contract-'));
    const backend = new SqliteBackend(join(dir, 'test.db'));
    backend.initialize();
    return { backend, cleanup: () => { backend.close(); rmSync(dir, { recursive: true }); } };
  }],
])('%s contract', (_name, factory) => {
  let backend: StorageBackend;
  let cleanup: () => void;

  afterEach(() => {
    cleanup();
  });

  function setup(): StorageBackend {
    const result = factory();
    backend = result.backend;
    cleanup = result.cleanup;
    return backend;
  }

  // ─── Event Operations ───────────────────────────────────────────────────

  it('appendEvent_SingleEvent_IncreasesSequence', () => {
    const b = setup();
    const event = makeEvent({ sequence: 1 });

    b.appendEvent('stream-a', event);

    expect(b.getSequence('stream-a')).toBe(1);
  });

  it('appendEvent_MultipleStreams_IsolatesSequences', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, streamId: 'stream-a' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, streamId: 'stream-a' }));
    b.appendEvent('stream-b', makeEvent({ sequence: 1, streamId: 'stream-b' }));

    expect(b.getSequence('stream-a')).toBe(2);
    expect(b.getSequence('stream-b')).toBe(1);
  });

  it('queryEvents_TypeFilter_ReturnsMatchingOnly', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, type: 'workflow.started' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, type: 'task.assigned' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3, type: 'workflow.started' }));

    const results = b.queryEvents('stream-a', { type: 'workflow.started' });

    expect(results).toHaveLength(2);
    expect(results.every(e => e.type === 'workflow.started')).toBe(true);
  });

  it('queryEvents_SinceSequenceFilter_ReturnsSubset', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));

    const results = b.queryEvents('stream-a', { sinceSequence: 1 });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
  });

  it('queryEvents_LimitAndOffset_PaginatesCorrectly', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 4 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 5 }));

    const results = b.queryEvents('stream-a', { limit: 2, offset: 1 });

    expect(results).toHaveLength(2);
    expect(results[0].sequence).toBe(2);
    expect(results[1].sequence).toBe(3);
  });

  it('getSequence_EmptyStream_ReturnsZero', () => {
    const b = setup();

    expect(b.getSequence('nonexistent-stream')).toBe(0);
  });

  it('getSequence_AfterAppends_ReturnsLastSequence', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3 }));

    expect(b.getSequence('stream-a')).toBe(3);
  });

  // ─── State Operations ──────────────────────────────────────────────────

  it('setState_NewState_CreatesEntry', () => {
    const b = setup();
    const state = makeState({ featureId: 'feat-1' });

    b.setState('feat-1', state);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.featureId).toBe('feat-1');
  });

  it('setState_CASMatch_Updates', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1', phase: 'ideate' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    // First set creates version 1
    b.setState('feat-1', state1);
    // CAS update with expectedVersion=1 should succeed (version becomes 2)
    b.setState('feat-1', state2, 1);

    const retrieved = b.getState('feat-1');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.phase).toBe('plan');
  });

  it('setState_CASMismatch_ThrowsVersionConflict', () => {
    const b = setup();
    const state1 = makeState({ featureId: 'feat-1' });
    const state2 = makeState({ featureId: 'feat-1', phase: 'plan' });

    // First set creates version 1
    b.setState('feat-1', state1);

    // CAS with wrong expected version should throw
    expect(() => b.setState('feat-1', state2, 99)).toThrow(VersionConflictError);
  });

  it('getState_NonExistent_ReturnsNull', () => {
    const b = setup();

    expect(b.getState('nonexistent')).toBeNull();
  });

  it('listStates_MultipleStates_ReturnsAll', () => {
    const b = setup();

    b.setState('feat-1', makeState({ featureId: 'feat-1' }));
    b.setState('feat-2', makeState({ featureId: 'feat-2' }));
    b.setState('feat-3', makeState({ featureId: 'feat-3' }));

    const states = b.listStates();

    expect(states).toHaveLength(3);
    const ids = states.map(s => s.featureId).sort();
    expect(ids).toEqual(['feat-1', 'feat-2', 'feat-3']);
  });

  // ─── Outbox Operations ─────────────────────────────────────────────────

  it('addOutboxEntry_ReturnsEntryId', () => {
    const b = setup();
    const event = makeEvent();

    const id = b.addOutboxEntry('stream-a', event);

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('drainOutbox_SuccessfulSend_DrainsBatch', async () => {
    const b = setup();
    const event = makeEvent();
    b.addOutboxEntry('stream-a', event);

    const sender = makeSender();
    const result = await b.drainOutbox('stream-a', sender);

    expect(result.sent).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('drainOutbox_EmptyOutbox_ReturnsZeroCounts', async () => {
    const b = setup();
    const sender = makeSender();

    const result = await b.drainOutbox('stream-a', sender);

    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  // ─── Stream Operations ─────────────────────────────────────────────────

  it('listStreams_MultipleStreams_ReturnsAllStreamIds', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, streamId: 'stream-a' }));
    b.appendEvent('stream-b', makeEvent({ sequence: 1, streamId: 'stream-b' }));
    b.appendEvent('stream-c', makeEvent({ sequence: 1, streamId: 'stream-c' }));

    const streams = b.listStreams();

    expect(streams).toHaveLength(3);
    expect(streams.sort()).toEqual(['stream-a', 'stream-b', 'stream-c']);
  });

  it('deleteStream_ExistingStream_RemovesAllData', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1 }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2 }));

    b.deleteStream('stream-a');

    const events = b.queryEvents('stream-a');
    expect(events).toHaveLength(0);
  });

  // ─── State Cleanup ─────────────────────────────────────────────────────

  it('deleteState_ExistingState_RemovesEntry', () => {
    const b = setup();

    b.setState('feat-1', makeState({ featureId: 'feat-1' }));
    expect(b.getState('feat-1')).not.toBeNull();

    b.deleteState('feat-1');

    expect(b.getState('feat-1')).toBeNull();
  });

  // ─── Prune Operations ──────────────────────────────────────────────────

  it('pruneEvents_BeforeTimestamp_DeletesOlderEvents', () => {
    const b = setup();

    b.appendEvent('stream-a', makeEvent({ sequence: 1, timestamp: '2025-01-01T00:00:00.000Z' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 2, timestamp: '2025-01-10T00:00:00.000Z' }));
    b.appendEvent('stream-a', makeEvent({ sequence: 3, timestamp: '2025-01-20T00:00:00.000Z' }));

    const pruned = b.pruneEvents('stream-a', '2025-01-15T00:00:00.000Z');

    expect(pruned).toBe(2);

    const remaining = b.queryEvents('stream-a');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sequence).toBe(3);
  });

  // ─── View Cache Operations ─────────────────────────────────────────────

  it('setViewCache_NewEntry_StoresCorrectly', () => {
    const b = setup();
    const viewState = { count: 42, items: ['a', 'b'] };

    b.setViewCache('stream-a', 'summary-view', viewState, 10);

    const entry = b.getViewCache('stream-a', 'summary-view');
    expect(entry).not.toBeNull();
    expect(entry!.state).toEqual(viewState);
    expect(entry!.highWaterMark).toBe(10);
  });

  it('getViewCache_NonExistent_ReturnsNull', () => {
    const b = setup();

    const entry = b.getViewCache('stream-a', 'nonexistent-view');

    expect(entry).toBeNull();
  });

  it('getViewCache_AfterSet_ReturnsStoredEntry', () => {
    const b = setup();
    const viewState1 = { version: 1 };
    const viewState2 = { version: 2, extra: 'data' };

    b.setViewCache('stream-a', 'my-view', viewState1, 5);
    b.setViewCache('stream-a', 'my-view', viewState2, 15);

    const entry = b.getViewCache('stream-a', 'my-view');
    expect(entry).not.toBeNull();
    expect(entry!.state).toEqual(viewState2);
    expect(entry!.highWaterMark).toBe(15);
  });
});

// ─── Backend-Specific Divergence Tests ──────────────────────────────────────

describe('SqliteBackend outbox retry behavior', () => {
  let backend: SqliteBackend;
  let dir: string;

  afterEach(() => {
    backend.close();
    rmSync(dir, { recursive: true });
  });

  /**
   * SqliteBackend retries failed outbox sends with exponential backoff.
   *
   * When a send fails, the SqliteBackend keeps the outbox entry in the database
   * with status='pending' and increments the `attempts` count. The entry remains
   * available for future drain calls until it exceeds MAX_OUTBOX_RETRIES (5),
   * at which point it is moved to 'dead-letter' status.
   *
   * This contrasts with InMemoryBackend which uses `splice` to remove items
   * from the outbox array before sending, so failed items are permanently lost.
   */
  it('drainOutbox_FailedSend_SqliteBackendRetriesWithBackoff', async () => {
    dir = mkdtempSync(join(tmpdir(), 'contract-sqlite-retry-'));
    backend = new SqliteBackend(join(dir, 'test.db'));
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    // First drain: send fails
    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    // The entry should still be in the outbox with status 'pending' and attempts=1
    // Verify by attempting another drain — the item should still be available
    const result2 = await backend.drainOutbox('stream-a', failingSender);
    expect(result2.sent).toBe(0);
    expect(result2.failed).toBe(1);

    // A successful sender should now pick up the entry
    const successSender = makeSender();
    const result3 = await backend.drainOutbox('stream-a', successSender);
    expect(result3.sent).toBe(1);
    expect(result3.failed).toBe(0);

    // After successful send, outbox should be drained
    const result4 = await backend.drainOutbox('stream-a', successSender);
    expect(result4.sent).toBe(0);
    expect(result4.failed).toBe(0);
  });
});

describe('InMemoryBackend outbox retry behavior', () => {
  /**
   * After the v2.9 outbox-drain fix, InMemoryBackend keeps failed entries
   * in the queue (slice + remove-on-success) so a subsequent drain with a
   * working sender can pick them up. This matches SqliteBackend's
   * keep-on-failure semantics — fewer surprises when production code is
   * exercised against the test double.
   *
   * SqliteBackend additionally tracks attempt counts and schedules
   * exponential backoff before dead-lettering. InMemoryBackend skips
   * those bookkeeping fields (its only consumer is unit tests), but the
   * core invariant — "failed sends do not vanish" — now holds for both.
   */
  it('drainOutbox_FailedSend_InMemoryBackendKeepsItemForRetry', async () => {
    const backend = new InMemoryBackend();
    backend.initialize();

    const event = makeEvent();
    backend.addOutboxEntry('stream-a', event);

    const failingSender = makeFailingSender();

    // First drain: send fails, item must remain in the queue.
    const result1 = await backend.drainOutbox('stream-a', failingSender);
    expect(result1.sent).toBe(0);
    expect(result1.failed).toBe(1);

    // A working sender on the next drain picks up the still-pending entry.
    const successSender = makeSender();
    const result2 = await backend.drainOutbox('stream-a', successSender);
    expect(result2.sent).toBe(1);
    expect(result2.failed).toBe(0);
  });
});
