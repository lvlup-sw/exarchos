import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { FeedbackRecordedData } from '../event-store/schemas.js';
import {
  handleFeedback,
  FEEDBACK_STREAM_ID,
  FEEDBACK_IDEMPOTENCY_WINDOW_MS,
  type FeedbackOptions,
  type FeedbackUpstreamPayload,
} from './feedback.js';
import { handleWorkflow } from './composite.js';
import type { DispatchContext } from '../core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

// ─── #1319 — feedback action: agent→runtime friction back-channel ────────────
//
// Verification ladder (high risk + boundary-touching): unit coverage of the
// handler contract (local-only write, optional upstream POST, windowed
// idempotency, input validation) + an integration assertion that the dispatch
// seam (handleWorkflow → handleFeedback) preserves the INV-5b envelope carrier.
// CLI⇄MCP parity (INV-2) is pinned separately in `feedback.parity.test.ts`.

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-feedback-'));
  store = new EventStore(stateDir);
});

afterEach(async () => {
  await rmrfAsync(stateDir);
});

/** Options that never touch the real config file or network — the default for
 *  most cases. `resolveUpstream` returns undefined (no endpoint), `now` is
 *  pinned so the idempotency bucket is deterministic. */
function localOnlyOptions(overrides?: Partial<FeedbackOptions>): FeedbackOptions {
  return {
    now: () => 1_000_000_000_000,
    resolveUpstream: () => undefined,
    postUpstream: async () => {
      throw new Error('postUpstream must not be called when no endpoint is configured');
    },
    ...overrides,
  };
}

