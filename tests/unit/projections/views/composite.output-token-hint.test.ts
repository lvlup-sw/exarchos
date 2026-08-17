// ─── End-to-end test: output_tokens_high hint surfaces in next_actions ─────
//
// PR A2 follow-up (#1262). The catalog + projection + threshold resolver
// landed in the parent commits; this test pins the *end-to-end* contract:
//
//   1. Per-turn `turn.completed` events with `outputTokens` above threshold
//      are appended to the telemetry stream.
//   2. The composite `exarchos_view` `telemetry` action dispatches through
//      `handleView`, which calls `envelopeWrap`.
//   3. The returned envelope's `next_actions[]` contains a single entry
//      with `verb: 'checkpoint'` and a `reason` mentioning output tokens.
//
// And the below-threshold mirror: no such entry.
//
// The test exercises real envelope wrapping (no vi.mock of the wrap helper)
// so a future refactor that breaks the wire cannot pass this test by
// accident.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DispatchContext } from '../../../../src/dispatch/core/dispatch.js';
import { EventStore } from '../../../../src/events/store.js';
import { handleView } from '../../../../src/projections/views/composite.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

interface MaybeEnvelope {
  success?: boolean;
  next_actions?: ReadonlyArray<{ verb?: string; reason?: string }>;
}

async function emitTurn(
  store: EventStore,
  sequence: number,
  turnId: string,
  outputTokens: number,
): Promise<void> {
  await store.append('telemetry', {
    type: 'turn.completed',
    data: { turnId, outputTokens },
  });
  // sequence param is unused — append returns its own sequence; kept for
  // call-site readability of the test scenario.
  void sequence;
}

describe('CompositeViewTelemetry_OutputTokenHint_EndToEnd (#1262)', () => {
  let stateDir: string;
  let ctx: DispatchContext;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'output-token-hint-e2e-'));
    ctx = {
      stateDir,
      eventStore: new EventStore(stateDir),
      enableTelemetry: false,
    };
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('CompositeViewTelemetry_AboveThreshold_HintInNextActions', async () => {
    // 30000 > default threshold (32000 * 0.8 = 25600) → hint fires.
    await emitTurn(ctx.eventStore, 1, 'e2e-above-1', 30000);

    const result = (await handleView({ action: 'telemetry' }, ctx)) as MaybeEnvelope;
    expect(result.success).toBe(true);
    expect(Array.isArray(result.next_actions)).toBe(true);

    const hintEntries = (result.next_actions ?? []).filter(
      (a) => a.verb === 'checkpoint',
    );
    expect(hintEntries).toHaveLength(1);
    expect(hintEntries[0].reason).toMatch(/output tokens/i);
  });

  it('CompositeViewTelemetry_BelowThreshold_NoHint', async () => {
    // 10000 < 25600 → no hint.
    await emitTurn(ctx.eventStore, 1, 'e2e-below-1', 10000);

    const result = (await handleView({ action: 'telemetry' }, ctx)) as MaybeEnvelope;
    expect(result.success).toBe(true);

    const hintEntries = (result.next_actions ?? []).filter(
      (a) => a.verb === 'checkpoint',
    );
    expect(hintEntries).toHaveLength(0);
  });
});
