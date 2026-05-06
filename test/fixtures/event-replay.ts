// Source: docs/designs/2026-05-05-e2e-v29-revisited.md §4.2
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
  const raw = await client.client.callTool({
    name: 'exarchos_event',
    arguments: { action: 'query', stream: featureId },
  });
  const envelope = unwrapToolResult(raw);

  if (envelope.success === false) {
    // A query for a stream that has never been written returns an empty array,
    // not an error — so any error here is a real failure to surface.
    throw new Error(
      `snapshotEventStream: event query for '${featureId}' failed: ${
        envelope.error?.message ?? 'unknown error'
      }`,
    );
  }

  const data = envelope.data;
  // `handleEventQuery` returns `data: events[]`. Treat unset / non-array as
  // empty so a fresh feature returns an empty snapshot rather than throwing.
  const events: NormalizedEvent[] = Array.isArray(data)
    ? (data as NormalizedEvent[])
    : [];

  // Normalize at the boundary so callers can assert structural equality
  // without snapshotting transient values (timestamps, sequences, UUIDs).
  const normalizedEvents = events.map(
    (e) => normalize(e) as NormalizedEvent,
  );

  return { featureId, events: normalizedEvents };
}
