/**
 * Integration tests for the `correlationId` default from the active dispatch context.
 *
 * `derive-correlation-filters.test.ts` tests `deriveCorrelationFilters` alone. These tests pin the
 * same behavior through real handlers. They cover a call with no correlation args inside an active
 * dispatch context, and a call with an explicit arg inside an active context.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleViewCodeQuality, resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { handleViewTelemetry } from '../../../../src/projections/telemetry/tools.js';
import { EventStore } from '../../../../src/events/store.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../../../../src/dispatch/dispatch-context.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('Wave 2 — handlers honor AsyncLocalStorage ctx-default (#1448)', () => {
  let tmpDir: string;
  let store: EventStore;

  beforeEach(async () => {
    resetMaterializerCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'exarchos-ctx-default-'));
    store = new EventStore(tmpDir);
  });

  afterEach(async () => {
    resetMaterializerCache();
    await rmrfAsync(tmpDir);
  });

  /**
   * The stream holds one `cor-X` event and one `cor-Y` event. A call with no correlation args,
   * inside a dispatch context for `cor-X`, must fold only the `cor-X` event.
   */
  it('HandleViewCodeQuality_NoArgsInsideDispatch_DefaultsToCtxCorrelationId', async () => {
    const streamId = 'ctx-cq-wf';

    await store.append(streamId, {
      streamId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'gate.executed',
      operationId: 'op-X',
      correlationId: 'cor-X',
      data: {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 100,
        details: { skill: 'delegation' },
      },
      schemaVersion: '1.0',
    });
    await store.append(streamId, {
      streamId,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'gate.executed',
      operationId: 'op-Y',
      correlationId: 'cor-Y',
      data: {
        gateName: 'lint',
        layer: 'build',
        passed: true,
        duration: 200,
        details: { skill: 'synthesis' },
      },
      schemaVersion: '1.0',
    });

    const ctx = mintDispatchContext({ correlationId: 'cor-X' });
    const result = await runWithDispatchContext(ctx, () =>
      handleViewCodeQuality({ workflowId: streamId }, tmpDir, store),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const gates = data.gates as Record<string, unknown>;
    expect(gates).toHaveProperty('typecheck');
    expect(gates).not.toHaveProperty('lint');
    const skills = data.skills as Record<string, unknown>;
    expect(skills).toHaveProperty('delegation');
    expect(skills).not.toHaveProperty('synthesis');
  });

  /**
   * The telemetry handler calls `store.query` directly, not `queryDeltaEvents`. It must apply the
   * same default, so only `tool_X` with `cor-X` shows.
   */
  it('HandleViewTelemetry_NoArgsInsideDispatch_DefaultsToCtxCorrelationId', async () => {
    const TELEMETRY_STREAM_NAME = 'telemetry';

    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-X',
      correlationId: 'cor-X',
      data: {
        tool: 'tool_X',
        durationMs: 10,
        responseBytes: 100,
        tokenEstimate: 25,
      },
      schemaVersion: '1.0',
    });
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-Y',
      correlationId: 'cor-Y',
      data: {
        tool: 'tool_Y',
        durationMs: 50,
        responseBytes: 500,
        tokenEstimate: 200,
      },
      schemaVersion: '1.0',
    });

    const ctx = mintDispatchContext({ correlationId: 'cor-X' });
    const result = await runWithDispatchContext(ctx, () =>
      handleViewTelemetry({}, tmpDir, store),
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      session: { totalInvocations: number; totalTokens: number };
      tools: Array<{ tool: string; invocations: number }>;
    };
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('tool_X');
    expect(data.session.totalInvocations).toBe(1);
  });

  /**
   * When the caller supplies a correlation arg, the handler must not add the `correlationId` of the
   * context. The `op-explicit-z` event has `cor-Z`, not the `cor-X` of the context, and must show.
   * The `cor-X` event has a different `operationId` and must not show.
   */
  it('HandleViewCodeQuality_ExplicitOperationIdInsideDispatch_DoesNotInheritCorrelation', async () => {
    const streamId = 'ctx-explicit-wf';

    await store.append(streamId, {
      streamId,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'gate.executed',
      operationId: 'op-irrelevant',
      correlationId: 'cor-X',
      data: {
        gateName: 'lint',
        layer: 'build',
        passed: true,
        duration: 100,
        details: { skill: 'synthesis' },
      },
      schemaVersion: '1.0',
    });
    await store.append(streamId, {
      streamId,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'gate.executed',
      operationId: 'op-explicit-z',
      correlationId: 'cor-Z',
      data: {
        gateName: 'typecheck',
        layer: 'build',
        passed: true,
        duration: 200,
        details: { skill: 'delegation' },
      },
      schemaVersion: '1.0',
    });

    const ctx = mintDispatchContext({ correlationId: 'cor-X' });
    const result = await runWithDispatchContext(ctx, () =>
      handleViewCodeQuality(
        { workflowId: streamId, operationId: 'op-explicit-z' },
        tmpDir,
        store,
      ),
    );

    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const gates = data.gates as Record<string, unknown>;
    expect(gates).toHaveProperty('typecheck');
    expect(gates).not.toHaveProperty('lint');
    const skills = data.skills as Record<string, unknown>;
    expect(skills).toHaveProperty('delegation');
    expect(skills).not.toHaveProperty('synthesis');
  });
});
