import { EventStore } from '../event-store/store.js';
import { TELEMETRY_STREAM } from './constants.js';

// ─── Types ──────────────────────────────────────────────────────────────────

interface McpToolContent {
  readonly type: string;
  readonly text: string;
}

interface McpToolResult {
  content: McpToolContent[];
  isError: boolean;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

// ─── Perf Injection ─────────────────────────────────────────────────────────

interface PerfMetrics {
  readonly ms: number;
  readonly bytes: number;
  readonly tokens: number;
}

/** Injects `_perf` into the JSON payload of the first content entry. Fails silently if text is not valid JSON. */
function injectPerf(result: McpToolResult, perf: PerfMetrics): McpToolResult {
  const entry = result.content[0];
  if (!entry?.text) return result;

  try {
    const parsed = JSON.parse(entry.text) as Record<string, unknown>;
    parsed._perf = perf;
    return {
      ...result,
      content: [{ ...entry, text: JSON.stringify(parsed) }, ...result.content.slice(1)],
    };
  } catch {
    // Not valid JSON — return unchanged
    return result;
  }
}

// ─── withTelemetry HOF ──────────────────────────────────────────────────────

/**
 * Wraps an MCP tool handler with telemetry instrumentation.
 *
 * Emits `tool.invoked` before execution, `tool.completed` after success (with
 * duration, response size, and token estimate), or `tool.errored` on failure.
 *
 * Telemetry failures are swallowed — they never break the underlying handler.
 */
export function withTelemetry(
  handler: ToolHandler,
  toolName: string,
  eventStore: EventStore,
): ToolHandler {
  return async (args) => {
    // Emit invoked (fire-and-forget, swallow failures)
    const invokePromise = eventStore
      .append(TELEMETRY_STREAM, {
        type: 'tool.invoked',
        data: { tool: toolName },
      })
      .catch(() => {});

    const start = performance.now();

    try {
      const result = await handler(args);
      const durationMs = Math.round(performance.now() - start);
      const responseText = result.content[0]?.text ?? '';
      const responseBytes = Buffer.byteLength(responseText, 'utf-8');
      const tokenEstimate = Math.ceil(responseBytes / 4);

      // Wait for invoke event to settle before emitting completed
      await invokePromise;

      // Emit completed (swallow failures)
      await eventStore
        .append(TELEMETRY_STREAM, {
          type: 'tool.completed',
          data: { tool: toolName, durationMs, responseBytes, tokenEstimate },
        })
        .catch(() => {});

      return injectPerf(result, { ms: durationMs, bytes: responseBytes, tokens: tokenEstimate });
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);

      // Wait for invoke event to settle before emitting errored
      await invokePromise;

      // Emit errored (swallow failures)
      await eventStore
        .append(TELEMETRY_STREAM, {
          type: 'tool.errored',
          data: {
            tool: toolName,
            durationMs,
            errorCode: error instanceof Error ? error.message : String(error),
          },
        })
        .catch(() => {});

      throw error;
    }
  };
}

// ─── Instrumented Registrar ─────────────────────────────────────────────────

interface McpServer {
  tool: (...args: unknown[]) => void;
}

/**
 * Creates a registration function that transparently wraps MCP tool handlers
 * with telemetry instrumentation before delegating to `server.tool()`.
 */
export function createInstrumentedRegistrar(
  server: McpServer,
  eventStore: EventStore,
) {
  return (name: string, description: string, schema: unknown, handler: ToolHandler) => {
    server.tool(name, description, schema, withTelemetry(handler, name, eventStore));
  };
}
