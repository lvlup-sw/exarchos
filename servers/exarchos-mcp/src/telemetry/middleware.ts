import { EventStore } from '../event-store/store.js';
import type { McpToolResult } from '../format.js';
import { telemetryLogger } from '../logger.js';
import { TELEMETRY_STREAM, TOKEN_GATE_THRESHOLD } from './constants.js';
import type { ToolMetrics } from './telemetry-projection.js';
import { matchCorrection, applyCorrections } from './auto-correction.js';
import type { Correction } from './auto-correction.js';
import { TraceWriter } from './trace-writer.js';

// ─── Singleton TraceWriter ──────────────────────────────────────────────────

const traceWriter = new TraceWriter();

// ─── Types ──────────────────────────────────────────────────────────────────

type ToolHandler = (args: Record<string, unknown>) => Promise<McpToolResult>;

/** Optional configuration for auto-correction behavior in withTelemetry. */
export interface AutoCorrectionOptions {
  /** The action being performed (e.g., 'tasks', 'query', 'get'). */
  readonly action: string;
  /** Returns current metrics for the tool. */
  readonly getMetrics: () => ToolMetrics;
  /** Number of consecutive threshold breaches. */
  readonly consecutiveBreaches: number;
}

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

/** Injects `_autoCorrection` into the JSON payload of the first content entry. Fails silently if text is not valid JSON. */
function injectAutoCorrection(result: McpToolResult, applied: Correction[]): McpToolResult {
  if (applied.length === 0) return result;

  const entry = result.content[0];
  if (!entry?.text) return result;

  try {
    const parsed = JSON.parse(entry.text) as Record<string, unknown>;
    parsed._autoCorrection = { applied };
    return {
      ...result,
      content: [{ ...entry, text: JSON.stringify(parsed) }, ...result.content.slice(1)],
    };
  } catch {
    return result;
  }
}

// ─── Event Hint Injection ──────────────────────────────────────────────────

interface EventHint {
  readonly eventType: string;
  readonly description: string;
}

interface EventHintsPayload {
  readonly missing: readonly EventHint[];
  readonly phase: string;
  readonly checked: number;
}

