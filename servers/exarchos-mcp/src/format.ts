// ─── Shared Tool Result Formatting ──────────────────────────────────────────

import type { ValidTransitionTarget } from './workflow/state-machine.js';
import type { Correction } from './telemetry/auto-correction.js';
import type { NextAction } from './next-action.js';

export interface PerfMetrics {
  readonly ms: number;
  readonly bytes: number;
  readonly tokens: number;
}

export interface EventHintsPayload {
  readonly missing: readonly { readonly eventType: string; readonly description: string; readonly requiredFields?: readonly string[] }[];
  readonly phase: string;
  readonly checked: number;
}

export interface CorrectionsPayload {
  readonly applied: readonly Correction[];
}


export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: {
    code: string;
    message: string;
    validTargets?: readonly (string | ValidTransitionTarget)[];
    expectedShape?: Record<string, unknown>;
    suggestedFix?: { tool: string; params: Record<string, unknown> };
    unmetGates?: readonly string[];
    gate?: string;
    operationsSince?: number;
    threshold?: number;
  };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
  readonly _perf?: PerfMetrics;
  readonly _eventHints?: EventHintsPayload;
  readonly _corrections?: CorrectionsPayload;
}

// ─── HATEOAS Envelope (DR-7) ────────────────────────────────────────────────

/**
 * Generic HATEOAS response envelope for MCP tool results.
 *
 * Wraps a strongly-typed `data` payload with affordance hints
 * (`next_actions`), diagnostic metadata (`_meta`), and performance
 * telemetry (`_perf`). Handlers will be retrofitted to return
 * `Envelope<T>` in tasks T036–T039; `next_actions` population
 * lands in T040/T041.
 *
 * Design: docs/designs/2026-04-23-rehydrate-foundation.md (envelope wrapping)
 */
export interface Envelope<T> {
  readonly success: boolean;
  readonly data: T;
  /**
   * Affordance hints — outbound transitions valid from the current workflow
   * state per the HSM topology. Populated by `computeNextActions` (T040) and
   * wired through `wrap()` at the composite boundary (T041, DR-8). Defaults
   * to `[]` when the caller has no workflow context (e.g. `describe`
   * actions, view/event-store/orchestrate composites).
   */
  readonly next_actions: readonly NextAction[];
  readonly _eventHints?: unknown;
  readonly _meta: Record<string, unknown>;
  readonly _perf: PerfMetrics;
}

/**
 * Wrap a strongly-typed `data` payload in a HATEOAS `Envelope<T>` (DR-7).
 *
 * Sets `success: true`, carries forward caller-supplied `_meta` and `_perf`,
 * and attaches `next_actions` if provided. Missing `_perf` fields default to
 * 0 so `PerfMetrics`'s required shape is always satisfied. Omitting
 * `nextActions` yields `[]` — the backward-compatible default for callers
 * that do not yet have workflow state at the wrap boundary (e.g. `describe`
 * actions, view/event-store/orchestrate composites).
 *
 * This helper is shared by T036–T039 so every composite tool produces a
 * consistent envelope shape without duplicating the construction logic.
 * T041 (DR-8) extended it to accept a 4th positional `nextActions` argument;
 * the workflow composite derives these from `computeNextActions(state, hsm)`
 * at the wrap site.
 *
 * @example
 *   // Workflow composite — state is known, populate next_actions.
 *   return wrap(
 *     { featureId, workflowType, phase },
 *     buildCheckpointMeta(state._checkpoint),
 *     { ms: Date.now() - started },
 *     computeNextActions({ phase, workflowType }, getHSMDefinition(workflowType)),
 *   );
 *
 * @example
 *   // No workflow context — default to empty affordances.
 *   return wrap({ actions: [] });
 */
export function wrap<T>(
  data: T,
  meta?: Record<string, unknown>,
  perf?: { ms: number; bytes?: number; tokens?: number },
  nextActions?: readonly NextAction[],
): Envelope<T> {
  return {
    success: true,
    data,
    next_actions: nextActions ?? [],
    _meta: meta ?? {},
    _perf: {
      ms: perf?.ms ?? 0,
      bytes: perf?.bytes ?? 0,
      tokens: perf?.tokens ?? 0,
    },
  };
}

// ─── Event Acknowledgement ──────────────────────────────────────────────────

export interface EventAck {
  readonly streamId: string;
  readonly sequence: number;
  readonly type: string;
  /** When true, the sequence number is provisional (sidecar write pending merge). */
  readonly sequencePending?: boolean;
}

/** Extracts a minimal acknowledgement (streamId, sequence, type) from a full event to reduce response payload size. */
export function toEventAck(event: { streamId: string; sequence: number; type: string }): EventAck {
  return { streamId: event.streamId, sequence: event.sequence, type: event.type };
}

// ─── Result Formatting ──────────────────────────────────────────────────────

/** Converts a ToolResult into the MCP content format expected by the SDK. */
export function formatResult(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

/**
 * Strip null, undefined, and empty-array values from a flat object.
 * Preserves false, 0, and other falsy-but-meaningful values.
 */
export function stripNullish(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value;
  }
  return result;
}

// ─── Field Projection ──────────────────────────────────────────────────────

/** Picks only the specified fields from an object, returning a partial copy.
 *  Supports dot-path notation (e.g. "data.taskId") for nested field projection. */
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function pickFields<T extends Record<string, unknown>>(obj: T, fields: string[]): Partial<T> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const segments = field.split('.');
    // Block prototype-polluting field paths
    if (segments.some((seg) => PROTO_KEYS.has(seg))) continue;

    if (segments.length === 1) {
      // Top-level field — existing behavior
      if (Object.hasOwn(obj, field)) {
        result[field] = obj[field];
      }
    } else {
      // Dot-path: traverse source, reconstruct nested path in result
      let source: unknown = obj;
      let valid = true;
      for (const seg of segments) {
        if (source !== null && typeof source === 'object' && Object.hasOwn(source as Record<string, unknown>, seg)) {
          source = (source as Record<string, unknown>)[seg];
        } else {
          valid = false;
          break;
        }
      }
      if (valid) {
        // Reconstruct the nested path in the result, merging with any existing nested object
        let target = result;
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          if (!Object.hasOwn(target, seg) || typeof target[seg] !== 'object' || target[seg] === null) {
            target[seg] = Object.create(null);
          }
          target = target[seg] as Record<string, unknown>;
        }
        target[segments[segments.length - 1]] = source;
      }
    }
  }
  return result as Partial<T>;
}
