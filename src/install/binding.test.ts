import { describe, it, expect } from 'vitest';
import {
  renderBindingBlock,
  BINDING_MARKER_START,
  BINDING_MARKER_END,
} from './binding.js';

// The directive is now runtime-neutral logical prose (DR-5): the source uses the
// `exarchos:exarchos_*` `Server:tool` form, so there are no `{{...}}` tokens to
// substitute and `renderBindingBlock` takes only the body.
const NEUTRAL_BODY =
  'Route workflow operations through the `exarchos:exarchos_workflow` MCP tool.';

describe('renderBindingBlock (#1485 T3; neutralized DR-5)', () => {
  it('renderBindingBlock_NoPlaceholders_RuntimeNeutralOutput', () => {
    // De-parameterized: one neutral block, no runtime/placeholder argument. The
    // logical `exarchos:exarchos_*` form survives verbatim and no placeholder
    // token leaks into the output.
    const out = renderBindingBlock(NEUTRAL_BODY);
    expect(out).toContain('exarchos:exarchos_workflow');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('}}');
    // Runtime-neutral: no per-harness MCP wire prefix is baked in.
    expect(out).not.toContain('mcp__');
  });

  it('RenderBindingBlock_WrapsInMarkers_FencedIdempotent', () => {
    const out = renderBindingBlock(NEUTRAL_BODY);
    expect(out.startsWith(BINDING_MARKER_START)).toBe(true);
    expect(out.trimEnd().endsWith(BINDING_MARKER_END)).toBe(true);
    // Idempotent: the markers let a re-render replace the fenced region exactly.
    expect(out.indexOf(BINDING_MARKER_START)).toBe(
      out.lastIndexOf(BINDING_MARKER_START),
    );
    // Pure render → a second pass with the same input is byte-identical.
    expect(renderBindingBlock(NEUTRAL_BODY)).toBe(out);
  });

  it('RenderBindingBlock_StrayPlaceholder_ThrowsGuard', () => {
    // The block is runtime-neutral, so any reintroduced `{{TOKEN}}` is a build
    // error rather than a literal token silently shipped into the block.
    expect(() =>
      renderBindingBlock('Route through `{{MCP_PREFIX}}exarchos_workflow`.'),
    ).toThrow(/unknown placeholder/i);
  });
});
