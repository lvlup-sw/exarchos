import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTelemetry, createInstrumentedRegistrar } from '../../../../src/projections/telemetry/middleware.js';
import type { CoreHandler } from '../../../../src/projections/telemetry/middleware.js';
import { EventStore } from '../../../../src/events/store.js';
import { TELEMETRY_STREAM } from '../../../../src/projections/telemetry/constants.js';
import { initToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';
import type { ToolMetrics } from '../../../../src/projections/telemetry/telemetry-projection.js';
import type { ToolResult } from '../../../../src/format.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

describe('withTelemetry', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'middleware-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  describe('successful handler', () => {
    it('should emit tool.invoked and tool.completed events', async () => {
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      await wrapped({});

      const events = await eventStore.query(TELEMETRY_STREAM);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool.invoked');
      expect((events[0].data as Record<string, unknown>).tool).toBe('test_tool');
      expect(events[1].type).toBe('tool.completed');
      const completedData = events[1].data as Record<string, unknown>;
      expect(completedData.tool).toBe('test_tool');
      expect(completedData.durationMs).toBeGreaterThanOrEqual(0);
      expect(completedData.responseBytes).toBeGreaterThan(0);
      expect(completedData.tokenEstimate).toBeGreaterThan(0);
    });

    /** The result carries `_perf` directly. It has no `content` or `isError` field of the MCP envelope. */
    it('WithTelemetry_ReturnsToolResult_NotMcpToolResult', async () => {
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'val' });
      expect(result._perf).toBeDefined();
      expect(result._perf!.ms).toBeGreaterThanOrEqual(0);
      expect(result._perf!.bytes).toBeGreaterThan(0);
      expect(result._perf!.tokens).toBeGreaterThan(0);
      expect((result as Record<string, unknown>).content).toBeUndefined();
      expect((result as Record<string, unknown>).isError).toBeUndefined();
    });

    it('InjectPerf_SetsFieldDirectly_NoJsonParsing', async () => {
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      expect(result._perf).toBeDefined();
      expect(typeof result._perf!.ms).toBe('number');
      expect(typeof result._perf!.bytes).toBe('number');
      expect(typeof result._perf!.tokens).toBe('number');
    });

    it('should preserve _meta field if present', async () => {
      const handler: CoreHandler = async () => ({
        success: true,
        _meta: { hint: 'test' },
      });

      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      expect(result._meta).toEqual({ hint: 'test' });
      expect(result._perf).toBeDefined();
    });
  });

  describe('failing handler', () => {
    it('should emit tool.errored event and re-throw', async () => {
      const handler: CoreHandler = async () => {
        throw new Error('Handler failed');
      };

      const wrapped = withTelemetry(handler, 'fail_tool', eventStore);
      await expect(wrapped({})).rejects.toThrow('Handler failed');

      const events = await eventStore.query(TELEMETRY_STREAM);
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('tool.invoked');
      expect(events[1].type).toBe('tool.errored');
      const errorData = events[1].data as Record<string, unknown>;
      expect(errorData.tool).toBe('fail_tool');
      expect(errorData.errorMessage).toContain('Handler failed');
    });
  });

  describe('structured action-level failure', () => {
    /**
     * The wrapper returns a `success: false` result and does not throw. It emits
     * `tool.completed` and `tool.action_errored` with equal perf fields. It emits
     * no `tool.errored`, because the handler returned.
     */
    it('WithTelemetry_StructuredFailure_EmitsActionErrored', async () => {
      const handler: CoreHandler = async () => ({
        success: false,
        error: { code: 'RESERVED_FIELD', message: 'state.tasks is reserved' },
      });

      const wrapped = withTelemetry(handler, 'exarchos_orchestrate', eventStore);
      const result = await wrapped({});

      expect(result.success).toBe(false);

      const events = await eventStore.query(TELEMETRY_STREAM);
      const types = events.map((e) => e.type);
      expect(types).toContain('tool.invoked');
      expect(types).toContain('tool.completed');
      expect(types).toContain('tool.action_errored');
      expect(types).not.toContain('tool.errored');

      const completed = events.find((e) => e.type === 'tool.completed');
      const actionErrored = events.find((e) => e.type === 'tool.action_errored');
      expect(completed).toBeDefined();
      expect(actionErrored).toBeDefined();
      if (!completed || !actionErrored) return;

      const completedData = completed.data as Record<string, unknown>;
      const aeData = actionErrored.data as Record<string, unknown>;
      expect(aeData.tool).toBe('exarchos_orchestrate');
      expect(aeData.errorCode).toBe('RESERVED_FIELD');
      expect(aeData.durationMs).toBe(completedData.durationMs);
      expect(aeData.responseBytes).toBe(completedData.responseBytes);
      expect(aeData.tokenEstimate).toBe(completedData.tokenEstimate);
    });

    it('WithTelemetry_StructuredFailure_MissingErrorCode_DefaultsToUnknown', async () => {
      const handler: CoreHandler = async () => ({
        success: false,
        error: { message: 'opaque failure' },
      } as unknown as ReturnType<CoreHandler> extends Promise<infer R> ? R : never);

      const wrapped = withTelemetry(handler, 'exarchos_orchestrate', eventStore);
      await wrapped({});

      const events = await eventStore.query(TELEMETRY_STREAM);
      const actionErrored = events.find((e) => e.type === 'tool.action_errored');
      expect(actionErrored).toBeDefined();
      if (!actionErrored) return;
      expect((actionErrored.data as Record<string, unknown>).errorCode).toBe('UNKNOWN');
    });

    /** The catch branch must not also emit `tool.action_errored` or `tool.completed`. */
    it('WithTelemetry_JsThrow_StillEmitsToolErroredOnly', async () => {
      const handler: CoreHandler = async () => {
        throw new Error('transport explode');
      };

      const wrapped = withTelemetry(handler, 'fail_tool', eventStore);
      await expect(wrapped({})).rejects.toThrow('transport explode');

      const events = await eventStore.query(TELEMETRY_STREAM);
      const types = events.map((e) => e.type);
      expect(types).toContain('tool.errored');
      expect(types).not.toContain('tool.action_errored');
      expect(types).not.toContain('tool.completed');
    });

    it('WithTelemetry_Success_DoesNotEmitActionErrored', async () => {
      const handler: CoreHandler = async () => ({
        success: true,
        data: { ok: true },
      });

      const wrapped = withTelemetry(handler, 'happy_tool', eventStore);
      await wrapped({});

      const events = await eventStore.query(TELEMETRY_STREAM);
      const types = events.map((e) => e.type);
      expect(types).toContain('tool.completed');
      expect(types).not.toContain('tool.action_errored');
      expect(types).not.toContain('tool.errored');
    });
  });

  describe('telemetry failure resilience', () => {
    /** The store points to a directory that does not exist. */
    it('should succeed even when telemetry append fails', async () => {
      const brokenStore = new EventStore('/nonexistent/path/that/wont/work');

      const handler: CoreHandler = async () => ({
        success: true,
        data: {},
      });

      const wrapped = withTelemetry(handler, 'test_tool', brokenStore);
      const result = await wrapped({});

      expect(result.success).toBe(true);
    });
  });
});

