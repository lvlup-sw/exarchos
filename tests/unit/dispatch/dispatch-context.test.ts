/**
 * Tests for `mintDispatchContext`, which mints the three correlation ids of one dispatch:
 * `operationId`, `correlationId` and `causationId`.
 */

import { describe, it, expect } from 'vitest';
import { mintDispatchContext } from '../../../src/dispatch/dispatch-context.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('mintDispatchContext (T18, #1291)', () => {
  it('DispatchContext_NewDispatch_MintsFreshOperationId', () => {
    const ctx = mintDispatchContext();
    expect(ctx.operationId).toMatch(UUID_RE);
    const ctx2 = mintDispatchContext();
    expect(ctx2.operationId).not.toBe(ctx.operationId);
  });

  /** The correlation id crosses the dispatch boundary unchanged. The `operationId` is still new. */
  it('DispatchContext_IncomingCorrelationId_Inherits', () => {
    const upstreamCorrelation = '11111111-2222-3333-4444-555555555555';
    const ctx = mintDispatchContext({ correlationId: upstreamCorrelation });
    expect(ctx.correlationId).toBe(upstreamCorrelation);
    expect(ctx.operationId).not.toBe(upstreamCorrelation);
    expect(ctx.operationId).toMatch(UUID_RE);
  });

  /**
   * With no upstream correlation, the operation is the chain root, so each context has a
   * `correlationId`.
   */
  it('DispatchContext_NoIncomingCorrelation_SelfBindsToOperationId', () => {
    const ctx = mintDispatchContext();
    expect(ctx.correlationId).toBe(ctx.operationId);
  });

  /**
   * A follow-up dispatch passes the upstream event id as `causationId`, and the new context keeps
   * it.
   */
  it('DispatchContext_AutoDispatchedFromNextActions_CausationIdResolvesToUpstreamEvent', () => {
    const upstreamEventId = 'event-upstream-7';
    const correlationFromChain = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    const ctx = mintDispatchContext({
      correlationId: correlationFromChain,
      causationId: upstreamEventId,
    });
    expect(ctx.causationId).toBe(upstreamEventId);
    expect(ctx.correlationId).toBe(correlationFromChain);
    expect(ctx.operationId).toMatch(UUID_RE);
    expect(ctx.operationId).not.toBe(upstreamEventId);
    expect(ctx.operationId).not.toBe(correlationFromChain);
  });

  /**
   * A chain root has no cause, so `causationId` stays undefined and does not take the
   * `operationId`.
   */
  it('DispatchContext_NoIncoming_CausationIdIsUndefined', () => {
    const ctx = mintDispatchContext();
    expect(ctx.causationId).toBeUndefined();
  });
});
