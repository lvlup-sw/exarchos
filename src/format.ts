/** Shared formatting for tool results and their response envelopes. */

import type { ValidTransitionTarget } from './workflow/state-machine.js';
import type { Correction } from './projections/telemetry/auto-correction.js';
import type { NextAction, RegistryAdvertisement } from './next-action.js';
import type { ProjectionDegradedDetail } from './projections/degraded-result.js';
import {
  ANTHROPIC_NATIVE_CACHING,
  type CapabilityResolver,
} from './workflow/capabilities/resolver.js';
import { STABLE_PREFIX_KEYS } from './projections/rehydration/serialize.js';
import { UNSPECIFIED_FAILURE_CODE } from './contract/error-families.js';
import { ConcurrencyError } from './events/concurrency-error.js';
import type { BundleRefV1 } from './events/bundle/digest-references.js';
import { StorageBusyError } from './events/storage-busy-error.js';

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
 * The `_meta` markers of response economy. `enforceResponseEconomy` measures `data` against the
 * resolved budget of the action and stamps one marker at most:
 *
 * - `truncated`: `data` exceeded its budget and holds the summarizer output, or the generic capped
 *   form `{ summary, counts, firstPage }`. Budgets measure `data` only, so carrier fields are never
 *   truncated.
 * - `economyDegraded`: the budget was not a finite positive number, or the summarizer threw. The
 *   response keeps the full payload, so the caller loses nothing.
 */
export interface EconomyMeta {
  readonly truncated?: boolean;
  readonly economyDegraded?: boolean;
}

/** `_meta` key stamped on a successfully-capped (summarized) response. */
export const ECONOMY_META_TRUNCATED = 'truncated' as const;

/** `_meta` key stamped on a fail-open (uncapped, degraded) response. */
export const ECONOMY_META_DEGRADED = 'economyDegraded' as const;

/**
 * The compact receipt on the error of a bounded-segment refusal. A halted segment still ran, so
 * leaves ran and events landed. `leaves[].events` is a count, because the refusal points back into
 * the log and does not copy it. The per-leaf operation id retrieves the rest.
 */
export interface IntentFailureDetail {
  readonly operationId: string;
  readonly outcome: 'committed' | 'failed';
  readonly failedLeaf?: string;
  readonly tailSequence: number;
  /**
   * The run bundle that holds the trace of the failed segment, as (artifact id, digest) pairs. It
   * uses the reference type of the ledger, so it cannot describe a wider shape than the receipt.
   */
  readonly bundleRefs?: readonly [BundleRefV1, ...BundleRefV1[]];
  readonly leaves: readonly {
    readonly action: string;
    readonly status: string;
    readonly events: number;
    /** An advisory-mode emission finding survives the refusal, not just the receipt. */
    readonly emissionViolation?: string;
  }[];
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
    /** The composite tool and action of a `CAPABILITY_DENIED` rejection. */
    tool?: string;
    action?: string;
    /** The valid action names on an `UNKNOWN_ACTION` refusal, so an agent can correct itself. */
    validActions?: readonly string[];
    /**
     * The typed degraded verdict of a `PROJECTION_DEGRADED` refusal, and only of that code. A
     * consumer reads the tail, cursor and lag from the failure. The import is type-only.
     */
    projectionDegraded?: ProjectionDegradedDetail;
    /**
     * The receipt of a bounded-segment refusal. A failed envelope has no `data`, so the receipt
     * goes inside the error. Without it, the caller cannot see that the operation ran.
     */
    intentReceipt?: IntentFailureDetail;
    /**
     * The merge result of a `PR_MERGED_EVENT_UNRECORDED` refusal. The remote merge landed, so the
     * caller must read the result from the failure, as with `intentReceipt`.
     */
    mergeResult?: { readonly merged: boolean; readonly sha?: string; readonly error?: string };
  };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
  readonly _perf?: PerfMetrics;
  readonly _eventHints?: EventHintsPayload;
  readonly _corrections?: CorrectionsPayload;
  /**
   * The `envelopeWrap` result is an Envelope cast as a ToolResult, with `next_actions` at the top
   * level. This declaration lets `toEnvelope` keep the field when it wraps the result again.
   */
  readonly next_actions?: readonly NextAction[];
  readonly _cacheHints?: CacheHints;
}

/**
 * Generic HATEOAS response envelope for MCP tool results. It wraps a typed `data` payload with
 * affordance hints (`next_actions`), diagnostic metadata (`_meta`) and performance data (`_perf`).
 */
export interface Envelope<T> {
  readonly success: boolean;
  readonly data: T;
  /**
   * Affordance hints: the valid outbound transitions of the current workflow state in the HSM
   * topology. The value is `[]` when the caller has no workflow context.
   */
  readonly next_actions: readonly NextAction[];
  /**
   * Allow-decided registry ActionIds. Distinct from `next_actions`: these are
   * ActionIds plus the workflow subject they were decided against, never phase
   * names or control verbs. Absent when nothing was advertised.
   */
  readonly advertised_actions?: readonly RegistryAdvertisement[];
  readonly _eventHints?: unknown;
  /**
   * Runtime-specific prompt-cache hint. {@link applyCacheHints} sets it only when the resolver
   * reports `anthropic_native_caching`, so other runtimes see no foreign field.
   */
  readonly _cacheHints?: CacheHints;
  readonly _meta: Record<string, unknown>;
  readonly _perf: PerfMetrics;
}

/**
 * Cache-boundary hint on Anthropic-native runtimes. JSON has no inline boundary markup, so the hint
 * is a sibling field of the envelope. A consumer that knows the hint puts
 * `cache_control: { type: "ephemeral", ttl: "1h" }` around the stable prefix. `position` comes from
 * `STABLE_PREFIX_KEYS`, so the boundary follows the canonical serializer.
 */