describe('createInstrumentedRegistrar', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'registrar-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('should return a function', () => {
    const mockServer = { tool: () => {} };

    const registrar = createInstrumentedRegistrar(mockServer as unknown as { tool: (...args: unknown[]) => void }, eventStore);

    expect(typeof registrar).toBe('function');
  });

  it('should call server.tool with wrapped handler', () => {
    let registeredName: string | undefined;
    let registeredHandler: ((...args: unknown[]) => unknown) | undefined;
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: (...args: unknown[]) => unknown) => {
        registeredName = name;
        registeredHandler = handler;
      },
    };

    const registrar = createInstrumentedRegistrar(mockServer as unknown as { tool: (...args: unknown[]) => void }, eventStore);
    const originalHandler: CoreHandler = async () => ({
      success: true,
    });

    registrar('my_tool', 'My tool description', {}, originalHandler);

    expect(registeredName).toBe('my_tool');
    expect(registeredHandler).toBeDefined();
    expect(registeredHandler).not.toBe(originalHandler);
  });
});

/**
 * A `p95Bytes` of 1500 is over the 1200-byte threshold of the `tasks` view. Five
 * consecutive breaches fill the consistency window, so the `fields` rule matches.
 */
describe('auto-correction integration', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autocorrect-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
    return { ...initToolMetrics(), ...overrides };
  }

  it('WithTelemetry_ThresholdExceeded_AppliesAutoCorrection', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const handler: CoreHandler = async (args) => {
      receivedArgs = args;
      return { success: true, data: {} };
    };

    const metricsGetter = () => makeMetrics({ p95Bytes: 1500 });

    const wrapped = withTelemetry(handler, 'exarchos_view', eventStore, {
      action: 'tasks',
      getMetrics: metricsGetter,
      consecutiveBreaches: 5,
    });

    const result = await wrapped({ action: 'tasks' });

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs!.fields).toEqual(['id', 'title', 'status', 'assignee']);

    expect(result._corrections).toBeDefined();
    expect(result._corrections!.applied).toHaveLength(1);
    expect(result._corrections!.applied[0].param).toBe('fields');
  });

  it('WithTelemetry_SkipAutoCorrection_BypassesCorrection', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    const handler: CoreHandler = async (args) => {
      receivedArgs = args;
      return { success: true, data: {} };
    };

    const metricsGetter = () => makeMetrics({ p95Bytes: 1500 });

    const wrapped = withTelemetry(handler, 'exarchos_view', eventStore, {
      action: 'tasks',
      getMetrics: metricsGetter,
      consecutiveBreaches: 5,
    });

    const result = await wrapped({ action: 'tasks', skipAutoCorrection: true });

    expect(receivedArgs).toBeDefined();
    expect(receivedArgs!.fields).toBeUndefined();
    expect(receivedArgs!.skipAutoCorrection).toBe(true);

    expect(result._corrections).toBeUndefined();
  });

  it('WithTelemetry_AutoCorrectionApplied_EmitsQualityHintGenerated', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: {},
    });

    const metricsGetter = () => makeMetrics({ p95Bytes: 1500 });

    const wrapped = withTelemetry(handler, 'exarchos_view', eventStore, {
      action: 'tasks',
      getMetrics: metricsGetter,
      consecutiveBreaches: 5,
    });

    await wrapped({ action: 'tasks' });

    const events = await eventStore.query(TELEMETRY_STREAM);
    const hintEvents = events.filter((e) => e.type === 'quality.hint.generated');
    expect(hintEvents).toHaveLength(1);

    const hintData = hintEvents[0].data as Record<string, unknown>;
    expect(hintData.skill).toBe('exarchos_view');
    expect(hintData.hintCount).toBe(1);
    expect(hintData.categories).toEqual(['auto-correction']);
    expect(hintData.generatedAt).toBeDefined();
  });
});

