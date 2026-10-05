// The parity tests share this helper. An MCP `tools/call` returns the envelope as JSON in
// a text content block: `{ content: [{ type: 'text', text: '<json>' }] }`.
// The helper returns the parsed envelope, so a test can compare it with the `--json`
// stdout of the CLI.

/**
 * Parses the result of an MCP `tools/call` into the envelope of the Exarchos MCP server.
 * It throws if the result has no text content block. That shows a transport error or a
 * change in the MCP wire format.
 */
export function extractEnvelope(toolCallResult: unknown): unknown {
  const r = toolCallResult as { content?: Array<{ type: string; text?: string }> };
  const text = r.content?.find((c) => c.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('expected MCP tools/call result to contain a text content block');
  }
  return JSON.parse(text);
}
