// Source: docs/designs/archive/2026-05-05-e2e-v29-revisited.md §4.2
import type { SpawnedMcpClient } from './mcp-client.js';
import { normalize } from './normalizers.js';

/**
 * Shape of a single event row as returned by `exarchos_event` action `query`
 * after `normalize()` canonicalizes timestamps, sequences, and identifiers.
 *
 * The pre-verified facts in T2's prompt named `exarchos_view event_log` as the
 * snapshot source. That action does not exist in v2.9 — the canonical event
 * log lives behind `exarchos_event { action: 'query', stream }` (composite
 * handler `handleEventQuery` in `servers/exarchos-mcp/src/event-store/tools.ts`).
 * The on-the-wire row is the persisted `WorkflowEvent` shape:
 *   { streamId, sequence, timestamp, type, data?, ... }
 *
 * Post-normalize, `timestamp` becomes `<TIMESTAMP>` and `sequence` becomes
 * `<SEQ>`, so deep-equality comparison is stable across runs.
 */
export type NormalizedEvent = Record<string, unknown>;

/**
 * Frozen view of an event stream at a single point in time. Returned by
 * `snapshotEventStream`; the input to `replayInto`.
 *
 * `featureId` here doubles as the `stream` identifier — the v2.9 conventions
 * use the workflow `featureId` as the stream id when no explicit stream is
 * supplied. See `handleInit` and `handleEventAppend` for the convention.
 */
export interface EventSnapshot {
  readonly featureId: string;
  readonly events: ReadonlyArray<NormalizedEvent>;
}

