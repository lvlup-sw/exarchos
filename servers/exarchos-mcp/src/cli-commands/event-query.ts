import type { Writable } from 'node:stream';
import type { WorkflowEvent } from '../event-store/schemas.js';
import type { EventStore } from '../event-store/store.js';
import { NdjsonEncoder } from '../ndjson/encoder.js';
import { startHeartbeat } from '../ndjson/heartbeat.js';
import type { Frame } from '../ndjson/frames.js';

// ─── `event query --follow` streaming handler (T042, DR-9) ─────────────────
//
// This module implements the core streaming loop used when a caller passes
// `--follow` to `exarchos event query`. The CLI adapter (see
// `adapters/cli.ts`) parses the flag and delegates here; the MCP tool
// continues to use the one-shot query path in `event-store/tools.ts`.
//
// The handler is intentionally small and framework-free: it accepts an
// `AsyncIterable<WorkflowEvent>` as its event source so tests can drive it
// directly without spinning up a real EventStore. A thin helper
// (`pollingEventSource`) adapts `EventStore.query` into the same iterable
// contract using periodic polling keyed on `sinceSequence`.

// ─── Follow Handler ─────────────────────────────────────────────────────────

export interface RunEventQueryFollowOptions {
  /** Async source of events to forward as `event` frames. */
  readonly source: AsyncIterable<WorkflowEvent>;
  /** Writable sink that receives NDJSON lines. Closed on completion. */
  readonly sink: Writable;
  /**
   * Idle heartbeat interval in ms. Defaults to 30s per DR-9 so HTTP/WS
   * intermediaries don't tear down an idle stream. Tests may shorten or
   * lengthen this to exercise the heartbeat path deterministically.
   */
  readonly heartbeatIntervalMs?: number;
}

/**
 * Drain `source` to `sink` as NDJSON frames, emitting periodic heartbeats
 * while idle. Closes the sink after writing the terminal frame (`end` on
 * graceful completion, `error` if the source throws).
 */
export async function runEventQueryFollow(
  options: RunEventQueryFollowOptions,
): Promise<void> {
  const { source, sink } = options;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;

  const encoder = new NdjsonEncoder(sink);
  const stopHeartbeat = startHeartbeat(encoder, heartbeatIntervalMs);

  try {
    for await (const event of source) {
      const frame: Frame = {
        type: 'event',
        event,
        sequence: event.sequence,
      };
      encoder.write(frame);
    }
    encoder.write({ type: 'end', reason: 'source-closed' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    encoder.write({ type: 'error', code: 'FOLLOW_FAILED', message });
    stopHeartbeat();
    encoder.end();
    throw err;
  }

  stopHeartbeat();
  encoder.end();
}

// ─── Polling Event Source ───────────────────────────────────────────────────
//
// The EventStore exposes a one-shot `query(streamId, filters)` API. For
// `--follow` we convert that into an async iterable by polling at a fixed
// cadence with a `sinceSequence` cursor. This avoids any subscribe/watch
// API surface on EventStore itself (which doesn't exist today) while still
// giving the follow handler a clean `AsyncIterable<WorkflowEvent>` source.

export interface PollingEventSourceOptions {
  readonly store: EventStore;
  readonly streamId: string;
  /**
   * Optional filter applied on top of `sinceSequence`. The `type` filter is
   * forwarded verbatim to `EventStore.query`.
   */
  readonly filter?: { readonly type?: string };
  /** Poll interval in ms. Defaults to 500ms — fast enough to feel real-time. */
  readonly pollIntervalMs?: number;
  /**
   * AbortSignal that terminates the source. When aborted, the iterator
   * completes gracefully (returns `{ done: true }`).
   */
  readonly signal?: AbortSignal;
}

/**
 * Adapt `EventStore.query` into an `AsyncIterable<WorkflowEvent>` driven by
 * polling. Each poll reads events with sequence greater than the cursor
 * seen so far; the cursor advances as events are yielded.
 */
export function pollingEventSource(
  options: PollingEventSourceOptions,
): AsyncIterable<WorkflowEvent> {
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const { store, streamId, filter, signal } = options;

  return {
    [Symbol.asyncIterator](): AsyncIterator<WorkflowEvent> {
      let cursor = 0;
      let pending: WorkflowEvent[] = [];

      async function fill(): Promise<void> {
        while (pending.length === 0) {
          if (signal?.aborted === true) return;
          const batch = await store.query(streamId, {
            sinceSequence: cursor,
            type: filter?.type,
          });
          if (batch.length > 0) {
            pending = batch;
            return;
          }
          await sleep(pollIntervalMs, signal);
        }
      }

      return {
        async next(): Promise<IteratorResult<WorkflowEvent>> {
          if (pending.length === 0) await fill();
          if (pending.length === 0) return { value: undefined, done: true };
          const event = pending.shift()!;
          cursor = Math.max(cursor, event.sequence);
          return { value: event, done: false };
        },
      };
    },
  };
}

/**
 * Promise-based sleep that resolves early on abort. Separated into its own
 * helper so the polling loop reads top-to-bottom without inline timer setup.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
