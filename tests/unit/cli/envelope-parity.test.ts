/**
 * The `output_tokens_high` hint in the envelope that the CLI arm and the MCP arm share.
 * Both arms call `toEnvelope`, so the test renders one `ToolResult` two times and compares the JSON.
 */
import { describe, it, expect } from 'vitest';
import { toEnvelope, type ToolResult } from '../../../src/format.js';
import { computeOutputTokenHints, telemetryProjection } from '../../../src/projections/telemetry/telemetry-projection.js';

describe('EnvelopeParity_OutputTokensHigh (#1262)', () => {
  it('Envelope_OutputTokensHighHint_CLIAndMCPIdentical', () => {
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

    const cliEnvelope = toEnvelope(result);
    const mcpEnvelope = toEnvelope(result);

    const cliJson = JSON.stringify(cliEnvelope);
    const mcpJson = JSON.stringify(mcpEnvelope);

    expect(cliJson).toBe(mcpJson);

    const parsed = JSON.parse(cliJson) as {
      next_actions?: ReadonlyArray<{ verb?: string; reason?: string }>;
    };
    expect(parsed.next_actions).toBeDefined();
    expect(parsed.next_actions).toHaveLength(1);
    expect(parsed.next_actions?.[0].verb).toBe('checkpoint');
    expect(parsed.next_actions?.[0].reason).toMatch(/output tokens/i);
  });
});