interface MaybeContent {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface ToolResultEnvelope {
  success?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

/**
 * DR-5 (economy-by-default) reshaped `exarchos_event { action: 'query' }`:
 * `data` is no longer a bare `events[]` array. It is now
 * `{ events, page }` where `events` is ordered **newest-first** (descending by
 * sequence) and defaults to the newest `page.limit` rows only. Replay fixtures
 * need the *entire* stream in ascending (chronological) order, so this helper
 * pages through every window (below) and reverses back to ascending.
 */
interface EventQueryPageShape {
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}
interface EventQueryData {
  events: unknown[];
  page: EventQueryPageShape;
}
function isEventQueryData(d: unknown): d is EventQueryData {
  if (typeof d !== 'object' || d === null) return false;
  const o = d as Record<string, unknown>;
  if (!Array.isArray(o.events)) return false;
  const p = o.page as Record<string, unknown> | undefined;
  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.total === 'number' &&
    typeof p.offset === 'number' &&
    typeof p.limit === 'number' &&
    typeof p.hasMore === 'boolean'
  );
}

// A page size comfortably larger than any saga fixture stream, so the common
// case is a single round-trip while still paginating correctly if a fixture
// ever grows past it.
const REPLAY_QUERY_PAGE_LIMIT = 500;

/**
 * Parse the MCP `callTool` response envelope into the inner `ToolResult` that
 * exarchos handlers return. The MCP wire format is
 * `{ content: [{ type: 'text', text: JSON.stringify(toolResult) }] }`
 * (see `servers/exarchos-mcp/src/format.ts:formatResult`). This helper hides
 * that double-encoding from the saga primitives.
 */
function unwrapToolResult(raw: unknown): ToolResultEnvelope {
  const r = raw as MaybeContent;
  if (!r || !Array.isArray(r.content)) {
    throw new Error(
      `unwrapToolResult: unexpected MCP response shape: ${JSON.stringify(raw)}`,
    );
  }
  const first = r.content[0];
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error(
      `unwrapToolResult: first content block is not text: ${JSON.stringify(first)}`,
    );
  }
  try {
    return JSON.parse(first.text) as ToolResultEnvelope;
  } catch (err) {
    throw new Error(
      `unwrapToolResult: failed to parse content text as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Capture the current event stream for `featureId` from the connected MCP
 * server, normalize it, and return a frozen `EventSnapshot`.
 *
 * Implementation note (deviation from prompt's pre-verified facts):
 *   The prompt instructed `exarchos_view { action: 'event_log', featureId }`.
 *   That action does not exist; the canonical event log is reached via
 *   `exarchos_event { action: 'query', stream }`. We bridge here so the
 *   primitive's contract still says "snapshot the event log for a feature".
 */
export async function snapshotEventStream(
  client: SpawnedMcpClient,
  featureId: string,
): Promise<EventSnapshot> {
  // Page through the whole stream. `handleEventQuery` returns `{ events, page }`
  // (DR-5) with `events` newest-first; accumulating pages yields a newest-first
  // list that we reverse to ascending (chronological) order below.
  const descending: unknown[] = [];
  let offset = 0;
  for (;;) {
    const raw = await client.client.callTool({
      name: 'exarchos_event',
      arguments: {
        action: 'query',
        stream: featureId,
        offset,
        limit: REPLAY_QUERY_PAGE_LIMIT,
      },
    });
    const envelope = unwrapToolResult(raw);

    if (envelope.success === false) {
      // A query for a stream that has never been written returns an empty
      // page, not an error — so any error here is a real failure to surface.
      throw new Error(
        `snapshotEventStream: event query for '${featureId}' failed: ${
          envelope.error?.message ?? 'unknown error'
        }`,
      );
    }

    const data = envelope.data;
    // A fresh feature returns `{ events: [], page: {...} }`. Anything that is
    // not the DR-5 `{ events, page }` envelope (undefined, bare array, string)
    // is a contract regression on the wire format and must throw, otherwise
    // replay-fixture consumers would conflate "broken response" with
    // "genuinely empty stream" and silently mask test failures.
    if (!isEventQueryData(data)) {
      throw new Error(
        `snapshotEventStream: event query for '${featureId}' returned non-{events,page} data; got ${typeof data} (${JSON.stringify(data)?.slice(0, 80) ?? 'undefined'})`,
      );
    }

    descending.push(...data.events);

    // Advance by the number of rows actually returned. Stop when the page
    // reports no more matches (or, defensively, when a page returns nothing).
    if (!data.page.hasMore || data.events.length === 0) break;
    offset += data.events.length;
  }

  // Reverse newest-first → ascending (chronological) so replay applies events
  // in the order they were originally written and prefix comparisons hold.
  const ascending = descending.reverse() as NormalizedEvent[];

  // Normalize at the boundary so callers can assert structural equality
  // without snapshotting transient values (timestamps, sequences, UUIDs).
  const normalizedEvents = ascending.map(
    (e) => normalize(e) as NormalizedEvent,
  );

  return { featureId, events: normalizedEvents };
}

/**
 * Replay the events in `snapshot` into `client`'s MCP server, which is
 * assumed to be hooked up to a fresh state directory (or at least one whose
 * `snapshot.featureId` stream is empty or already a prefix of `snapshot`).
 *
 * Idempotence:
 *   - Pre-fetches the target's existing event count for `snapshot.featureId`
 *     and skips that many events from the head of the snapshot. So a second
 *     `replayInto` with the same snapshot is a no-op.
 *   - The server-side `idempotencyKey` mechanism is not relied on for skip
 *     semantics because re-issuing an `event append` for an existing
 *     idempotencyKey returns the original ack rather than throwing — but
 *     skipping client-side avoids any chance of re-emitting hooks/channels.
 *
 * Synchronous-on-append assumption:
 *   - `handleEventAppend` writes through the `EventStore` synchronously in
 *     the request lifetime, so once a `callTool` resolves the projection is
 *     readable. No post-replay polling against a `rehydrate` view is needed
 *     for the F6.1 reconstructability assertion P3 will build on top.
 */
export async function replayInto(
  client: SpawnedMcpClient,
  snapshot: EventSnapshot,
): Promise<void> {
  // Idempotence: how many events does the target already have?
  const existing = await snapshotEventStream(client, snapshot.featureId);
  const skip = existing.events.length;

  // Verify the target's existing events are actually a prefix of the
  // snapshot before short-circuiting. Comparing only counts would let a
  // target that has `n` *different* events either silently no-op (when
  // `n >= snapshot.events.length`) or append onto the wrong history (when
  // `n < snapshot.events.length`). Fail fast on mismatch — replay onto a
  // divergent target is a programming error in the test, not a recoverable
  // state.
  if (skip > 0) {
    const expectedPrefix = snapshot.events.slice(0, skip);
    if (JSON.stringify(existing.events) !== JSON.stringify(expectedPrefix)) {
      throw new Error(
        `replayInto: target stream '${snapshot.featureId}' is not a prefix of the snapshot ` +
          `(target has ${skip} events, snapshot has ${snapshot.events.length}); ` +
          `aborting before divergent append.`,
      );
    }
  }

  if (skip >= snapshot.events.length) {
    return; // nothing to do — target is already a full prefix
  }

  for (let i = skip; i < snapshot.events.length; i++) {
    const ev = snapshot.events[i] as Record<string, unknown>;
    const type = ev.type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(
        `replayInto: snapshot event at index ${i} has no string 'type' field`,
      );
    }

    // Build the event body for `event append`. We deliberately drop fields
    // the server controls (streamId, sequence, timestamp) — those are
    // assigned by the target server on append. We forward the semantic
    // fields the schema accepts.
    const body: Record<string, unknown> = { type };
    if (ev.data !== undefined) body.data = ev.data;
    if (typeof ev.correlationId === 'string') body.correlationId = ev.correlationId;
    if (typeof ev.causationId === 'string') body.causationId = ev.causationId;
    if (typeof ev.agentId === 'string') body.agentId = ev.agentId;
    if (typeof ev.agentRole === 'string') body.agentRole = ev.agentRole;
    if (typeof ev.tenantId === 'string') body.tenantId = ev.tenantId;
    if (typeof ev.organizationId === 'string') body.organizationId = ev.organizationId;
    if (typeof ev.source === 'string') body.source = ev.source;

    // Forward idempotencyKey as a top-level append arg (not inside event)
    // when the source event recorded one. This preserves the server's
    // duplicate-suppression semantics (so an auto-emitted `workflow.started`
    // re-appears identically post-replay rather than producing a divergent
    // row).
    const appendArgs: Record<string, unknown> = {
      action: 'append',
      stream: snapshot.featureId,
      event: body,
    };
    if (typeof ev.idempotencyKey === 'string') {
      appendArgs.idempotencyKey = ev.idempotencyKey;
    }

    const raw = await client.client.callTool({
      name: 'exarchos_event',
      arguments: appendArgs,
    });
    const envelope = unwrapToolResult(raw);
    if (envelope.success === false) {
      // Surface the error with the offending event index for debuggability.
      throw new Error(
        `replayInto: append failed at snapshot index ${i} (type='${type}'): ${
          envelope.error?.code ?? 'UNKNOWN'
        } ${envelope.error?.message ?? ''}`,
      );
    }
  }
}
