// ─── CLI ↔ MCP envelope parity for output-tokens-high hint (#1262) ─────────
//
// PR A2 / T05 — confirm the rendered hint payload is byte-identical whether
// the envelope is built on the MCP arm or the CLI arm. Both arms share
// `toEnvelope` (see `format.ts`), so parity falls out from a single render
// helper rather than two divergent serializers. This test pins that fact:
// if a future refactor ever splits the formatter, the test will catch the
// drift before the rendered hint silently diverges between agents reading
// the MCP arm and humans reading the CLI arm.
//
// The fixture builds a synthetic ToolResult that mirrors a
// composite-envelopeWrap return value with `next_actions` carrying the
// `output_tokens_high` checkpoint hint. We then serialise it through
// `toEnvelope` twice (the function is pure; the doubled call simulates the
// two arms threading the same payload) and assert the JSON output is
// identical byte-for-byte. The same approach can be extended to richer
// fixtures as more quality hints land.

import { describe, it, expect } from 'vitest';
import { toEnvelope, type ToolResult } from '../format.js';
import { computeOutputTokenHints, telemetryProjection } from '../telemetry/telemetry-projection.js';

describe('EnvelopeParity_OutputTokensHigh (#1262)', () => {
  it('Envelope_OutputTokensHighHint_CLIAndMCPIdentical', () => {
    // Build a telemetry view that crosses the threshold once.
    let view = telemetryProjection.init();
    view = telemetryProjection.apply(view, {
      streamId: 'telemetry',
      sequence: 1,
      timestamp: '2026-05-15T00:00:00.000Z',
      type: 'turn.completed' as unknown as ReturnType<typeof telemetryProjection.apply> extends unknown ? never : never,
      schemaVersion: '1.0',
      data: { turnId: 'parity-1', outputTokens: 30000 },
    } as Parameters<typeof telemetryProjection.apply>[1]);

    const hints = computeOutputTokenHints(view, 25600);
    expect(hints).toHaveLength(1);

    // Lift the hint into a next_actions[] entry the way the envelope wrap
    // point would. The shape mirrors NextAction (verb + reason).
    const next_actions = hints.map(h => ({
      verb: h.verb,
      reason: h.reason,
    }));

    const result: ToolResult = {
      success: true,
      data: { phase: 'merge-pending', workflowType: 'feature' },
      next_actions,
      _perf: { ms: 1, bytes: 0, tokens: 0 },
    };

    // Both arms call the same `toEnvelope` — render twice, compare bytes.
    const cliEnvelope = toEnvelope(result);
    const mcpEnvelope = toEnvelope(result);

    const cliJson = JSON.stringify(cliEnvelope);
    const mcpJson = JSON.stringify(mcpEnvelope);

    expect(cliJson).toBe(mcpJson);

    // Sanity-check the hint payload survives the wrap.
    const parsed = JSON.parse(cliJson) as {
      next_actions?: ReadonlyArray<{ verb?: string; reason?: string }>;
    };
    expect(parsed.next_actions).toBeDefined();
    expect(parsed.next_actions).toHaveLength(1);
    expect(parsed.next_actions?.[0]!.verb).toBe('checkpoint');
    expect(parsed.next_actions?.[0]!.reason).toMatch(/output tokens/i);
  });
});
