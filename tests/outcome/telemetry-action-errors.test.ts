// ─── T3.3 — Telemetry action/transport split outcome (GREEN) ──────────────
//
// Encodes the #1364 fix shipped in commit 53cb4e4d (PR #1393). Before the
// fix, the telemetry view's `errors` counter conflated two failure modes:
//   - Transport / protocol JS throws (the handler crashed)
//   - Structured action-level failures (the handler returned a
//     `{success:false, error:{code,…}}` envelope per the MCP contract)
//
// The fix splits them. `tool.errored` continues to fire on JS throws only;
// `tool.action_errored` fires on structured failures and carries the
// per-call `errorCode`. The telemetry projection folds them into separate
// counters: `errors` (transport) and `actionErrors` /
// `actionErrorBreakdown` (action-level, keyed by error code).
//
// This test exercises the contract end-to-end via the real `withTelemetry`
// middleware against an `EventStore`-backed telemetry view, mirroring the
// outcome-tier posture of asserting on what an operator would observe in
// `view.telemetry` output.

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
  it('Telemetry_AfterStructuredFailure_IncrementsActionErrorsNotTransportErrors', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-telemetry-split-'),
    );
    try {
      const eventStore = new EventStore(stateDir);

      // Initialise a real workflow so the subsequent failing update has
      // genuine state to land against (the RESERVED_FIELD path requires
      // an existing state file).
      const featureId = 'outcome-1364-action';
      const initResult = await handleInit(
        { featureId, workflowType: 'feature' },
        stateDir,
        eventStore,
      );
      expect(initResult.success).toBe(true);

      // Wrap the real `handleUpdate` with the telemetry middleware. The
      // middleware emits `tool.completed` + `tool.action_errored` when
      // the wrapped handler returns a structured failure envelope (post
      // #1364) instead of throwing.
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

      // Drive a reserved-field rejection — the structured failure path.
      // `workflowType` is top-level immutable and routes through
      // `applyDotPath`, yielding `RESERVED_FIELD`.
      const failure = await wrapped({
        featureId,
        updates: { workflowType: 'debug' },
      });
      expect(failure.success).toBe(false);
      expect(failure.error?.code).toBe('RESERVED_FIELD');

      // Read telemetry. The MCP composite isn't running, so we hit the
      // handler directly — same underlying projection over the same
      // TELEMETRY_STREAM events.
      const telemetryResult = await handleViewTelemetry({}, stateDir, eventStore);
      expect(telemetryResult.success).toBe(true);

      const envelope = telemetryResult.data as TelemetryEnvelope;
      const entry = envelope.tools.find((t) => t.tool === toolName);
      expect(entry).toBeDefined();
      // Structured failure must increment actionErrors, NOT errors.
      expect(entry!.actionErrors).toBeGreaterThanOrEqual(1);
      expect(entry!.errors).toBe(0);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

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
      // The breakdown is keyed by the structured `error.code`, not by a
      // generic "failed" label — that is the per-call diagnostic surface.
      expect(entry!.actionErrorBreakdown).toBeDefined();
      expect(entry!.actionErrorBreakdown['RESERVED_FIELD']).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it('Telemetry_AfterJsThrow_IncrementsTransportErrors', async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'outcome-telemetry-throw-'),
    );
    try {
      const eventStore = new EventStore(stateDir);

      // A handler that throws raw — the transport / protocol failure
      // mode. Mirrors the wrapper's `tool.errored` path; explicitly
      // contrasted with the structured-failure path above so the split
      // contract is exercised both ways.
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
      // Transport failure must increment errors and NOT actionErrors —
      // the JS throw never resolves the handler envelope, so no
      // `tool.action_errored` companion event fires.
      expect(entry!.errors).toBeGreaterThanOrEqual(1);
      expect(entry!.actionErrors).toBe(0);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
