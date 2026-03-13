// ─── Shared Tool Result Formatting ──────────────────────────────────────────

import type { ValidTransitionTarget } from './workflow/state-machine.js';
import type { Correction } from './telemetry/auto-correction.js';

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
  };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
  readonly _perf?: PerfMetrics;
  readonly _eventHints?: EventHintsPayload;
  readonly _corrections?: CorrectionsPayload;
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

// ─── MCP Wire Format Types ──────────────────────────────────────────────────

export interface McpToolContent {
  readonly type: 'text';
  readonly text: string;
  readonly [key: string]: unknown;
}

export interface McpToolResult {
  content: McpToolContent[];
  isError: boolean;
  [key: string]: unknown;
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

/** Returns a NOT_IMPLEMENTED error result for placeholder tool registrations. */
export function stubResult() {
  return formatResult({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Coming soon' },
  });
}

// ─── Field Projection ──────────────────────────────────────────────────────

/** Picks only the specified fields from an object, returning a partial copy.
 *  Supports dot-path notation (e.g. "data.taskId") for nested field projection. */
export function pickFields<T extends Record<string, unknown>>(obj: T, fields: string[]): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (!field.includes('.')) {
      // Top-level field — existing behavior
      if (field in obj) {
        result[field] = obj[field];
      }
    } else {
      // Dot-path: traverse source, reconstruct nested path in result
      const segments = field.split('.');
      let source: unknown = obj;
      let valid = true;
      for (const seg of segments) {
        if (source !== null && typeof source === 'object' && seg in (source as Record<string, unknown>)) {
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
          if (!(seg in target) || typeof target[seg] !== 'object' || target[seg] === null) {
            target[seg] = {};
          }
          target = target[seg] as Record<string, unknown>;
        }
        target[segments[segments.length - 1]] = source;
      }
    }
  }
  return result as Partial<T>;
}
