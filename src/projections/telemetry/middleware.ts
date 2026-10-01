/**
 * Telemetry wrapper for tool handlers.
 *
 * `enforceResponseEconomy` comes from its leaf module, not from `dispatch/core/dispatch.js`.
 * `dispatch()` imports this module dynamically, so the leaf import keeps the edge
 * one-way and prevents a runtime import cycle.
 */
import { EventStore } from '../../events/store.js';
import type { ToolResult, PerfMetrics } from '../../format.js';
import { enforceResponseEconomy } from '../../dispatch/core/response-economy.js';
import { telemetryLogger } from '../../logger.js';
import { TELEMETRY_STREAM, TOKEN_GATE_THRESHOLD } from './constants.js';
import type { ToolMetrics } from './telemetry-projection.js';
import { matchCorrection, applyCorrections } from './auto-correction.js';
import type { Correction } from './auto-correction.js';
import { TraceWriter } from './trace-writer.js';

const traceWriter = new TraceWriter();

/** Transport-agnostic handler type: accepts args, returns ToolResult. */
export type CoreHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/** Optional configuration for auto-correction behavior in withTelemetry. */
export interface AutoCorrectionOptions {
  /** The action of the call, for example `'tasks'`, `'query'` or `'get'`. */
  readonly action: string;
  /** Returns current metrics for the tool. */
  readonly getMetrics: () => ToolMetrics;
  /** Number of consecutive threshold breaches. */
  readonly consecutiveBreaches: number;
}

/** Sets `_perf` directly on the ToolResult object. */
function injectPerf(result: ToolResult, perf: PerfMetrics): ToolResult {
  return { ...result, _perf: perf };
}

/** Sets `_corrections` directly on the ToolResult object. */
function injectAutoCorrection(result: ToolResult, applied: Correction[]): ToolResult {
  if (applied.length === 0) return result;
  return { ...result, _corrections: { applied } };
}

interface EventHint {
  readonly eventType: string;
  readonly description: string;
  readonly requiredFields?: readonly string[];
}

/** Sets `_eventHints` directly on the ToolResult object. */
function injectEventHints(result: ToolResult, payload: { missing: readonly EventHint[]; phase: string; checked: number }): ToolResult {
  if (payload.missing.length === 0) return result;
  return { ...result, _eventHints: payload };
}

/** True when a result has `success: false`. A result without `success` is not a failure. */
function isStructuredFailure(result: ToolResult): boolean {
  return (result as { success?: unknown }).success === false;
}

function extractErrorCode(result: ToolResult): string {
  const err = (result as { error?: { code?: unknown } }).error;
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code.length > 0) {
    return err.code;
  }
  return 'UNKNOWN';
}

/**
 * Wrap a `CoreHandler` with telemetry. It emits `tool.invoked`, then `tool.completed`,
 * or `tool.errored` on a throw. A `success: false` result also emits `tool.action_errored`.
 *
 * The response-economy cap runs before the size measurement, so `_perf` and the events
 * report the capped size. A response over the token threshold emits `tool.budget_exceeded`
 * on the telemetry stream. It writes no gate result to the feature stream, because no
 * later gate run clears such a result and convergence stays blocked.
 *
 * With `autoCorrectionOptions`, it corrects the arguments first and adds `_corrections`.
 * With a `featureId`, it adds event hints that arrive within 150 ms. It also writes a
 * trace. A telemetry failure never breaks the handler.
 */
export function withTelemetry(
  handler: CoreHandler,
  toolName: string,
  eventStore: EventStore,
  autoCorrectionOptions?: AutoCorrectionOptions,
): CoreHandler {
  return async (args) => {
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

    const invokePromise = eventStore
      .append(TELEMETRY_STREAM, {
        type: 'tool.invoked',
        data: { tool: toolName },
      })
      .catch(() => {});

    const start = performance.now();

    try {
      const rawResult = await handler(correctedArgs);
      const durationMs = Math.round(performance.now() - start);

      const economyAction =
        typeof correctedArgs.action === 'string' ? correctedArgs.action : undefined;
      const result = enforceResponseEconomy(rawResult, toolName, economyAction);

      let responseText: string;
      try {
        responseText = JSON.stringify(result);
      } catch {
        responseText = '{}';
      }
      const responseBytes = Buffer.byteLength(responseText, 'utf-8');
      const tokenEstimate = Math.ceil(responseBytes / 4);

      if (tokenEstimate > TOKEN_GATE_THRESHOLD) {
        const featureIdForBreach =
          typeof correctedArgs.featureId === 'string' ? correctedArgs.featureId : undefined;
        eventStore
          .append(TELEMETRY_STREAM, {
            type: 'tool.budget_exceeded',
            data: {
              tool: toolName,
              tokenEstimate,
              responseBytes,
              threshold: TOKEN_GATE_THRESHOLD,
              ...(featureIdForBreach !== undefined && { featureId: featureIdForBreach }),
            },
          })
          .catch(() => {});
      }

      await invokePromise;

      await eventStore
        .append(TELEMETRY_STREAM, {
          type: 'tool.completed',
          data: { tool: toolName, durationMs, responseBytes, tokenEstimate },
        })
        .catch(() => {});

      if (isStructuredFailure(result)) {
        const errorCode = extractErrorCode(result);
        await eventStore
          .append(TELEMETRY_STREAM, {
            type: 'tool.action_errored',
            data: { tool: toolName, durationMs, errorCode, responseBytes, tokenEstimate },
          })
          .catch(() => {});
      }

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

      const featureIdForHints = typeof correctedArgs.featureId === 'string' ? correctedArgs.featureId : undefined;
      if (featureIdForHints) {
        try {
          const HINT_TIMEOUT_MS = 150;
          const hintResult = await Promise.race([
            (async () => {
              const { handleCheckEventEmissions } = await import('../../verbs/gates/check-event-emissions.js');
              return handleCheckEventEmissions(
                { featureId: featureIdForHints },
                eventStore.dir,
                eventStore,
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
        } catch {}
      }

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

      await invokePromise;

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

interface McpServer {
  tool: (...args: unknown[]) => void;
}

/** Return a registrar that wraps each `CoreHandler` with {@link withTelemetry} and passes it to `server.tool()`. */
export function createInstrumentedRegistrar(
  server: McpServer,
  eventStore: EventStore,
) {
  return (name: string, description: string, schema: unknown, handler: CoreHandler) => {
    server.tool(name, description, schema, withTelemetry(handler, name, eventStore));
  };
}