/**
 * The wrapper records a breach as `tool.budget_exceeded` on the telemetry stream.
 * It must not append a `gate.executed` row with dimension `D3` to the feature stream.
 * The convergence view folds such a row as a failed gate that nothing runs again, so
 * one breach keeps `overallConverged` false.
 */
describe('token-budget breach record', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-emission-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  /** A response of about 10 kB is about 2500 tokens, which is more than the 2048 threshold. */
  it('withTelemetry_TokenThresholdExceeded_RecordsBreachOnTheTelemetryStream', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    await wrapped({ featureId: 'test-feature' });

    const telemetryEvents = await eventStore.query(TELEMETRY_STREAM);
    const breaches = telemetryEvents.filter((e) => e.type === 'tool.budget_exceeded');
    expect(breaches).toHaveLength(1);

    const data = breaches[0].data as Record<string, unknown>;
    expect(data.tool).toBe('test-tool');
    expect(data.featureId).toBe('test-feature');
    expect(data.threshold).toBe(2048);
    expect(data.tokenEstimate as number).toBeGreaterThan(2048);
    expect(data.responseBytes as number).toBeGreaterThan(10_000 - 1);
  });

  /** The wrapper must append nothing to the feature stream, because the convergence view reads that stream. */
  it('withTelemetry_TokenThresholdExceeded_WritesNothingToTheFeatureStream', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);
    await wrapped({ featureId: 'test-feature' });

    const workflowEvents = await eventStore.query('test-feature');
    expect(workflowEvents).toEqual([]);
  });

  /** The telemetry stream needs no `featureId`, so a call that names no workflow still records its breach. */
  it('withTelemetry_NoFeatureId_StillRecordsTheBreachWithoutOne', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);
    await wrapped({ action: 'get' });

    const telemetryEvents = await eventStore.query(TELEMETRY_STREAM);
    const breaches = telemetryEvents.filter((e) => e.type === 'tool.budget_exceeded');
    expect(breaches).toHaveLength(1);
    expect((breaches[0].data as Record<string, unknown>).featureId).toBeUndefined();
  });

  /** An empty payload is far below the 2048-token threshold. */
  it('withTelemetry_TokenBelowThreshold_NoBreachRecord', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: {},
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    await wrapped({ featureId: 'test-feature' });

    const telemetryEvents = await eventStore.query(TELEMETRY_STREAM);
    expect(telemetryEvents.filter((e) => e.type === 'tool.budget_exceeded')).toHaveLength(0);
    const workflowEvents = await eventStore.query('test-feature');
    expect(workflowEvents.filter((e) => e.type === 'tool.budget_exceeded')).toHaveLength(0);
  });

  /**
   * The wrapper appends no `gate.executed` row. The test also asserts the full type
   * list of the telemetry stream, because a filter alone cannot tell an absent row
   * from an empty stream.
   */
  it('withTelemetry_NoFeatureIdInArgs_AppendsNoGateRowAndNamesTheWholeStream', async () => {
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    await wrapped({ action: 'get' });

    const telemetryEvents = await eventStore.query(TELEMETRY_STREAM);
    expect(telemetryEvents.filter((e) => e.type === 'gate.executed')).toEqual([]);
    expect(telemetryEvents.map((e) => e.type)).toEqual([
      'tool.invoked',
      'tool.budget_exceeded',
      'tool.completed',
    ]);
  });
});

