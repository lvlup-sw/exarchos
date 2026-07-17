// ─── T3 / #1436 — Elicitation form-mode E2E fixture smoke test ──────────────
//
// Sanity-only test for the fixture itself. The accept / decline / capability-
// absent path tests (T4 / T5 / T6) build on `createElicitationTestPair`, so a
// failure here would cascade across the substrate-realization wave. This
// test proves the wiring works end-to-end (handshake + tool registration)
// before the path tests layer assertions on top.
//
// Design: `docs/designs/archive/2026-05-17-preview-4-substrate-realization.md` §4.1.

import { describe, it, expect, vi } from 'vitest';
import { createElicitationTestPair } from './elicitation-roundtrip.fixture.js';

describe('#1436 — elicitation-roundtrip fixture smoke', () => {
  it('CreateElicitationTestPair_DefaultArgs_HandshakeSucceeds', async () => {
    // Default-args path: no client capabilities declared, no elicitation
    // handler attached. Verifies the InMemoryTransport handshake completes
    // and the server advertises a non-empty `tools/list` (matches the
    // production registry shape — `exarchos_workflow`, `exarchos_event`,
    // etc.). If this fails, T4 / T5 / T6 are blocked.
    const pair = await createElicitationTestPair({});
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await pair.cleanup();
    }
  });
});

// ─── T4 / #1436 — Accept path ─────────────────────────────────────────────
//
// Client declares `capabilities.elicitation: {}` at handshake; the server's
// dispatch boundary detects the missing `featureId` on `exarchos_workflow
// init`, routes through the elicitation hand-off, the test's mock handler
// returns `action: 'accept'` with a valid `featureId`, and dispatch retries
// the validation with the spliced value. Closes the verification gap from
// PR #1424 by asserting BOTH the envelope outcome AND the event-store
// truth (`elicitation.requested` + `elicitation.fulfilled` on the
// per-operation stream, sharing the dispatch's `_meta.operationId`).
//
// Substrate is believed correct after PR #1424 + CodeRabbit fix; this test
// SHOULD pass on first run.
describe('#1436 — elicitation-roundtrip accept path', () => {
  it('ElicitationRoundtrip_AcceptPath_EnvelopeSuccessAndEventsLanded', async () => {
    // Random suffix avoids collisions with any same-test re-runs sharing
    // the substrate (the EventStore is per-test, but the workflow.started
    // event's featureId is what dispatch-side stream-naming keys on, so
    // a unique id keeps audit-trail noise out of subsequent assertions).
    const featureId = `test-accept-${Math.random().toString(36).slice(2, 10)}`;

    const elicitInputHandler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { featureId },
    }));

    const pair = await createElicitationTestPair({
      clientCapabilities: { elicitation: {} },
      elicitInputHandler,
    });

    try {
      // `featureId` is OMITTED — the schema requires it, so dispatch will
      // detect the single-missing-required-field condition and route
      // through `performElicitation`. `workflowType` IS supplied so the
      // missing-field count is exactly one (the `extractSingleMissing-
      // RequiredField` gate at `dispatch.ts:151` only fires for exactly
      // one missing required field).
      const result = (await pair.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', workflowType: 'feature' },
      })) as {
        structuredContent?: {
          success?: boolean;
          _meta?: { operationId?: string };
        };
      };

      // Envelope: success — workflow created via the elicitation hand-off.
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(true);

      // Mock handler should have been invoked exactly once (the
      // elicitation hand-off is a single round-trip; no retry loop).
      expect(elicitInputHandler).toHaveBeenCalledTimes(1);

      // Event-store truth — both lifecycle events land on the per-operation
      // pseudo-stream `elicitation/<operationId>`. The operationId on the
      // envelope's `_meta` must match the prefix used to name the stream
      // (Sentry MEDIUM #1428 cross-stream correlation contract).
      const operationId = result.structuredContent?._meta?.operationId;
      expect(operationId).toBeDefined();
      expect(typeof operationId).toBe('string');

      const events = await pair.eventStore.query(
        `elicitation/${operationId}`,
      );
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('elicitation.requested');
      expect(eventTypes).toContain('elicitation.fulfilled');
    } finally {
      await pair.cleanup();
    }
  });
});

