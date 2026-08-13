// Source: docs/plans/archive/2026-05-05-e2e-v29-revisited.md §T3.6 (refactor step)
//
// MCP `tools/call` returns the envelope wrapped as a JSON-encoded text
// content block:
//   `{ content: [{ type: 'text', text: '<json>' }] }`
// (see `src/format.ts:formatResult`).
//
// This helper unwraps that double-encoding so callers can compare the inner
// envelope structurally with the CLI's `--json` stdout. It was inlined in
// T3.4 (parity-workflow-describe), T3.5 (parity-event-query), and was about
// to be inlined a third time in T3.6 (parity-workflow-rehydrate); lift here
// before adding the third call site so all three parity tests share one
// implementation.

/**
 * Parse the MCP `tools/call` result into the underlying envelope object
 * emitted by the Exarchos MCP server.
 *
 * Throws if the result lacks a `content` array containing a text block —
 * this is unrecoverable and indicates either a transport error or a change
 * to the MCP SDK's wire format. The error message includes a hint so a
 * future reader knows where to look.
 */
export function extractEnvelope(toolCallResult: unknown): unknown {
  const r = toolCallResult as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('expected MCP tools/call result to contain a text content block');
  }
  return JSON.parse(text);
}
