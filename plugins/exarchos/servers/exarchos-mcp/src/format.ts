// ─── Shared Tool Result Formatting ──────────────────────────────────────────

export interface ToolResult {
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: { code: string; message: string; validTargets?: readonly string[] };
  readonly _meta?: unknown;
}

export function formatResult(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    isError: !result.success,
  };
}

export function stubResult() {
  return formatResult({
    success: false,
    error: { code: 'NOT_IMPLEMENTED', message: 'Coming soon' },
  });
}