/** Injects `_eventHints` into the JSON payload of the first content entry. Fails silently if text is not valid JSON. */
function injectEventHints(result: McpToolResult, payload: EventHintsPayload): McpToolResult {
  if (payload.missing.length === 0) return result;

  const entry = result.content[0];
  if (!entry?.text) return result;

  try {
    const parsed = JSON.parse(entry.text) as Record<string, unknown>;
    parsed._eventHints = payload;
    return {
      ...result,
      content: [{ ...entry, text: JSON.stringify(parsed) }, ...result.content.slice(1)],
    };
  } catch {
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
 * When `autoCorrectionOptions` is provided, applies auto-correction rules before
 * calling the handler and injects `_autoCorrection` metadata into the response.
 *
 * Telemetry failures are swallowed — they never break the underlying handler.
 */
export function withTelemetry(
  handler: ToolHandler,
  toolName: string,
  eventStore: EventStore,
  autoCorrectionOptions?: AutoCorrectionOptions,
): ToolHandler {
  return async (args) => {
    // ─── Auto-Correction ───────────────────────────────────────────────
    let correctedArgs = args;
    let appliedCorrections: Correction[] = [];

    if (autoCorrectionOptions) {
      const { action, getMetrics, consecutiveBreaches } = autoCorrectionOptions;
      const metrics = getMetrics();
      const correction = matchCorrection(toolName, action, args, metrics, consecutiveBreaches);
      const corrections = correction ? [correction] : [];
      const result = applyCorrections(args, corrections);
      correctedArgs = result.args;
      appliedCorrections = result.applied;
    }

    // Emit invoked (fire-and-forget, swallow failures)
    const invokePromise = eventStore
      .append(TELEMETRY_STREAM, {
        type: 'tool.invoked',
        data: { tool: toolName },
      })
      .catch(() => { /* telemetry drop — non-fatal, never block workflow */ });

    const start = performance.now();

    try {
      const result = await handler(correctedArgs);
      const durationMs = Math.round(performance.now() - start);
      const responseText = result.content[0]?.text ?? '';
      const responseBytes = Buffer.byteLength(responseText, 'utf-8');
      const tokenEstimate = Math.ceil(responseBytes / 4);

      // Emit D3 gate event when token threshold exceeded (fire-and-forget)
      const featureIdForGate = typeof correctedArgs.featureId === 'string' ? correctedArgs.featureId : undefined;
      if (featureIdForGate && tokenEstimate > TOKEN_GATE_THRESHOLD) {
        eventStore
          .append(featureIdForGate, {
            type: 'gate.executed',
            data: {
              gateName: 'token-budget',
              layer: 'runtime',
              passed: false,
              details: {
                dimension: 'D3',
                phase: 'runtime',
                tokenEstimate,
                responseBytes,
                tool: toolName,
              },
            },
          })
          .catch(() => { /* telemetry drop — non-fatal, never block workflow */ });
      }

      // Wait for invoke event to settle before emitting completed
      await invokePromise;

      // Emit completed (swallow failures)
      await eventStore
        .append(TELEMETRY_STREAM, {
          type: 'tool.completed',
          data: { tool: toolName, durationMs, responseBytes, tokenEstimate },
        })
        .catch(() => { /* telemetry drop — non-fatal, never block workflow */ });

      // Emit quality.hint.generated when auto-correction was applied
      if (appliedCorrections.length > 0) {
        await eventStore
          .append(TELEMETRY_STREAM, {
            type: 'quality.hint.generated',
            data: {
              skill: toolName,
              hintCount: appliedCorrections.length,
              categories: ['auto-correction'],
              generatedAt: new Date().toISOString(),
            },
          })
          .catch((err: unknown) => {
            telemetryLogger.error(
              { err, tool: toolName, hintCount: appliedCorrections.length },
              'Failed to emit quality.hint.generated event',
            );
          });
      }

      let finalResult = injectPerf(result, { ms: durationMs, bytes: responseBytes, tokens: tokenEstimate });
      finalResult = injectAutoCorrection(finalResult, appliedCorrections);

      // ─── Event Emission Hints (bounded wait, non-critical) ────────────
      const featureIdForHints = typeof correctedArgs.featureId === 'string' ? correctedArgs.featureId : undefined;
      if (featureIdForHints) {
        try {
          const HINT_TIMEOUT_MS = 150;
          const hintResult = await Promise.race([
            (async () => {
              const { handleCheckEventEmissions } = await import('../orchestrate/check-event-emissions.js');
              return handleCheckEventEmissions(
                { featureId: featureIdForHints },
                eventStore.dir,
              );
            })(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), HINT_TIMEOUT_MS)),
          ]);
          if (hintResult && hintResult.success && hintResult.data) {
            const data = hintResult.data as { hints?: EventHint[]; phase?: string; checked?: number };
            if (data.hints && data.hints.length > 0) {
              finalResult = injectEventHints(finalResult, {
                missing: data.hints,
                phase: data.phase ?? 'unknown',
                checked: data.checked ?? data.hints.length,
              });
            }
          }
        } catch { /* non-critical — hint generation failure never blocks */ }
      }

      // ─── Trace Capture (swallow failures) ──────────────────────────────
      const action = typeof correctedArgs.action === 'string' ? correctedArgs.action : '';
      const featureId = typeof correctedArgs.featureId === 'string' ? correctedArgs.featureId : 'unknown';
      const sessionId = typeof correctedArgs.sessionId === 'string' ? correctedArgs.sessionId : 'unknown';
      const skillContext = typeof correctedArgs.skillContext === 'string' ? correctedArgs.skillContext : undefined;

      await traceWriter.writeTrace({
        toolName,
        action,
        input: correctedArgs,
        output: responseText,
        durationMs,
        timestamp: new Date().toISOString(),
        featureId,
        sessionId,
        ...(skillContext ? { skillContext } : {}),
      }).catch(() => {});

      return finalResult;
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
            errorMessage: error instanceof Error ? error.message : String(error),
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
