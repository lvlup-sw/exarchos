import { describe, it, expect } from 'vitest';
import {
  renderBindingBlock,
  BINDING_MARKER_START,
  BINDING_MARKER_END,
} from '../../../src/install/binding.js';

/** A directive body in the runtime-neutral `exarchos:exarchos_*` form. It holds no `{{...}}` token. */
const NEUTRAL_BODY =
  'Route workflow operations through the `exarchos:exarchos_workflow` MCP tool.';

describe('renderBindingBlock (#1485 T3; neutralized DR-5)', () => {
  /** The output keeps the logical tool name. It holds no placeholder token and no per-harness `mcp__` prefix. */
  it('renderBindingBlock_NoPlaceholders_RuntimeNeutralOutput', () => {
    const out = renderBindingBlock(NEUTRAL_BODY);
    expect(out).toContain('exarchos:exarchos_workflow');
    expect(out).not.toContain('{{');
    expect(out).not.toContain('}}');
    expect(out).not.toContain('mcp__');
  });

  /** The start marker occurs one time, so a second render can replace the fenced region. The render is pure. */
  it('RenderBindingBlock_WrapsInMarkers_FencedIdempotent', () => {
    const out = renderBindingBlock(NEUTRAL_BODY);
    expect(out.startsWith(BINDING_MARKER_START)).toBe(true);
    expect(out.trimEnd().endsWith(BINDING_MARKER_END)).toBe(true);
    expect(out.indexOf(BINDING_MARKER_START)).toBe(
      out.lastIndexOf(BINDING_MARKER_START),
    );
    expect(renderBindingBlock(NEUTRAL_BODY)).toBe(out);
  });

  /** A `{{TOKEN}}` in the body is a build error. The literal token does not go into the block. */
  it('RenderBindingBlock_StrayPlaceholder_ThrowsGuard', () => {
    expect(() =>
      renderBindingBlock('Route through `{{MCP_PREFIX}}exarchos_workflow`.'),
    ).toThrow(/unknown placeholder/i);
  });
});
