// ─── Shared Tool Result Formatting ──────────────────────────────────────────

import type { ValidTransitionTarget } from './workflow/state-machine.js';

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly (string | ValidTransitionTarget)[] };
  readonly warnings?: readonly string[];
  readonly _meta?: unknown;
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

/** Picks only the specified fields from an object, returning a partial copy. */
export function pickFields<T extends Record<string, unknown>>(obj: T, fields: string[]): Partial<T> {
  const result: Partial<T> = {};
  for (const field of fields) {
    if (field in obj) {
      (result as Record<string, unknown>)[field] = obj[field];
    }
  }
  return result;
}
