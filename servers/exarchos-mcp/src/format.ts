// ─── Shared Tool Result Formatting ──────────────────────────────────────────

import type { ValidTransitionTarget } from './workflow/state-machine.js';
import type { Correction } from './telemetry/auto-correction.js';
import type { NextAction } from './next-action.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  type CapabilityResolver,
} from './capabilities/resolver.js';
import { STABLE_PREFIX_KEYS } from './projections/rehydration/serialize.js';
import { ConcurrencyError } from './event-store/concurrency-error.js';
import { StorageBusyError } from './event-store/storage-busy-error.js';

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

/**
 * Economy-enforcement `_meta` conventions (DR-1, Task 003).
 *
 * The dispatch-core response-economy seam (`enforceResponseEconomy`,
 * `core/dispatch.ts`) stamps exactly one of these markers on the envelope
 * `_meta` after measuring `data` against the action's resolved budget
 * (`resolveEconomyBudget`, `registry.ts`):
 *
 * - `truncated` — the response exceeded its budget and `data` was replaced
 *   by the action's declared summarizer output, or the generic capped
 *   fallback shaped as `{ summary, counts, firstPage }` (the shared
 *   `CappedDataSchema` fragment). The envelope carrier fields
 *   (`success`, `next_actions`, `_meta`, `_perf`, …) are never truncated —
 *   budgets measure `data` only.
 * - `economyDegraded` — fail-open marker: the budget resolved
 *   non-finite / non-positive, OR the declared summarizer threw. The
 *   UNCAPPED payload is returned untouched with this marker so the caller
 *   still sees the full inventory — never an error, never a silent drop
 *   (#1659 DR-3 precedent).
 *
 * The two markers are mutually exclusive on any single response: a capped
 * response carries `truncated: true`; a fail-open response carries
 * `economyDegraded: true`.
 */
export interface EconomyMeta {
  readonly truncated?: boolean;
  readonly economyDegraded?: boolean;
}

/** `_meta` key stamped on a successfully-capped (summarized) response. */
export const ECONOMY_META_TRUNCATED = 'truncated' as const;

/** `_meta` key stamped on a fail-open (uncapped, degraded) response. */
export const ECONOMY_META_DEGRADED = 'economyDegraded' as const;


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
    // T04 (Issue #1192): the readonly capability gate uses these fields to
    // identify which composite tool / action was rejected so callers can
    // correlate a CAPABILITY_DENIED rejection back to a specific dispatch.
    tool?: string;
    action?: string;
    // DR-4 (#1259, v2.11): structured `validActions` list emitted by the
    // composite handler's UNKNOWN_ACTION fallback so agents can self-correct
    // without parsing the message string. INV-5a (input ergonomics) — the
    // hard-cut error envelope must surface the canonical action name.
    validActions?: readonly string[];
  };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
  readonly _perf?: PerfMetrics;
  readonly _eventHints?: EventHintsPayload;
  readonly _corrections?: CorrectionsPayload;
  // Wave 0 (#1369, CodeRabbit HIGH on PR #1369): the composite envelopeWrap
  // returns an Envelope cast as ToolResult, carrying `next_actions` at the
  // top level. Declaring it formally here lets `toEnvelope` thread it through
  // instead of silently dropping it when re-wrapping (which manifested as the
  // #1208 saga-merge-detour regression: rehydrate returned `next_actions: []`
  // even though the composite computed the merge_orchestrate verb).
  readonly next_actions?: readonly NextAction[];
  readonly _cacheHints?: CacheHints;
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
 * `STABLE_PREFIX_KEYS` (T050) so the boundary tracks the canonical
 * serializer — including the leading `v` / `projectionSequence` discriminators.
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
  // `_eventHints` is part of the Envelope shape but populated on the source
  // ToolResult by handlers that emit events (the field name and shape are
  // identical on both types). Forward when present so composite wrapping
  // doesn't strip per-action event acks. (CodeRabbit PR #1178 review.)
  const sourceWithHints = source as ToolResult & { _eventHints?: unknown };
  if (sourceWithHints._eventHints !== undefined) {
    passthrough._eventHints = sourceWithHints._eventHints;
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
 * `position` field is derived from the canonical `STABLE_PREFIX_KEYS`
 * order (T050) so the boundary string tracks the serializer without
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
    // Position must enumerate the entire stable prefix as it appears in the
    // serialized document, including the leading `v` / `projectionSequence`
    // discriminators (sentry[bot] PR #1178#discussion_r3142469093). Pulled
    // from the serializer's source-of-truth constant so the boundary string
    // tracks any future re-ordering of the prefix.
    position: `after:${STABLE_PREFIX_KEYS.join(',')}`,
    kind: 'ephemeral',
    ttl: '1h',
  };
  return {
    ...envelope,
    _cacheHints: hints,
  };
}

