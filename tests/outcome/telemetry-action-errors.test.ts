/**
 * Outcome tests for the two error counters of the telemetry view.
 *
 * `withTelemetry` emits `tool.errored` when a handler throws. It emits `tool.action_errored`, with
 * the error code, when a handler returns a `success: false` envelope. The telemetry projection
 * counts the first in `errors`. It counts the second in `actionErrors` and in
 * `actionErrorBreakdown`, which is keyed by error code.
 *
 * The tests run the real middleware against an `EventStore` and read the result with
 * `handleViewTelemetry`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../src/events/store.js';
import { withTelemetry } from '../../src/projections/telemetry/middleware.js';
import type { CoreHandler } from '../../src/projections/telemetry/middleware.js';
import { handleViewTelemetry } from '../../src/projections/telemetry/tools.js';
import {
  handleInit,
  handleUpdate,
} from '../../src/workflow/tools.js';
import { rmrfAsync } from '../../tools/test-helpers/temp-dir.js';

interface TelemetryToolEntry {
  readonly tool: string;
  readonly invocations: number;
  readonly errors: number;
  readonly actionErrors: number;
  readonly actionErrorBreakdown: Readonly<Record<string, number>>;
}

interface TelemetryEnvelope {
  readonly session: {
    readonly start: string;
    readonly totalInvocations: number;
    readonly totalTokens: number;
  };
  readonly tools: readonly TelemetryToolEntry[];
}

describe('telemetry action/transport split outcome (#1364)', () => {
  /**
   * A real workflow exists first, so the failing update has state to act on. `workflowType` is a
   * top-level immutable key, so the update returns `RESERVED_FIELD` and does not throw. The
   * structured failure must add to `actionErrors` and not to `errors`.
   */
  it('Telemetry_AfterStructuredFailure_IncrementsActionErrorsNotTransportErrors', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-telemetry-split-'),
    );
    try {
      const eventStore = new EventStore(stateDir);

      const featureId = 'outcome-1364-action';
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      const toolName = 'exarchos_workflow';
      const wrapped: CoreHandler = withTelemetry(
        async (args) =>
          handleUpdate(
            args as { featureId: string; updates: Record<string, unknown> },
            stateDir,
            eventStore,
          ),
        toolName,
        eventStore,
      );

      const failure = await wrapped({
        featureId,
        updates: { workflowType: 'debug' },
      });
      expect(failure.success).toBe(false);
      expect(failure.error?.code).toBe('RESERVED_FIELD');

      const telemetryResult = await handleViewTelemetry({}, stateDir, eventStore);
      expect(telemetryResult.success).toBe(true);

      const envelope = telemetryResult.data as TelemetryEnvelope;
      const entry = envelope.tools.find((t) => t.tool === toolName);
      expect(entry).toBeDefined();
      expect(entry!.actionErrors).toBeGreaterThanOrEqual(1);
      expect(entry!.errors).toBe(0);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  /** The breakdown key must be the `code` of the structured error, not a generic label. */
  it('Telemetry_ActionErrorBreakdown_KeyedByErrorCode', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-telemetry-breakdown-'),
    );
    try {
      const eventStore = new EventStore(stateDir);

      const featureId = 'outcome-1364-breakdown';
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      const toolName = 'exarchos_workflow';
      const wrapped: CoreHandler = withTelemetry(
        async (args) =>
          handleUpdate(
            args as { featureId: string; updates: Record<string, unknown> },
            stateDir,
            eventStore,
          ),
        toolName,
        eventStore,
      );

      const failure = await wrapped({
        featureId,
        updates: { workflowType: 'debug' },
      });
      expect(failure.success).toBe(false);
      expect(failure.error?.code).toBe('RESERVED_FIELD');

      const telemetryResult = await handleViewTelemetry({}, stateDir, eventStore);
      expect(telemetryResult.success).toBe(true);

      const envelope = telemetryResult.data as TelemetryEnvelope;
      const entry = envelope.tools.find((t) => t.tool === toolName);
      expect(entry).toBeDefined();
      expect(entry!.actionErrorBreakdown).toBeDefined();
      expect(entry!.actionErrorBreakdown['RESERVED_FIELD']).toBeGreaterThanOrEqual(1);
    } finally {
      await rmrfAsync(stateDir);
    }
  });

  /**
   * A handler that throws is the transport failure. It must add to `errors` and not to
   * `actionErrors`, because a throw returns no envelope and emits no `tool.action_errored` event.
   */
  it('Telemetry_AfterJsThrow_IncrementsTransportErrors', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-telemetry-throw-'),
    );
    try {
      const eventStore = new EventStore(stateDir);

      const toolName = 'exarchos_orchestrate';
      const throwingHandler: CoreHandler = async () => {
        throw new Error('transport explode');
      };
      const wrapped: CoreHandler = withTelemetry(
        throwingHandler,
        toolName,
        eventStore,
      );

      await expect(wrapped({})).rejects.toThrow('transport explode');

      const telemetryResult = await handleViewTelemetry({}, stateDir, eventStore);
      expect(telemetryResult.success).toBe(true);

      const envelope = telemetryResult.data as TelemetryEnvelope;
      const entry = envelope.tools.find((t) => t.tool === toolName);
      expect(entry).toBeDefined();
      expect(entry!.errors).toBeGreaterThanOrEqual(1);
      expect(entry!.actionErrors).toBe(0);
    } finally {
      await rmrfAsync(stateDir);
    }
  });
});
