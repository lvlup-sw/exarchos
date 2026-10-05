/**
 * Helpers that copy an event stream from one MCP server to a second one.
 * `snapshotEventStream` reads a stream, and `replayInto` appends it to a target server.
 */
import type { SpawnedMcpClient } from './mcp-client.js';
import { normalize } from './normalizers.js';

/**
 * One event row from `exarchos_event` action `query`, after `normalize()`.
 * The row has the persisted `WorkflowEvent` shape. `normalize()` replaces `timestamp`
 * with `<TIMESTAMP>` and `sequence` with `<SEQ>`, so deep equality is stable across runs.
 */
export type NormalizedEvent = Record<string, unknown>;

/**
 * An event stream at one point in time. `snapshotEventStream` returns it, and
 * `replayInto` reads it. `featureId` is also the stream id.
 */
export interface EventSnapshot {
  readonly featureId: string;
  readonly events: ReadonlyArray<NormalizedEvent>;
  /**
   * The same rows in ascending order, without normalization. Replay must use these rows.
   * `normalize()` replaces payload values, such as a `data.phaseAttemptId` UUID, with
   * placeholders. The server rejects a placeholder in schema-validated event data.
   * The normalized `events` are only for comparison across runs.
   */
  readonly raw: ReadonlyArray<Record<string, unknown>>;
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
 * The `page` of an `exarchos_event` `query` result. The result `data` is
 * `{ events, page }`. `events` is newest-first and holds at most `page.limit` rows.
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

/**
 * A page size larger than each saga fixture stream, so the usual read is one query.
 * A longer stream takes more queries.
 */
const REPLAY_QUERY_PAGE_LIMIT = 500;

/**
 * Parses the MCP `callTool` response into the `ToolResult` that an Exarchos handler returns.
 * The wire format is `{ content: [{ type: 'text', text: JSON.stringify(toolResult) }] }`.
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
 * Reads the whole event stream for `featureId` from the connected MCP server.
 * The query returns rows newest-first, one page at a time. The function reads each
 * page and returns the rows in ascending order, both raw and normalized.
 *
 * A query for a stream with no events returns an empty page, not an error.
 * Thus the function throws on a failed query and on `data` that is not `{ events, page }`.
 * Without the throw, a broken response reads as an empty stream and hides a test failure.
 */
export async function snapshotEventStream(
  client: SpawnedMcpClient,
  featureId: string,
): Promise<EventSnapshot> {
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
      throw new Error(
        `snapshotEventStream: event query for '${featureId}' failed: ${
          envelope.error?.message ?? 'unknown error'
        }`,
      );
    }

    const data = envelope.data;
    if (!isEventQueryData(data)) {
      throw new Error(
        `snapshotEventStream: event query for '${featureId}' returned non-{events,page} data; got ${typeof data} (${JSON.stringify(data)?.slice(0, 80) ?? 'undefined'})`,
      );
    }

    descending.push(...data.events);

    if (!data.page.hasMore || data.events.length === 0) break;
    offset += data.events.length;
  }

  const ascending = descending.reverse() as Record<string, unknown>[];

  const normalizedEvents = ascending.map(
    (e) => normalize(e) as NormalizedEvent,
  );

  return { featureId, events: normalizedEvents, raw: ascending };
}

/**
 * Appends the events of `snapshot` to the server of `client`. The target stream must be
 * empty or a prefix of the snapshot. The function compares the target events with that
 * prefix and throws on a mismatch, because equal counts do not prove equal history.
 * It skips the events that the target already holds, so a repeated call appends nothing.
 *
 * It appends the raw rows, because a normalized row holds placeholders such as `<UUID>`.
 * Before the first append, it throws if `raw` is absent or its length differs from `events`.
 * The append omits `streamId`, `sequence` and `timestamp`, so the target server assigns them.
 * A recorded `idempotencyKey` goes to `append` as a top-level argument, because the server
 * reads it only there. The server stores each event before `append` returns, so no poll is
 * necessary after the call.
 */
export async function replayInto(
  client: SpawnedMcpClient,
  snapshot: EventSnapshot,
): Promise<void> {
  const existing = await snapshotEventStream(client, snapshot.featureId);
  const skip = existing.events.length;

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
    return;
  }

  if (!Array.isArray(snapshot.raw) || snapshot.raw.length !== snapshot.events.length) {
    throw new Error(
      `replayInto: snapshot for '${snapshot.featureId}' carries no raw rows ` +
        `(raw=${snapshot.raw?.length ?? 'absent'}, events=${snapshot.events.length}); ` +
        `rebuild it with snapshotEventStream — normalized rows are not replayable.`,
    );
  }

  for (let i = skip; i < snapshot.raw.length; i++) {
    const ev = snapshot.raw[i] as Record<string, unknown>;
    const type = ev.type;
    if (typeof type !== 'string' || type.length === 0) {
      throw new Error(
        `replayInto: snapshot event at index ${i} has no string 'type' field`,
      );
    }

    const body: Record<string, unknown> = { type };
    if (ev.data !== undefined) body.data = ev.data;
    if (typeof ev.correlationId === 'string') body.correlationId = ev.correlationId;
    if (typeof ev.causationId === 'string') body.causationId = ev.causationId;
    if (typeof ev.agentId === 'string') body.agentId = ev.agentId;
    if (typeof ev.agentRole === 'string') body.agentRole = ev.agentRole;
    if (typeof ev.tenantId === 'string') body.tenantId = ev.tenantId;
    if (typeof ev.organizationId === 'string') body.organizationId = ev.organizationId;
    if (typeof ev.source === 'string') body.source = ev.source;

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
      throw new Error(
        `replayInto: append failed at snapshot index ${i} (type='${type}'): ${
          envelope.error?.code ?? 'UNKNOWN'
        } ${envelope.error?.message ?? ''}`,
      );
    }
  }
}