// ─── Error Envelope Mapping (Wave 3 Task 3.13 / 3.13a) ──────────────────────

/**
 * Failure envelope shape produced by {@link wrapError}.
 *
 * Carries the canonical fields the dispatch-core boundary surfaces upward
 * when a typed error escapes a handler: `success: false`, a structured
 * `error` block with `code`, INV-5b's `validTargets` + `suggestedFix`,
 * and the same `_meta` / `_perf` discipline as successful envelopes.
 *
 * The runtime shape is a strict superset of {@link ToolResult}'s failure
 * variant; we return the tighter type so callers reading via the
 * `Envelope<T>` discriminator see `success: false`.
 */
export interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly validTargets?: readonly string[];
    readonly suggestedFix?: { tool: string; params: Record<string, unknown> };
    readonly [k: string]: unknown;
  };
  readonly _meta: Record<string, unknown>;
  readonly _perf: PerfMetrics;
  // Optional sidebars threaded through from the source ToolResult so the
  // CLI round-trip preserves diagnostics on the failure path (INV-2 facade
  // equivalence; CodeRabbit minor on PR #1369).
  readonly warnings?: readonly string[];
  readonly _corrections?: CorrectionsPayload;
}

/**
 * Map a typed error to its canonical {@link ErrorEnvelope} shape.
 *
 * Wave 3 (R-2 primitives) ships the first two branches:
 *
 *   - {@link ConcurrencyError} → `CONCURRENCY_CONFLICT` envelope. Caller
 *     MUST re-fetch state and re-decide before retrying — the original
 *     read is stale.
 *   - {@link StorageBusyError} → `STORAGE_BUSY` envelope. Caller may
 *     retry the SAME decision after backing off; the other writer
 *     commits on its own.
 *
 * The two envelopes are deliberately distinct so middleware
 * (`withStateRetry` in Wave 4) can apply a different retry budget — the
 * audit (§F2.1) flagged the conflation of these two failure modes as a
 * blocker for the migration.
 *
 * Per design `docs/designs/2026-05-10-v2-10-0-preview-2-marten-primitives.md`
 * §"ConcurrencyError envelope" and §"StorageBusyError envelope".
 *
 * Unknown error types fall through to a generic shape with
 * `code: 'INTERNAL_ERROR'` so the boundary never leaks raw stack traces.
 *
 * @param err - The typed error caught at the wrap boundary.
 * @param meta - Optional per-call `_meta` overrides; merged with the
 *   default `{ degraded: false, retryable: <true for ConcurrencyError /
 *   StorageBusyError, false otherwise> }`.
 * @param perf - Optional per-call `_perf` overrides; missing fields
 *   default to 0 per the canonical envelope shape.
 */
