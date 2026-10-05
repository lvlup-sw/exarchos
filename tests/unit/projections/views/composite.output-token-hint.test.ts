/**
 * End-to-end test of the `output_tokens_high` hint. A `turn.completed` event above
 * the output-token threshold makes the `telemetry` view return one `checkpoint`
 * entry in `next_actions`. A turn below the threshold returns none. The test uses
 * the real `envelopeWrap`, so a break between the projection and the envelope fails.
 */

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

/** `sequence` is unused and only labels the call site, because `append` assigns the sequence. */
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

  /** 30000 is more than the default threshold of 25600, which is 0.8 of the 32000 cap. */
  it('CompositeViewTelemetry_AboveThreshold_HintInNextActions', async () => {
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

  /** 10000 is less than the default threshold of 25600. */
  it('CompositeViewTelemetry_BelowThreshold_NoHint', async () => {
    await emitTurn(ctx.eventStore, 1, 'e2e-below-1', 10000);

    const result = (await handleView({ action: 'telemetry' }, ctx)) as MaybeEnvelope;
    expect(result.success).toBe(true);

    const hintEntries = (result.next_actions ?? []).filter(
      (a) => a.verb === 'checkpoint',
    );
    expect(hintEntries).toHaveLength(0);
  });
});
