// ─── Shared Tool Result Formatting ──────────────────────────────────────────

import type { ValidTransitionTarget } from './workflow/state-machine.js';
import type { Correction } from './telemetry/auto-correction.js';
import type { NextAction } from './next-action.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  type CapabilityResolver,
} from './capabilities/resolver.js';
import { STABLE_KEYS } from './projections/rehydration/serialize.js';

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
  /**
   * Runtime-specific prompt-cache hint (T051, DR-14).
   *
   * Only emitted when `applyCacheHints` is called with a resolver that
   * reports the `anthropic_native_caching` capability. Absent on other
   * runtimes so that consumers see no foreign field. See
   * {@link CacheHints} for the shape.
   */
  readonly _cacheHints?: CacheHints;
  readonly _meta: Record<string, unknown>;
  readonly _perf: PerfMetrics;
}

/**
 * Cache-boundary hint emitted on Anthropic-native runtimes (T051, DR-14).
 *
 * JSON has no inline markup boundary, so we surface the boundary as a
 * sibling field on the envelope. Consumers that understand the hint wrap
 * their API call with `cache_control: { type: "ephemeral", ttl: "1h" }`
 * around the stable prefix; consumers that don't understand it ignore
 * the field. `position` is a deterministic string derived from
 * `STABLE_KEYS` (T050) so the boundary tracks the canonical serializer.
 */
export interface CacheHints {
  readonly type: 'cache_boundary';
  readonly position: string;
  readonly kind: 'ephemeral';
  readonly ttl: '1h';
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

/**
 * Composite-boundary helper: thread the `ToolResult` diagnostic side-channels
 * (`warnings`, `_corrections`) onto an envelope produced by {@link wrap}.
 *
 * `Envelope<T>` deliberately models only the typed payload shape; the
 * `warnings` and `_corrections` fields live on `ToolResult` so handlers can
 * populate them without committing to a particular envelope wave. Composite
 * tools that wrap a source `ToolResult` into an `Envelope<T>` would otherwise
 * silently drop both fields at the conversion boundary — meaning
 * auto-correction telemetry and user-visible warning strings disappear from
 * the wire even though the handler set them.
 *
 * Behaviour:
 *   - `warnings` is preserved iff present and non-empty.
 *   - `_corrections` is preserved iff present (an empty `applied` array is
 *     legitimate signal that a correction pass ran but found nothing).
 *   - When neither is set, the input envelope is returned unchanged so
 *     normal-path output stays minimal.
 *
 * The return type is `ToolResult` rather than `Envelope<T>` because the
 * envelope schema does not declare these fields; consumers that read the
 * envelope strictly will ignore them, while consumers that read the
 * `ToolResult` shape will see them. This is the same trade-off made by the
 * cast at the call site today.
 */
export function wrapWithPassthrough<T>(
  source: ToolResult,
  envelope: Envelope<T>,
): ToolResult {
  const passthrough: Record<string, unknown> = {};
  if (source.warnings && source.warnings.length > 0) {
    passthrough.warnings = source.warnings;
  }
  if (source._corrections !== undefined) {
    passthrough._corrections = source._corrections;
  }
  if (Object.keys(passthrough).length === 0) {
    return envelope as unknown as ToolResult;
  }
  return { ...envelope, ...passthrough } as unknown as ToolResult;
}

/**
 * Apply a runtime-conditional prompt-cache hint to an envelope (T051, DR-14).
 *
 * When the resolver reports `anthropic_native_caching`, returns a new
 * envelope with `_cacheHints` describing the stable/volatile boundary.
 * When the capability is absent, returns the input envelope untouched —
 * the `_cacheHints` field is omitted entirely rather than set to
 * `undefined` (preferred for JSON wire output where absence is
 * semantically distinct from an explicit null).
 *
 * Kept as a post-wrap composite helper (mirroring the T041
 * `next-actions-from-result` pattern) so that `wrap()` stays pure and
 * the runtime-detection concern lives at the composite boundary. The
 * `position` field is derived from the canonical `STABLE_KEYS` order
 * (T050) so the boundary string tracks the serializer without
 * duplicating the ordering policy.
 *
 * @example
 *   const env = wrap(doc, meta, perf);
 *   return applyCacheHints(env, resolver);
 */
export function applyCacheHints<T>(
  envelope: Envelope<T>,
  resolver: CapabilityResolver,
): Envelope<T> {
  if (!resolver.has(ANTHROPIC_NATIVE_CACHING)) {
    return envelope;
  }
  const hints: CacheHints = {
    type: 'cache_boundary',
    position: `after:${STABLE_KEYS.join(',')}`,
    kind: 'ephemeral',
    ttl: '1h',
  };
  return {
    ...envelope,
    _cacheHints: hints,
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