export function wrapError(
  err: unknown,
  meta?: Record<string, unknown>,
  perf?: { ms?: number; bytes?: number; tokens?: number },
): ErrorEnvelope {
  const _perf: PerfMetrics = {
    ms: perf?.ms ?? 0,
    bytes: perf?.bytes ?? 0,
    tokens: perf?.tokens ?? 0,
  };

  if (err instanceof ConcurrencyError) {
    return {
      success: false,
      error: {
        code: 'CONCURRENCY_CONFLICT',
        message: err.message,
        streamId: err.streamId,
        reducerId: err.reducerId,
        expectedVersion: err.expectedVersion,
        actualVersion: err.actualVersion,
        ...(err.operationId !== undefined ? { operationId: err.operationId } : {}),
        validTargets: ['retry'] as const,
        suggestedFix: {
          tool: 'retry',
          params: {
            reason: 'Re-fetch state and retry the operation — the stream tail advanced during decide.',
          },
        },
      },
      _meta: { degraded: false, retryable: true, ...(meta ?? {}) },
      _perf,
    };
  }

  if (err instanceof StorageBusyError) {
    return {
      success: false,
      error: {
        code: 'STORAGE_BUSY',
        message: err.message,
        streamId: err.streamId,
        attempts: err.attempts,
        validTargets: ['retry'] as const,
        suggestedFix: {
          tool: 'retry',
          params: {
            reason: 'Retry after brief delay; back off — substrate is under cross-process write contention.',
          },
        },
      },
      _meta: { degraded: false, retryable: true, ...(meta ?? {}) },
      _perf,
    };
  }

  // Generic fallthrough: do not leak the stack; surface a stable
  // INTERNAL_ERROR code with the error's message (if Error-shaped).
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'Unknown error';
  return {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message,
    },
    _meta: { degraded: false, retryable: false, ...(meta ?? {}) },
    _perf,
  };
}

// ─── ToolResult → Envelope Adapter (Wave 0 — Carrier Swap) ─────────────────

/**
 * Bridge a dispatch-core {@link ToolResult} to the carrier-bound
 * {@link Envelope} | {@link ErrorEnvelope} shape (design
 * `docs/designs/2026-05-13-wave-0-carrier-swap.md` §2.3).
 *
 * Why this lives alongside (rather than replacing) `wrap` / `wrapError`:
 *
 *   - `wrap()` takes a typed `data` payload directly — it's the
 *     handler-side constructor used inside an action handler that knows
 *     its data shape statically.
 *   - `wrapError()` takes a typed `Error` instance — it's the catch-side
 *     constructor for typed primitive errors (`ConcurrencyError`,
 *     `StorageBusyError`, etc.).
 *   - `toEnvelope()` takes a `ToolResult` that already has the
 *     post-dispatch error block populated by the composite — it is the
 *     boundary adapter the carrier-bound `toMcpResult` / `toCliResult`
 *     adapters call on the result they receive from the dispatch core.
 *     We do NOT call `wrapError(result.error)` here because the typed
 *     primitive context is gone — `result.error` is already structured.
 *
 * Behaviour:
 *
 *   - `success: true` → delegates to {@link wrap} so the resulting
 *     `next_actions` / `_meta` / `_perf` discipline matches the canonical
 *     constructor. Defaults to `[]` next_actions when none supplied.
 *   - `success: false` → builds the {@link ErrorEnvelope} directly from
 *     `result.error`, threading `code`, `message`, and any aux fields
 *     (`validTargets`, `suggestedFix`, `unmetGates`, etc.) unchanged so
 *     the carrier sees a full diagnostic envelope.
 *
 * The return type is a discriminated union `Envelope<unknown> |
 * ErrorEnvelope`; consumers branch on the `success` literal to narrow.
 */