export interface CacheHints {
  readonly type: 'cache_boundary';
  readonly position: string;
  readonly kind: 'ephemeral';
  readonly ttl: '1h';
}

/**
 * Wraps a typed `data` payload in a HATEOAS `Envelope<T>` with `success: true`. It keeps the
 * `_meta` and `_perf` of the caller and sets each missing `_perf` field to 0. Without
 * `nextActions`, `next_actions` is `[]`.
 *
 * @example
 *   return wrap({ featureId, phase }, meta, { ms: Date.now() - started }, nextActions);
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
 * Copies the diagnostic side channels of a `ToolResult` onto an envelope from {@link wrap}. Without
 * this copy, the wrap drops the warnings and the auto-correction data that the handler set.
 *
 *   - It keeps `warnings` when the array is not empty.
 *   - It keeps `_corrections` when it is present. An empty `applied` array is a valid signal.
 *   - It keeps `_eventHints` when it is present, so the event acknowledgements survive.
 *   - When none is set, it returns the input envelope unchanged.
 *
 * The return type is `ToolResult`, because the envelope schema does not declare these fields.
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
 * Adds a runtime-conditional prompt-cache hint to an envelope. When the resolver reports
 * `anthropic_native_caching`, it returns a new envelope with `_cacheHints`. Otherwise it returns the
 * input envelope, with no `_cacheHints` key at all.
 *
 * `position` lists the full stable prefix from `STABLE_PREFIX_KEYS`, including the leading `v` and
 * `projectionSequence` keys. Thus the boundary follows a later change to the prefix order.
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
    position: `after:${STABLE_PREFIX_KEYS.join(',')}`,
    kind: 'ephemeral',
    ttl: '1h',
  };
  return {
    ...envelope,
    _cacheHints: hints,
  };
}

/**
 * The failure envelope from {@link wrapError} and {@link toEnvelope}. It carries `success: false`,
 * an `error` block with `code`, `validTargets` and `suggestedFix`, and the same `_meta` and `_perf`
 * as a success envelope. The tighter type lets a caller narrow on `success: false`.
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
  /** Diagnostics from the source ToolResult, so the CLI round-trip keeps them on failure. */
  readonly warnings?: readonly string[];
  readonly _corrections?: CorrectionsPayload;
}

/**
 * Maps a typed error to its canonical {@link ErrorEnvelope}:
 *
 *   - {@link ConcurrencyError} gives `CONCURRENCY_CONFLICT`. The read is stale, so the caller must
 *     fetch the state again and decide again before a retry.
 *   - {@link StorageBusyError} gives `STORAGE_BUSY`. The caller can retry the same decision after a
 *     back-off, because the other writer commits on its own.
 *   - Any other value gives `INTERNAL_ERROR` with the message only, so no stack trace leaks.
 *
 * The two retryable codes are distinct, so a retry layer can give each one a different budget.
 *
 * @param err - The typed error caught at the wrap boundary.
 * @param meta - Optional `_meta` overrides, merged over `{ degraded: false, retryable }`.
 * @param perf - Optional `_perf` overrides. Each missing field is 0.
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

/**
 * Converts a dispatch-core {@link ToolResult} to an {@link Envelope} or an {@link ErrorEnvelope}.
 * The MCP and CLI adapters call it on the result from the dispatch core. It does not use
 * `wrapError`, because `result.error` is already structured and the typed error is gone.
 *
 *   - On success, it delegates to {@link wrap} and keeps `next_actions`, `warnings`,
 *     `_corrections`, `_eventHints` and `_cacheHints`, which `envelopeWrap` already set.
 *   - On failure, it builds the error block from a named set of `result.error` fields. A field
 *     that the set does not name does not reach the caller. Object `validTargets` become their
 *     phase strings, because `ErrorEnvelope` declares strings.
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

  const sourceError = result.error ?? { code: UNSPECIFIED_FAILURE_CODE, message: 'Unknown error' };
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
    ...(sourceError.intentReceipt !== undefined ? { intentReceipt: sourceError.intentReceipt } : {}),
  };
  const failure: ErrorEnvelope = {
    success: false,
    error,
    _meta,
    _perf,
    ...(result.warnings !== undefined && result.warnings.length > 0
      ? { warnings: result.warnings }
      : {}),
    ...(result._corrections !== undefined ? { _corrections: result._corrections } : {}),
  };
  return failure;
}

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

/** Path segments that {@link pickFields} refuses, to block prototype pollution. */
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Picks the given fields from an object and returns a partial copy. A dot path, for example
 * `data.taskId`, picks a nested field and rebuilds its path in the result.
 */
export function pickFields<T extends Record<string, unknown>>(obj: T, fields: string[]): Partial<T> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of fields) {
    const segments = field.split('.');
    if (segments.some((seg) => PROTO_KEYS.has(seg))) continue;

    if (segments.length === 1) {
      if (Object.hasOwn(obj, field)) {
        result[field] = obj[field];
      }
    } else {
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
        let target = result;
        for (let i = 0; i < segments.length - 1; i++) {
          const seg = segments[i];
          if (seg === undefined) continue;
          if (!Object.hasOwn(target, seg) || typeof target[seg] !== 'object' || target[seg] === null) {
            target[seg] = Object.create(null);
          }
          target = target[seg] as Record<string, unknown>;
        }
        const lastSeg = segments[segments.length - 1];
        if (lastSeg !== undefined) target[lastSeg] = source;
      }
    }
  }
  return result as Partial<T>;
}