/**
 * These tests exercise a local `injectEventHints` that edits the JSON text of an
 * MCP envelope. The private `injectEventHints` of `middleware.ts` sets `_eventHints`
 * on the `ToolResult`, so these tests do not cover it.
 */
describe('injectEventHints', () => {
  interface EventHint {
    readonly eventType: string;
    readonly description: string;
  }

  interface EventHintsPayload {
    readonly missing: readonly EventHint[];
    readonly phase: string;
    readonly checked: number;
  }

  type McpToolResult = {
    content: Array<{ type: string; text: string; [key: string]: unknown }>;
    isError: boolean;
    [key: string]: unknown;
  };

  function injectEventHints(result: McpToolResult, payload: EventHintsPayload): McpToolResult {
    if (payload.missing.length === 0) return result;

    const entry = result.content[0];
    if (!entry?.text) return result;

    try {
      const parsed = JSON.parse(entry.text) as Record<string, unknown>;
      parsed._eventHints = payload;
      return {
        ...result,
        content: [{ ...entry, text: JSON.stringify(parsed) }, ...result.content.slice(1)],
      };
    } catch {
      return result;
    }
  }

  it('InjectEventHints_WithHints_AddsToResponse', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    };

    const payload: EventHintsPayload = {
      missing: [{ eventType: 'team.spawned', description: 'Emit team.spawned event' }],
      phase: 'delegate',
      checked: 3,
    };

    const injected = injectEventHints(result, payload);
    const parsed = JSON.parse(injected.content[0].text) as Record<string, unknown>;

    expect(parsed._eventHints).toBeDefined();
    const eventHints = parsed._eventHints as EventHintsPayload;
    expect(eventHints.missing).toHaveLength(1);
    expect(eventHints.missing[0].eventType).toBe('team.spawned');
    expect(eventHints.phase).toBe('delegate');
    expect(eventHints.checked).toBe(3);
  });

  it('InjectEventHints_EmptyHints_ReturnsUnchanged', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    };

    const payload: EventHintsPayload = { missing: [], phase: 'delegate', checked: 0 };
    const injected = injectEventHints(result, payload);

    expect(injected).toBe(result);
    expect(injected.content[0].text).toBe('{"success":true}');
  });

  it('InjectEventHints_NonJsonResponse_ReturnsUnchanged', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: 'not valid json at all' }],
      isError: false,
    };

    const payload: EventHintsPayload = {
      missing: [{ eventType: 'team.spawned', description: 'Emit team.spawned event' }],
      phase: 'delegate',
      checked: 3,
    };

    const injected = injectEventHints(result, payload);

    expect(injected.content[0].text).toBe('not valid json at all');
  });
});