export function toEnvelope(result: ToolResult): Envelope<unknown> | ErrorEnvelope {
  const _perf: PerfMetrics = {
    ms: result._perf?.ms ?? 0,
    bytes: result._perf?.bytes ?? 0,
    tokens: result._perf?.tokens ?? 0,
  };
  const _meta =
    result._meta !== undefined && result._meta !== null && typeof result._meta === 'object'
      ? (result._meta as Record<string, unknown>)
      : {};

  if (result.success) {
    // The composite `envelopeWrap` returns an Envelope cast as ToolResult,
    // so `result.next_actions` / `result.warnings` / `result._corrections` /
    // `result._eventHints` / `result._cacheHints` are already populated by
    // the dispatch core. Thread them through the wrap boundary rather than
    // letting `wrap()`'s defaults reset them — that was the silent-drop bug
    // behind the #1208 saga-merge-detour regression.
    const envelope = wrap(result.data, _meta, _perf, result.next_actions);
    const decorated: Record<string, unknown> = { ...envelope };
    if (result.warnings !== undefined && result.warnings.length > 0) {
      decorated.warnings = result.warnings;
    }
    if (result._corrections !== undefined) {
      decorated._corrections = result._corrections;
    }
    if (result._eventHints !== undefined) {
      decorated._eventHints = result._eventHints;
    }
    if (result._cacheHints !== undefined) {
      decorated._cacheHints = result._cacheHints;
    }
    return decorated as unknown as Envelope<unknown>;
  }

  // Failure path — surface the structured error block as-is. The error is
  // guaranteed to exist on a failure ToolResult by the dispatch contract,
  // but we guard defensively so a malformed input never throws here.
  const sourceError = result.error ?? { code: 'INTERNAL_ERROR', message: 'Unknown error' };
  // `error.validTargets` accepts `readonly (string | ValidTransitionTarget)[]`
  // on the dispatch-core ToolResult (guard failures carry the full target
  // object including its phase/guard tuple), but the carrier-side
  // `ErrorEnvelope` advertises `readonly string[]`. Narrow to the
  // canonical phase string here so the envelope schema validation passes
  // and downstream consumers see a stable string identifier — richer guard
  // metadata stays reachable via the `describe` action (CodeRabbit CRITICAL
  // on PR #1369: an unchecked cast smuggled objects across the boundary).
  const narrowedValidTargets = sourceError.validTargets?.map(
    t => (typeof t === 'string' ? t : t.phase),
  );
  const error: ErrorEnvelope['error'] = {
    code: sourceError.code,
    message: sourceError.message,
    ...(narrowedValidTargets !== undefined ? { validTargets: narrowedValidTargets } : {}),
    ...(sourceError.suggestedFix !== undefined ? { suggestedFix: sourceError.suggestedFix } : {}),
    ...(sourceError.expectedShape !== undefined ? { expectedShape: sourceError.expectedShape } : {}),
    ...(sourceError.unmetGates !== undefined ? { unmetGates: sourceError.unmetGates } : {}),
    ...(sourceError.gate !== undefined ? { gate: sourceError.gate } : {}),
    ...(sourceError.operationsSince !== undefined ? { operationsSince: sourceError.operationsSince } : {}),
    ...(sourceError.threshold !== undefined ? { threshold: sourceError.threshold } : {}),
    ...(sourceError.tool !== undefined ? { tool: sourceError.tool } : {}),
    ...(sourceError.action !== undefined ? { action: sourceError.action } : {}),
    ...(sourceError.validActions !== undefined ? { validActions: sourceError.validActions } : {}),
  };
  const failure: ErrorEnvelope = {
    success: false,
    error,
    _meta,
    _perf,
    // Thread sidebars through on the failure path so the cli round-trip
    // (envelopeToToolResult → prettyPrint) and any structured-content
    // consumer can still surface diagnostics (CodeRabbit minor on PR
    // #1369). The success path does the equivalent thread above.
    ...(result.warnings !== undefined && result.warnings.length > 0
      ? { warnings: result.warnings }
      : {}),
    ...(result._corrections !== undefined ? { _corrections: result._corrections } : {}),
  };
  return failure;
}

// ─── Event Acknowledgement ──────────────────────────────────────────────────

export interface EventAck {
  readonly streamId: string;
  readonly sequence: number;
  readonly type: string;
}

/** Extracts a minimal acknowledgement (streamId, sequence, type) from a full event to reduce response payload size. */
export function toEventAck(event: { streamId: string; sequence: number; type: string }): EventAck {
  return { streamId: event.streamId, sequence: event.sequence, type: event.type };
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
