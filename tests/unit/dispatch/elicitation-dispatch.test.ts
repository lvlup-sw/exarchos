/** Tests for the elicitation hand-off that dispatch uses for a missing required parameter. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { EventStore } from '../../../src/events/store.js';
import { createInMemoryResolver } from '../../../src/workflow/capabilities/resolver.js';
import {
  performElicitation,
  type ElicitationClient,
} from '../../../src/dispatch/elicitation-dispatch.js';
import { dispatch, stubCompositeHandler } from '../../../src/dispatch/core/dispatch.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

describe('elicitation-dispatch (#1274)', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'elicit-dispatch-test-'));
    eventStore = new EventStore(tmpDir);
    await eventStore.initialize();
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /**
   * The request schema holds only the missing field. The test calls `performElicitation` directly
   * with a fake client.
   */
  it('Dispatch_MissingRequiredParamWithElicitation_SendsElicitationCreate', async () => {
    const inputSchema = z.object({
      featureId: z.string(),
      target: z.string(),
    });

    let captured:
      | {
          field: string;
          schema: Record<string, unknown>;
        }
      | undefined;
    const client: ElicitationClient = {
      async create({ field, schema }) {
        captured = { field, schema };
        return { value: 'elicited-feature' };
      },
    };

    const result = await performElicitation({
      inputSchema,
      missingField: 'featureId',
      client,
      eventStore,
      operationId: 'op-1',
    });

    expect(result.fulfilled).toBe(true);
    expect(result.value).toBe('elicited-feature');
    expect(captured).toBeDefined();
    expect(captured!.field).toBe('featureId');
    const props = captured!.schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['featureId']);
  });

  /**
   * The resolver declares no elicitation capability, and the `get` call omits its required
   * `featureId`. Validation then returns `INVALID_INPUT`, and dispatch never calls the stubbed
   * handler.
   */
  it('Dispatch_MissingRequiredParamNoCapability_ReturnsInvalidInputFallback', async () => {
    const resolver = createInMemoryResolver([]);
    expect(resolver.isElicitationDeclared()).toBe(false);

    let handlerCalled = false;
    const restore = stubCompositeHandler('exarchos_workflow', async () => {
      handlerCalled = true;
      return { success: true, data: {} };
    });

    try {
      const result = await dispatch(
        'exarchos_workflow',
        { action: 'get' },
        {
          stateDir: tmpDir,
          eventStore,
          enableTelemetry: false,
          capabilityResolver: resolver,
        },
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_INPUT');
      expect(handlerCalled).toBe(false);
    } finally {
      restore();
    }
  });

  /**
   * Both events go to the pseudo-stream `elicitation/<operationId>` and carry the same
   * `operationId`.
   */
  it('Elicitation_RequestedAndFulfilled_EmitEventsWithOperationId', async () => {
    const inputSchema = z.object({
      featureId: z.string(),
    });
    const client: ElicitationClient = {
      async create() {
        return { value: 'feature-x' };
      },
    };

    await performElicitation({
      inputSchema,
      missingField: 'featureId',
      client,
      eventStore,
      operationId: 'op-correlated',
    });

    const events = await eventStore.query('elicitation/op-correlated');
    const requested = events.find((e) => e.type === 'elicitation.requested');
    const fulfilled = events.find((e) => e.type === 'elicitation.fulfilled');

    expect(requested).toBeDefined();
    expect(fulfilled).toBeDefined();

    const requestedData = requested!.data as { operationId: string; field: string };
    const fulfilledData = fulfilled!.data as { operationId: string; field: string };

    expect(requestedData.operationId).toBe('op-correlated');
    expect(fulfilledData.operationId).toBe('op-correlated');
    expect(requestedData.operationId).toBe(fulfilledData.operationId);
    expect(requestedData.field).toBe('featureId');
    expect(fulfilledData.field).toBe('featureId');
  });

  /**
   * A client that returns `undefined` declined. The hand-off then emits `elicitation.declined` and
   * no `elicitation.fulfilled`, so the audit trail separates the two outcomes.
   */
  it('PerformElicitation_ClientDeclines_EmitsElicitationDeclinedNotFulfilled', async () => {
    const inputSchema = z.object({ featureId: z.string() });
    const decliningClient: ElicitationClient = {
      async create() {
        return { value: undefined };
      },
    };

    const result = await performElicitation({
      inputSchema,
      missingField: 'featureId',
      client: decliningClient,
      eventStore,
      operationId: 'op-declined',
    });

    expect(result.fulfilled).toBe(false);
    expect(result.value).toBeUndefined();

    const events = await eventStore.query('elicitation/op-declined');
    const requested = events.find((e) => e.type === 'elicitation.requested');
    const declined = events.find((e) => e.type === 'elicitation.declined');
    const fulfilled = events.find((e) => e.type === 'elicitation.fulfilled');

    expect(requested).toBeDefined();
    expect(declined).toBeDefined();
    expect(fulfilled).toBeUndefined();
    const declinedData = declined!.data as { operationId: string; field: string };
    expect(declinedData.operationId).toBe('op-declined');
    expect(declinedData.field).toBe('featureId');
  });
});
