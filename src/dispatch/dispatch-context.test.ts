// ─── T18 (#1291) — DispatchContext primitive ────────────────────────────────
//
// RED for the three-field dispatch-boundary correlation primitive. Each test
// pins one behavior of `mintDispatchContext`:
//
//   1. `mintDispatchContext()` with no incoming IDs MUST produce a fresh
//      `operationId` and (because nothing else can serve as the
//      correlation anchor) self-bind `correlationId === operationId`.
//   2. When the caller supplies an `incoming.correlationId`, the new
//      context inherits it verbatim (the correlation chain crosses
//      dispatch boundaries unchanged) while `operationId` is freshly
//      minted (every dispatch is its own operation).
//   3. When the caller supplies an `incoming.causationId`, it threads
//      through. `causationId` is the immediate upstream event id, not
//      the chain root, so it survives one hop and is the caller's
//      responsibility to update on each emission.
//   4. The minted `operationId` is a UUID-shaped string (the three IDs
//      go on the wire and into the event-store schema; mint must
//      produce a value that parses against `z.string().uuid()`).
//
// GREEN materializes alongside `dispatch-context.ts` (T19 dependency).

import { describe, it, expect } from 'vitest';
import { mintDispatchContext } from './dispatch-context.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('mintDispatchContext (T18, #1291)', () => {
  it('DispatchContext_NewDispatch_MintsFreshOperationId', () => {
    const ctx = mintDispatchContext();
    expect(ctx.operationId).toMatch(UUID_RE);
    // A second mint must produce a distinct operationId — every dispatch
    // boundary is its own operation, no accidental reuse across the
    // module.
    const ctx2 = mintDispatchContext();
    expect(ctx2.operationId).not.toBe(ctx.operationId);
  });

  it('DispatchContext_IncomingCorrelationId_Inherits', () => {
    const upstreamCorrelation = '11111111-2222-3333-4444-555555555555';
    const ctx = mintDispatchContext({ correlationId: upstreamCorrelation });
    expect(ctx.correlationId).toBe(upstreamCorrelation);
    // operationId is still freshly minted — correlation crosses
    // dispatches; operation does not.
    expect(ctx.operationId).not.toBe(upstreamCorrelation);
    expect(ctx.operationId).toMatch(UUID_RE);
  });

  it('DispatchContext_NoIncomingCorrelation_SelfBindsToOperationId', () => {
    const ctx = mintDispatchContext();
    // When no upstream correlation exists, the operation is the root of
    // the chain: `correlationId === operationId`. This guarantees every
    // emitted event has a non-undefined correlationId.
    expect(ctx.correlationId).toBe(ctx.operationId);
  });

  it('DispatchContext_AutoDispatchedFromNextActions_CausationIdResolvesToUpstreamEvent', () => {
    // Simulate a HATEOAS next_actions follow-up: an upstream tool emitted
    // an event with id `event-upstream-7`, and dispatch resolves the
    // next_action by passing the upstream event id as `causationId`. The
    // new context preserves that linkage so audit queries can walk the
    // causal chain.
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

  it('DispatchContext_NoIncoming_CausationIdIsUndefined', () => {
    // Without an upstream cause, causationId is left undefined rather
    // than self-bound. operationId is the operation root, not the cause
    // root — there is no canonical "no cause" sentinel.
    const ctx = mintDispatchContext();
    expect(ctx.causationId).toBeUndefined();
  });
});
