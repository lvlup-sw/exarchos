import { EventStore } from '../event-store/store.js';
import type { ToolResult, PerfMetrics } from '../format.js';
// Import the economy seam from its LEAF module, NOT from `core/dispatch.js`
// (DR-4, task 009). dispatch() dynamic-imports THIS middleware for its
// telemetry-ON wrap arm; importing `enforceResponseEconomy` from the leaf keeps
// that a one-way edge instead of a dispatch ↔ middleware runtime import cycle.
import { enforceResponseEconomy } from '../core/response-economy.js';
import { telemetryLogger } from '../logger.js';
import { TELEMETRY_STREAM, TOKEN_GATE_THRESHOLD } from './constants.js';
import type { ToolMetrics } from './telemetry-projection.js';
import { matchCorrection, applyCorrections } from './auto-correction.js';
import type { Correction } from './auto-correction.js';
import { TraceWriter } from './trace-writer.js';

// ─── Singleton TraceWriter ──────────────────────────────────────────────────

const traceWriter = new TraceWriter();

// ─── Types ──────────────────────────────────────────────────────────────────

/** Transport-agnostic handler type: accepts args, returns ToolResult. */
export type CoreHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

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

/** Sets `_perf` directly on the ToolResult object. */
function injectPerf(result: ToolResult, perf: PerfMetrics): ToolResult {
  return { ...result, _perf: perf };
}

/** Sets `_corrections` directly on the ToolResult object. */
function injectAutoCorrection(result: ToolResult, applied: Correction[]): ToolResult {
  if (applied.length === 0) return result;
  return { ...result, _corrections: { applied } };
}

// ─── Event Hint Injection ──────────────────────────────────────────────────

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

// PR3/T8 (#1364) — typed predicates for structured action-level failure
// recognition. Kept micro/local; not exported. A handler that returns
// `{success: false, error: {…}}` is a structured failure; anything else
// (success: true, no `success` property at all) is not.
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

// ─── withTelemetry HOF ──────────────────────────────────────────────────────

/**
 * Wraps a CoreHandler with telemetry instrumentation.
 *
 * Emits `tool.invoked` before execution, `tool.completed` after success (with
 * duration, response size, and token estimate), or `tool.errored` on failure.
 *
 * When `autoCorrectionOptions` is provided, applies auto-correction rules before
 * calling the handler and injects `_corrections` metadata into the response.
 *
 * Telemetry failures are swallowed — they never break the underlying handler.
 */
export function withTelemetry(
  handler: CoreHandler,
  toolName: string,
  eventStore: EventStore,
  autoCorrectionOptions?: AutoCorrectionOptions,
): CoreHandler {
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
      const rawResult = await handler(correctedArgs);
      const durationMs = Math.round(performance.now() - start);

      // ─── Response-Economy Enforcement (DR-1, Task 003) ────────────────────
      // Cap the handler's response against its registry-declared economy budget
      // BEFORE the size is measured, so `_perf`, the `tool.completed` telemetry
      // event, and the D3 catastrophic-overflow gate all report the FINAL,
      // post-cap size — the guard and the measurement agree by construction.
      // The cap decision lives in the shared dispatch core
      // (`enforceResponseEconomy`); this seam only invokes it. On a
      // fail-open / under-budget path the payload is returned untouched.
      const economyAction =
        typeof correctedArgs.action === 'string' ? correctedArgs.action : undefined;
      const result = enforceResponseEconomy(rawResult, toolName, economyAction);

      // Serialize ToolResult to compute response size/token estimate
      let responseText: string;
      try {
        responseText = JSON.stringify(result);
      } catch {
        responseText = '{}';
      }
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

      // PR3/T8 (#1364) — split transport vs action-level errors. When the
      // handler returns the standard MCP envelope failure
      // `{success: false, error: {code, message}}`, emit a companion
      // `tool.action_errored` so `view telemetry` can attribute the outcome
      // by error code (MERGE_ROLLED_BACK, PREFLIGHT_FAILED, RESERVED_FIELD,
      // …). `tool.errored` continues to fire only on JS throws (transport).
      if (isStructuredFailure(result)) {
        const errorCode = extractErrorCode(result);
        await eventStore
          .append(TELEMETRY_STREAM, {
            type: 'tool.action_errored',
            data: { tool: toolName, durationMs, errorCode, responseBytes, tokenEstimate },
          })
          .catch(() => { /* telemetry drop — non-fatal, never block workflow */ });
      }

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
 * Creates a registration function that transparently wraps CoreHandlers
 * with telemetry instrumentation before delegating to `server.tool()`.
 */
export function createInstrumentedRegistrar(
  server: McpServer,
  eventStore: EventStore,
) {
  return (name: string, description: string, schema: unknown, handler: CoreHandler) => {
    server.tool(name, description, schema, withTelemetry(handler, name, eventStore));
  };
}
