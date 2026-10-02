/**
 * Tests the `feedback` handler: the local write, the optional upstream POST, the idempotency window
 * and input validation. One test sends `feedback` through `handleWorkflow` and checks the envelope.
 * `feedback.parity.test.ts` pins CLI and MCP parity.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../src/events/store.js';
import { FeedbackRecordedData } from '../../../src/events/schemas.js';
import {
  handleFeedback,
  FEEDBACK_STREAM_ID,
  FEEDBACK_IDEMPOTENCY_WINDOW_MS,
  type FeedbackOptions,
  type FeedbackUpstreamPayload,
} from '../../../src/workflow/feedback.js';
import { handleWorkflow } from '../../../src/workflow/composite.js';
import type { DispatchContext } from '../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let stateDir: string;
let store: EventStore;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-feedback-'));
  store = new EventStore(stateDir);
});

afterEach(async () => {
  await rmrfAsync(stateDir);
});

/**
 * Options that touch no config file and no network. `resolveUpstream` returns no endpoint, and
 * `now` is fixed, so the idempotency bucket is deterministic.
 */
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
  /** The event must land on the shared meta stream, not a feature stream, and match its schema. */
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

    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('feedback.recorded');
    expect(events[0].data).toMatchObject({
      message: 'rehydrate dropped taskProgress when projection lagged',
      configuredEndpoint: null,
      upstreamDelivered: false,
    });
    expect(() => FeedbackRecordedData.parse(events[0].data)).not.toThrow();
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
    expect((event.data as { sessionContext?: unknown }).sessionContext).toEqual({
      action: 'check_static_analysis',
      errorCode: 'GATE_FAILED',
      workflow: 'v2-11-0-rc1-build',
    });
  });

  it('Feedback_NoSessionContext_OmitsKeyEntirely', async () => {
    await handleFeedback({ message: 'plain report' }, stateDir, store, localOnlyOptions());
    const [event] = await store.query(FEEDBACK_STREAM_ID);
    expect(Object.prototype.hasOwnProperty.call(event.data as object, 'sessionContext')).toBe(false);
  });
});

describe('handleFeedback — input validation (M-A discipline)', () => {
  /** The error must carry a structured `suggestedFix`, and the handler must write no event. */
  it('Feedback_EmptyMessage_ReturnsStructuredInvalidInput', async () => {
    const result = await handleFeedback({ message: '' }, stateDir, store, localOnlyOptions());
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
    expect(result.error?.suggestedFix).toEqual({
      tool: 'exarchos_workflow',
      params: { action: 'feedback', message: '<your report>' },
    });
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
    expect(posted[0].url).toBe('https://example.test/feedback');
    expect(posted[0].payload).toEqual({ message: 'federated report', sessionContext: { action: 'feedback' } });

    const data = result.data as { upstreamConfigured: boolean; configuredEndpoint: string | null; upstreamDelivered: boolean };
    expect(data.upstreamConfigured).toBe(true);
    expect(data.configuredEndpoint).toBe('https://example.test/feedback');
    expect(data.upstreamDelivered).toBe(true);

    const [event] = await store.query(FEEDBACK_STREAM_ID);
    expect(event.data).toMatchObject({
      configuredEndpoint: 'https://example.test/feedback',
      upstreamDelivered: true,
    });
  });

  /**
   * `postUpstream` returns `false` to act as a failed POST. The local write is the primary effect,
   * so it must succeed when the POST fails.
   */
  it('Feedback_UpstreamFails_StillRecordsLocallyAsUndelivered', async () => {
    const result = await handleFeedback(
      { message: 'report while endpoint is down' },
      stateDir,
      store,
      {
        now: () => 1_000_000_000_000,
        resolveUpstream: () => 'https://down.test/feedback',
        postUpstream: async () => false,
      },
    );

    expect(result.success).toBe(true);
    const events = await store.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({
      configuredEndpoint: 'https://down.test/feedback',
      upstreamDelivered: false,
    });
  });
});

describe('handleFeedback — windowed idempotency (no log spam)', () => {
  /** The same idempotency key within the window returns the first event, so the stream holds one row. */
  it('Feedback_DuplicateWithinWindow_CollapsesToOneEvent', async () => {
    const opts = localOnlyOptions({ now: () => 5_000_000 });
    const first = await handleFeedback({ message: 'same painful affordance' }, stateDir, store, opts);
    const second = await handleFeedback({ message: 'same painful affordance' }, stateDir, store, opts);

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

  /** The second call is past the idempotency window, so its bucket changes. */
  it('Feedback_SameMessageDifferentWindow_RecordsSeparateEvents', async () => {
    const base = 5_000_000;
    await handleFeedback({ message: 'recurring friction' }, stateDir, store, localOnlyOptions({ now: () => base }));
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

  /**
   * The envelope must carry `next_actions`, and the event must reach the meta stream through the
   * real dispatch path.
   */
  it('Feedback_ThroughComposite_ReturnsEnvelopeWithNextActions', async () => {
    const ctx = makeCtx(stateDir);
    const result = await handleWorkflow(
      { action: 'feedback', message: 'dispatched via the composite' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(Array.isArray(result.next_actions)).toBe(true);
    expect((result.data as { recorded: boolean }).recorded).toBe(true);

    const events = await ctx.eventStore.query(FEEDBACK_STREAM_ID);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('feedback.recorded');
  });

  /** The list of valid actions in the error must include `feedback`. */
  it('Feedback_UnknownAction_StillRejectsWithValidActions', async () => {
    const ctx = makeCtx(stateDir);
    const result = await handleWorkflow({ action: 'nonsense' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNKNOWN_ACTION');
    expect(result.error?.validActions).toContain('feedback');
  });
});