// ─── T5 / #1436 — Decline path ────────────────────────────────────────────
//
// Client declares elicitation but the mock handler returns `decline`. The
// dispatch hand-off emits `elicitation.declined` (the typed-event split
// from CodeRabbit MEDIUM #1424 at `dispatch/elicitation-dispatch.ts:122-126`)
// and falls back to the legacy INVALID_INPUT envelope rather than retrying.
//
// The decline path also verifies that the underlying `init` handler is NOT
// invoked: the elicitation gate runs to its un-fulfilled terminal state
// without splicing a value and re-validating, so `workflow.started` is
// never emitted. Because the fixture's EventStore is fresh per test, the
// hermetic post-decline state contains ONLY the per-operation
// `elicitation/<operationId>` stream — any other stream signals a bug
// (e.g., a substrate that retried after decline, with any featureId).
describe('#1436 — elicitation-roundtrip decline path', () => {
  it('ElicitationRoundtrip_DeclinePath_InvalidInputEnvelopeAndDeclinedEventLanded', async () => {
    // NOTE: no featureId is supplied to the dispatch call (the entire point
    // of the decline path is that the elicitation gate fires precisely
    // because `featureId` is the missing required field). Per CodeRabbit C4,
    // an earlier revision queried the event store for a randomly-generated
    // `test-decline-*` featureId that was NEVER actually passed to dispatch
    // — which made the "no retry" assertion trivially true (it would have
    // passed even if a buggy substrate WAS retrying with some other
    // featureId). The replacement assertion below targets the substrate's
    // actual observable signal: workflow.started is the init handler's
    // first emission, and the substrate is keyed on per-test EventStore,
    // so a hermetic post-decline state has ZERO workflow streams.

    const elicitInputHandler = vi.fn(async () => ({
      action: 'decline' as const,
    }));

    const pair = await createElicitationTestPair({
      clientCapabilities: { elicitation: {} },
      elicitInputHandler,
    });

    try {
      const result = (await pair.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', workflowType: 'feature' },
      })) as {
        structuredContent?: {
          success?: boolean;
          error?: { code?: string };
          _meta?: { operationId?: string };
        };
      };

      // Envelope: legacy INVALID_INPUT — the elicitation gate detected the
      // decline and fell through to the validation-failure return at
      // `core/dispatch.ts:859-862`.
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(false);
      expect(result.structuredContent?.error?.code).toBe('INVALID_INPUT');

      // The mock handler was invoked once — the elicitation round-trip
      // happened but the client refused to supply a value. No retry.
      expect(elicitInputHandler).toHaveBeenCalledTimes(1);

      // Event-store truth — the typed `elicitation.declined` event lands
      // on the per-operation stream. This is the CodeRabbit MEDIUM fix:
      // pre-fix the decline path emitted `elicitation.fulfilled` with an
      // undefined value, making audit consumers unable to discriminate a
      // genuine refusal from a value-shape error.
      const operationId = result.structuredContent?._meta?.operationId;
      expect(operationId).toBeDefined();

      const events = await pair.eventStore.query(
        `elicitation/${operationId}`,
      );
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('elicitation.requested');
      expect(eventTypes).toContain('elicitation.declined');
      // And NO `elicitation.fulfilled` — these are mutually exclusive
      // terminal states per the dispatch helper's contract.
      expect(eventTypes).not.toContain('elicitation.fulfilled');

      // No-retry assertion via the event store: the init handler is the
      // first (and only) emitter of `workflow.started` in this dispatch
      // path. If the substrate buggily retried after the decline (with any
      // featureId — synthesized, stale, or otherwise), a workflow stream
      // would land on the per-test EventStore. The fixture's EventStore
      // is fresh per call, so the post-decline hermetic state has ZERO
      // workflow streams. Any non-elicitation stream is a bug.
      //
      // (Prior revision queried a random `test-decline-*` featureId that
      // was never passed to dispatch — see CodeRabbit C4. That assertion
      // was trivially satisfied because the queried id never appeared in
      // any code path; the assertion below is provable: it fails if the
      // substrate creates a workflow stream by any means.)
      const allStreams = pair.eventStore.listStreams();
      const workflowStreams = allStreams.filter(
        (s) => !s.startsWith('elicitation/'),
      );
      expect(workflowStreams).toEqual([]);
    } finally {
      await pair.cleanup();
    }
  });
});

// ─── T6 / #1436 — Capability-absent path ──────────────────────────────────
//
// Client does NOT declare the `elicitation` capability. The dispatch-side
// gate at `core/dispatch.ts:813-815` short-circuits because
// `ctx.capabilityResolver.isElicitationDeclared()` returns false; the
// elicitation hand-off is skipped entirely and dispatch returns the
// legacy INVALID_INPUT envelope on the missing required field.
//
// Critical assertions:
//   • NO events on any `elicitation/*` stream (the substrate does not
//     attempt the round-trip).
//   • The mock handler we registered is never invoked (the SDK never
//     sends an `elicitation/create` request because the client lacks
//     the capability declaration).
describe('#1436 — elicitation-roundtrip capability-absent path', () => {
  it('ElicitationRoundtrip_CapabilityAbsent_LegacyInvalidInputAndNoElicitationEvents', async () => {
    // No `clientCapabilities.elicitation` → resolver records
    // `isElicitationDeclared() === false`. Per the fixture contract, the
    // client-side `setRequestHandler(ElicitRequestSchema, …)` is NOT
    // registered when the capability is absent — matching real clients
    // that don't support elicitation.
    //
    // We still pass an `elicitInputHandler` so we can assert it was never
    // called (the SDK won't deliver an `elicitation/create` request
    // without the capability declaration, so the handler is effectively
    // dead code — exactly what we want to verify).
    const elicitInputHandler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { featureId: 'test-capability-absent-handler-should-not-fire' },
    }));

    const pair = await createElicitationTestPair({
      // No clientCapabilities → no elicitation capability declared.
      elicitInputHandler,
    });

    try {
      const result = (await pair.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', workflowType: 'feature' },
      })) as {
        structuredContent?: {
          success?: boolean;
          error?: { code?: string };
        };
      };

      // Envelope: legacy INVALID_INPUT — exactly the pre-#1274 behavior
      // for a missing required field. The elicitation gate is dark.
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(false);
      expect(result.structuredContent?.error?.code).toBe('INVALID_INPUT');

      // The mock handler is unreachable because no `setRequestHandler` is
      // registered on the client (per fixture contract when elicitation
      // capability is absent). Even if it were registered, the server
      // never issues `elicitation/create` because the capability gate
      // is closed dispatch-side.
      expect(elicitInputHandler).not.toHaveBeenCalled();

      // No `elicitation/*` stream activity at all — the round-trip was
      // never attempted, so `elicitation.requested` was never emitted.
      // This is the INV-1 closure for the capability-absent path:
      // event-stream truth (no events) and envelope truth (legacy
      // INVALID_INPUT) agree, end-to-end.
      const allStreams = pair.eventStore.listStreams();
      const elicitationStreams = allStreams.filter((s) =>
        s.startsWith('elicitation/'),
      );
      expect(elicitationStreams).toEqual([]);
    } finally {
      await pair.cleanup();
    }
  });
});
