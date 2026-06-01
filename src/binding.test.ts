import { describe, it, expect } from 'vitest';
import {
  renderBindingBlock,
  BINDING_MARKER_START,
  BINDING_MARKER_END,
} from './binding.js';

const BODY =
  'Use `{{MCP_PREFIX}}exarchos_workflow` and the `{{COMMAND_PREFIX}}ideate` command.';

describe('renderBindingBlock (#1485 T3)', () => {
  it('RenderBindingBlock_SubstitutesMcpPrefix_InjectsPrefix', () => {
    const out = renderBindingBlock(BODY, {
      MCP_PREFIX: 'mcp__exarchos__',
      COMMAND_PREFIX: '/',
    });
    expect(out).toContain('mcp__exarchos__exarchos_workflow');
    expect(out).toContain('/ideate');
    expect(out).not.toContain('{{MCP_PREFIX}}');
  });

  it('RenderBindingBlock_WrapsInMarkers_FencedIdempotent', () => {
    const out = renderBindingBlock(BODY, { MCP_PREFIX: 'x', COMMAND_PREFIX: '' });
    expect(out.startsWith(BINDING_MARKER_START)).toBe(true);
    expect(out.trimEnd().endsWith(BINDING_MARKER_END)).toBe(true);
    // Idempotent: the markers let a re-render replace the fenced region exactly.
    expect(out.indexOf(BINDING_MARKER_START)).toBe(
      out.lastIndexOf(BINDING_MARKER_START),
    );
    // Pure render → a second pass with the same inputs is byte-identical.
    expect(renderBindingBlock(BODY, { MCP_PREFIX: 'x', COMMAND_PREFIX: '' })).toBe(out);
  });
});
