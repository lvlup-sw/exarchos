/**
 * Tests for the elicitation round trip through `createElicitationTestPair`.
 * A smoke test covers the fixture. Three path tests cover accept, decline and capability absent.
 * Each path test asserts on the envelope and on the event store.
 */

import { describe, it, expect, vi } from 'vitest';
import { createElicitationTestPair } from './elicitation-roundtrip.fixture.js';

describe('#1436 — elicitation-roundtrip fixture smoke', () => {
  /**
   * The default arguments declare no client capability and attach no handler.
   * The handshake must complete, and the server must list at least one tool. The path tests depend on this wiring.
   */
  it('CreateElicitationTestPair_DefaultArgs_HandshakeSucceeds', async () => {
    const pair = await createElicitationTestPair({});
    try {
      const { tools } = await pair.client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await pair.cleanup();
    }
  });
});

/**
 * The client declares `capabilities.elicitation: {}`. Dispatch finds no `featureId` on `exarchos_workflow init` and starts the hand-off.
 * The mock handler accepts with a valid `featureId`, and dispatch validates again with that value.
 * `elicitation.requested` and `elicitation.fulfilled` must be on the stream of the operation.
 */
describe('#1436 — elicitation-roundtrip accept path', () => {
  /**
   * The call omits only `featureId`, because `extractSingleMissingRequiredField` matches exactly one missing required field.
   * The handler runs one time: the hand-off is one round trip with no retry.
   * The stream name is `elicitation/<operationId>`, with the `operationId` from the `_meta` of the envelope.
   */
  it('ElicitationRoundtrip_AcceptPath_EnvelopeSuccessAndEventsLanded', async () => {
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
      const result = (await pair.client.callTool({
        name: 'exarchos_workflow',
        arguments: { action: 'init', workflowType: 'feature' },
      })) as {
        structuredContent?: {
          success?: boolean;
          _meta?: { operationId?: string };
        };
      };

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(true);

      expect(elicitInputHandler).toHaveBeenCalledTimes(1);

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

/**
 * The client declares elicitation, and the mock handler declines.
 * The hand-off emits `elicitation.declined`, and dispatch returns the `INVALID_INPUT` envelope with no retry.
 * The `init` handler must not run, so no `workflow.started` event exists.
 */
describe('#1436 — elicitation-roundtrip decline path', () => {
  /**
   * The call passes no `featureId`, so a query for one workflow stream by name proves nothing.
   * The event store is new for each test. Thus any stream outside `elicitation/` after the decline shows a retry, with any `featureId`.
   * `elicitation.declined` and `elicitation.fulfilled` are exclusive end states, so the stream must hold no `elicitation.fulfilled` event.
   */
  it('ElicitationRoundtrip_DeclinePath_InvalidInputEnvelopeAndDeclinedEventLanded', async () => {
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

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(false);
      expect(result.structuredContent?.error?.code).toBe('INVALID_INPUT');

      expect(elicitInputHandler).toHaveBeenCalledTimes(1);

      const operationId = result.structuredContent?._meta?.operationId;
      expect(operationId).toBeDefined();

      const events = await pair.eventStore.query(
        `elicitation/${operationId}`,
      );
      const eventTypes = events.map((e) => e.type);
      expect(eventTypes).toContain('elicitation.requested');
      expect(eventTypes).toContain('elicitation.declined');
      expect(eventTypes).not.toContain('elicitation.fulfilled');

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

/**
 * The client does not declare the `elicitation` capability, so `isElicitationDeclared()` is false and dispatch skips the hand-off.
 * Dispatch returns the `INVALID_INPUT` envelope for the missing required field.
 * No `elicitation/` stream gets an event, and the mock handler never runs.
 */
describe('#1436 — elicitation-roundtrip capability-absent path', () => {
  /**
   * The fixture registers no client request handler when the capability is absent.
   * The test still passes an `elicitInputHandler` and asserts that nothing calls it.
   * The event store and the envelope must agree: no `elicitation/` stream, and `INVALID_INPUT`.
   */
  it('ElicitationRoundtrip_CapabilityAbsent_LegacyInvalidInputAndNoElicitationEvents', async () => {
    const elicitInputHandler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { featureId: 'test-capability-absent-handler-should-not-fire' },
    }));

    const pair = await createElicitationTestPair({
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

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent?.success).toBe(false);
      expect(result.structuredContent?.error?.code).toBe('INVALID_INPUT');

      expect(elicitInputHandler).not.toHaveBeenCalled();

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
