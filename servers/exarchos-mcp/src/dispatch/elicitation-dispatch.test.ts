// ─── #1274 — Dispatch missing-required-param elicitation tests ──────────────

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { EventStore } from '../events/store.js';
import { createInMemoryResolver } from '../capabilities/resolver.js';
import {
  performElicitation,
  type ElicitationClient,
} from './elicitation-dispatch.js';
import { dispatch, stubCompositeHandler } from './core/dispatch.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('Dispatch_MissingRequiredParamWithElicitation_SendsElicitationCreate', async () => {
    // Client declares the elicitation capability; dispatch routes missing
    // required params through the elicitation hand-off and the resulting
    // request carries a `.pick()`-derived schema for the missing field.
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
    // Schema must be `.pick({featureId: true})` shape — single property.
    const props = captured!.schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['featureId']);
  });

  it('Dispatch_MissingRequiredParamNoCapability_ReturnsInvalidInputFallback', async () => {
    // Without elicitation capability on the resolver, dispatch must NOT
    // attempt the hand-off — the existing INVALID_INPUT contract from
    // per-action Zod validation remains the user-visible envelope.
    const resolver = createInMemoryResolver([]);
    expect(resolver.isElicitationDeclared()).toBe(false);

    // Stub the composite so we can prove no handler is invoked.
    let handlerCalled = false;
    const restore = stubCompositeHandler('exarchos_workflow', async () => {
      handlerCalled = true;
      return { success: true, data: {} };
    });

    try {
      // `get` requires `featureId`; we omit it. With no elicitation
      // capability, the per-action validator surfaces INVALID_INPUT and
      // dispatch never reaches the (stubbed) handler.
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

  it('Elicitation_RequestedAndFulfilled_EmitEventsWithOperationId', async () => {
    // Both events emit through the event store and share the same
    // operationId so downstream queries can correlate request/response.
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

    // Query the event store for both events. Elicitation events live on
    // the per-operation pseudo-stream `elicitation/<operationId>` so the
    // query is bounded and deterministic.
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

  it('PerformElicitation_ClientDeclines_EmitsElicitationDeclinedNotFulfilled', async () => {
    // Sentry MEDIUM #1424: pre-fix `elicitation.fulfilled` was emitted
    // even when the client returned `value === undefined`, polluting the
    // audit trail. The decline path now emits a distinct
    // `elicitation.declined` event so downstream consumers can
    // distinguish "supplied a value" from "refused / cancelled."
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