describe('handleFeedback — local write contract', () => {
  it('Feedback_LocalOnly_RecordsEventOnMetaStream', async () => {
    const result = await handleFeedback(
      { message: 'rehydrate dropped taskProgress when projection lagged' },
      stateDir,
      store,
      localOnlyOptions(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { recorded: boolean; stream: string; upstreamConfigured: boolean; configuredEndpoint: string | null; upstreamDelivered: boolean };
    expect(data.recorded).toBe(true);
    expect(data.stream).toBe(FEEDBACK_STREAM_ID);
    expect(data.upstreamConfigured).toBe(false);
    expect(data.configuredEndpoint).toBeNull();
    expect(data.upstreamDelivered).toBe(false);

    // The durable event landed on the shared meta stream, NOT a feature stream.
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('feedback.recorded');
    expect(events[0]!.data).toMatchObject({
      message: 'rehydrate dropped taskProgress when projection lagged',
      configuredEndpoint: null,
      upstreamDelivered: false,
    });
    // Event payload validates against the registered data schema.
    expect(() => FeedbackRecordedData.parse(events[0]!.data)).not.toThrow();
  });

  it('Feedback_SessionContext_PersistedWhenProvided', async () => {
    await handleFeedback(
      {
        message: 'check_static_analysis ran in the wrong worktree',
        sessionContext: { action: 'check_static_analysis', errorCode: 'GATE_FAILED', workflow: 'v2-11-0-rc1-build' },
      },
      stateDir,
      store,
      localOnlyOptions(),
    );

    const [event] = await store.query(FEEDBACK_STREAM_ID);
    expect((event!.data as { sessionContext?: unknown }).sessionContext).toEqual({
      action: 'check_static_analysis',
      errorCode: 'GATE_FAILED',
      workflow: 'v2-11-0-rc1-build',
    });
  });

  it('Feedback_NoSessionContext_OmitsKeyEntirely', async () => {
    await handleFeedback({ message: 'plain report' }, stateDir, store, localOnlyOptions());
    const [event] = await store.query(FEEDBACK_STREAM_ID);
    expect(Object.prototype.hasOwnProperty.call(event!.data as object, 'sessionContext')).toBe(false);
  });
});

describe('handleFeedback — input validation (M-A discipline)', () => {
  it('Feedback_EmptyMessage_ReturnsStructuredInvalidInput', async () => {
    const result = await handleFeedback({ message: '' }, stateDir, store, localOnlyOptions());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    // Structured retry affordance, not just a message string.
    expect(result.error?.suggestedFix).toEqual({
      tool: 'exarchos_workflow',
      params: { action: 'feedback', message: '<your report>' },
    });
    // No event written on rejection.
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(0);
  });

  it('Feedback_MissingMessage_ReturnsInvalidInput', async () => {
    const result = await handleFeedback({}, stateDir, store, localOnlyOptions());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });
});

describe('handleFeedback — optional upstream POST (offline-first / INV-15)', () => {
  it('Feedback_UpstreamConfigured_PostsAndRecordsDelivered', async () => {
    const posted: Array<{ url: string; payload: FeedbackUpstreamPayload }> = [];
    const result = await handleFeedback(
      { message: 'federated report', sessionContext: { action: 'feedback' } },
      stateDir,
      store,
      {
        now: () => 1_000_000_000_000,
        resolveUpstream: () => 'https://example.test/feedback',
        postUpstream: async (url, payload) => {
          posted.push({ url, payload });
          return true;
        },
      },
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://example.test/feedback');
    expect(posted[0]!.payload).toEqual({ message: 'federated report', sessionContext: { action: 'feedback' } });

    const data = result.data as { upstreamConfigured: boolean; configuredEndpoint: string | null; upstreamDelivered: boolean };
    expect(data.upstreamConfigured).toBe(true);
    expect(data.configuredEndpoint).toBe('https://example.test/feedback');
    expect(data.upstreamDelivered).toBe(true);

    const [event] = await store.query(FEEDBACK_STREAM_ID);
    expect(event!.data).toMatchObject({
      configuredEndpoint: 'https://example.test/feedback',
      upstreamDelivered: true,
    });
  });

  it('Feedback_UpstreamFails_StillRecordsLocallyAsUndelivered', async () => {
    const result = await handleFeedback(
      { message: 'report while endpoint is down' },
      stateDir,
      store,
      {
        now: () => 1_000_000_000_000,
        resolveUpstream: () => 'https://down.test/feedback',
        // Simulates a network failure swallowed into `false`.
        postUpstream: async () => false,
      },
    );

    // The local write is the primary effect — it MUST succeed even when the
    // upstream POST does not (offline-first).
    expect(result.success).toBe(true);
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      configuredEndpoint: 'https://down.test/feedback',
      upstreamDelivered: false,
    });
  });
});

describe('handleFeedback — windowed idempotency (no log spam)', () => {
  it('Feedback_DuplicateWithinWindow_CollapsesToOneEvent', async () => {
    const opts = localOnlyOptions({ now: () => 5_000_000 });
    const first = await handleFeedback({ message: 'same painful affordance' }, stateDir, store, opts);
    const second = await handleFeedback({ message: 'same painful affordance' }, stateDir, store, opts);

    // Same windowed idempotency key → second append is a cache-hit returning
    // the first event. Only one row in the stream.
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect((first.data as { sequence: number }).sequence).toBe((second.data as { sequence: number }).sequence);
  });

  it('Feedback_DistinctMessages_RecordSeparateEvents', async () => {
    const opts = localOnlyOptions({ now: () => 5_000_000 });
    await handleFeedback({ message: 'friction A' }, stateDir, store, opts);
    await handleFeedback({ message: 'friction B' }, stateDir, store, opts);
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(2);
  });

  it('Feedback_SameMessageDifferentWindow_RecordsSeparateEvents', async () => {
    const base = 5_000_000;
    await handleFeedback({ message: 'recurring friction' }, stateDir, store, localOnlyOptions({ now: () => base }));
    // Advance past the idempotency window so the bucket changes.
    await handleFeedback(
      { message: 'recurring friction' },
      stateDir,
      store,
      localOnlyOptions({ now: () => base + FEEDBACK_IDEMPOTENCY_WINDOW_MS + 1 }),
    );
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(2);
  });
});

describe('feedback dispatch seam — handleWorkflow envelope (INV-5b)', () => {
  function makeCtx(dir: string): DispatchContext {
    return { stateDir: dir, eventStore: new EventStore(dir), enableTelemetry: false };
  }

  it('Feedback_ThroughComposite_ReturnsEnvelopeWithNextActions', async () => {
    const ctx = makeCtx(stateDir);
    const result = await handleWorkflow(
      { action: 'feedback', message: 'dispatched via the composite' },
      ctx,
    );

    expect(result.success).toBe(true);
    // INV-5b: the carrier shape is preserved — `next_actions` is present on
    // every successful composite response (defaults to [] with no workflow ctx).
    expect(Array.isArray(result.next_actions)).toBe(true);
    expect((result.data as { recorded: boolean }).recorded).toBe(true);

    // The event reached the shared meta stream through the real dispatch path.
    const events = await ctx.eventStore.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('feedback.recorded');
  });

  it('Feedback_UnknownAction_StillRejectsWithValidActions', async () => {
    const ctx = makeCtx(stateDir);
    const result = await handleWorkflow({ action: 'nonsense' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');
    // The new action is enumerated in the self-correction list.
    expect(result.error?.validActions).toContain('feedback');
  });
});
