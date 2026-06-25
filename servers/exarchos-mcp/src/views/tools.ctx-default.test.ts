// Wave 2 (#1448, item 2) — AsyncLocalStorage ctx-default integration tests.
//
// `deriveCorrelationFilters` (Task 4) is exercised in isolation by
// `derive-correlation-filters.test.ts`. These tests pin the same behavior
// end-to-end through real handlers AFTER Task 5 substitutes the inline
// spread blocks at the 6 sites. The handler tests in `handlers.test.ts`
// already pin the explicit-args-win path; these add the ctx-default path
// (no args + active dispatch context) and an explicit-wins regression
// guard inside an active context.
//
// RED today because the 6 inline spread blocks ignore `getDispatchContext`
// — the handler returns the unfiltered roll-up (which folds in cor-Y too)
// rather than scoping to the active context's correlationId. After
// Task 5's substitution, the helper's ctx-default branch kicks in and
// these go GREEN.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleViewCodeQuality, resetMaterializerCache } from './tools.js';
import { handleViewTelemetry } from '../telemetry/tools.js';
import { EventStore } from '../event-store/store.js';
import {
  mintDispatchContext,
  runWithDispatchContext,
} from '../dispatch/dispatch-context.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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

  it('HandleViewCodeQuality_NoArgsInsideDispatch_DefaultsToCtxCorrelationId', async () => {
    const streamId = 'ctx-cq-wf';

    // GIVEN: two gate.executed events, one stamped cor-X and one stamped
    // cor-Y. Pre-ctx-default, a no-args call would fold both into the view.
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

    // WHEN: handler is invoked with NO correlation args, inside an active
    // dispatch scope whose correlationId is cor-X.
    const ctx = mintDispatchContext({ correlationId: 'cor-X' });
    const result = await runWithDispatchContext(ctx, () =>
      handleViewCodeQuality({ workflowId: streamId }, tmpDir, store),
    );

    // THEN: the view folds only the cor-X event. The cor-Y gate ('lint',
    // skill 'synthesis') must be absent because the helper defaulted
    // correlationId from the active context.
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const gates = data.gates as Record<string, unknown>;
    expect(gates).toHaveProperty('typecheck');
    expect(gates).not.toHaveProperty('lint');
    const skills = data.skills as Record<string, unknown>;
    expect(skills).toHaveProperty('delegation');
    expect(skills).not.toHaveProperty('synthesis');
  });

  it('HandleViewTelemetry_NoArgsInsideDispatch_DefaultsToCtxCorrelationId', async () => {
    // Cross-handler invariance: the telemetry handler in telemetry/tools.ts
    // walks a different code path (direct store.query rather than
    // queryDeltaEvents) but the helper substitution must yield the same
    // ctx-default behavior.
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
    // Only tool_X (stamped cor-X) is rolled up; tool_Y must be absent.
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('tool_X');
    expect(data.session.totalInvocations).toBe(1);
  });

  it('HandleViewCodeQuality_ExplicitOperationIdInsideDispatch_DoesNotInheritCorrelation', async () => {
    // Regression guard for explicit-wins: when the caller supplies any
    // correlation arg, the active dispatch context's correlationId MUST
    // NOT be merged in. Otherwise the helper would silently AND-filter
    // a caller-supplied operationId with the ctx correlationId, and any
    // event matching the operationId but NOT the ctx correlationId would
    // be wrongly dropped.
    const streamId = 'ctx-explicit-wf';

    // cor-X event with operationId op-irrelevant (should NOT appear)
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
    // explicit-target event: op-explicit-z, stamped with a DIFFERENT
    // correlationId (cor-Z) than the active dispatch ctx (cor-X). It must
    // still appear because the explicit operationId disables the
    // ctx-default branch.
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

    // The op-explicit-z event (typecheck/delegation, cor-Z) must appear;
    // the cor-X event (lint/synthesis, op-irrelevant) must NOT.
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
