import { describe, it, expect } from 'vitest';
import { extractEnvelope } from './mcp-envelope.js';

/**
 * T3.6 — unit tests for the shared `extractEnvelope` helper extracted from
 * the inline copies in T3.4 / T3.5 parity tests. The helper is the boundary
 * between the MCP SDK's `tools/call` wire format
 * (`{ content: [{ type, text }] }`) and the Exarchos MCP server's logical
 * result envelope (`{ success, data, ... }`).
 */
describe('extractEnvelope', () => {
  it('extractEnvelope_textContent_parsesJson', () => {
    const r = { content: [{ type: 'text', text: '{"phase":"plan"}' }] };
    expect(extractEnvelope(r)).toEqual({ phase: 'plan' });
  });

  it('extractEnvelope_missingText_throws', () => {
    expect(() => extractEnvelope({ content: [{ type: 'image' }] })).toThrow();
  });

  it('extractEnvelope_emptyContent_throws', () => {
    expect(() => extractEnvelope({ content: [] })).toThrow();
  });

  it('extractEnvelope_nullishInput_throws', () => {
    expect(() => extractEnvelope({})).toThrow();
  });
});
