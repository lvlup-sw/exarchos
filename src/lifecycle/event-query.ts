/**
 * The streaming loop for `exarchos event query --follow`. The CLI adapter parses the flag and calls
 * this module. The MCP tool uses the one-shot query path.
 *
 * The loop reads an `AsyncIterable<WorkflowEvent>`, so tests can drive it with no real
 * `EventStore`. {@link pollingEventSource} turns the one-shot `EventStore.query` into that iterable
 * with a `sinceSequence` cursor.
 */
import type { Writable } from 'node:stream';
import type { WorkflowEvent } from '../events/schemas.js';
import type { EventStore } from '../events/store.js';
import { NdjsonEncoder } from '../ndjson/encoder.js';
import { startHeartbeat } from '../ndjson/heartbeat.js';
import type { Frame } from '../ndjson/frames.js';

export interface RunEventQueryFollowOptions {
  /** Async source of events to forward as `event` frames. */
  readonly source: AsyncIterable<WorkflowEvent>;
  /** Writable sink that receives NDJSON lines. Closed on completion. */
  readonly sink: Writable;
  /**
   * The idle heartbeat interval in milliseconds. The default is 30000, so HTTP and WebSocket
   * intermediaries do not close an idle stream.
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
 * Turns `EventStore.query` into a polled `AsyncIterable<WorkflowEvent>`. Each poll reads the events
 * after the cursor, and the cursor moves forward as the iterator yields events.
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

/** A promise-based sleep that resolves early on abort. */
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
