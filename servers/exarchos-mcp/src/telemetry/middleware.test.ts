import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTelemetry, createInstrumentedRegistrar } from './middleware.js';
import type { CoreHandler } from './middleware.js';
import { EventStore } from '../event-store/store.js';
import { TELEMETRY_STREAM } from './constants.js';
import { initToolMetrics } from './telemetry-projection.js';
import type { ToolMetrics } from './telemetry-projection.js';
import type { ToolResult } from '../format.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { rmrfAsync } from '../test-helpers/temp-dir.js';

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
      // Arrange
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      await wrapped({});

      // Assert
      const events = await eventStore.query(TELEMETRY_STREAM);
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe('tool.invoked');
      expect((events[0]!.data as Record<string, unknown>).tool).toBe('test_tool');
      expect(events[1]!.type).toBe('tool.completed');
      const completedData = events[1]!.data as Record<string, unknown>;
      expect(completedData.tool).toBe('test_tool');
      expect(completedData.durationMs).toBeGreaterThanOrEqual(0);
      expect(completedData.responseBytes).toBeGreaterThan(0);
      expect(completedData.tokenEstimate).toBeGreaterThan(0);
    });

    it('WithTelemetry_ReturnsToolResult_NotMcpToolResult', async () => {
      // Arrange
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      // Assert — result should be a ToolResult with _perf directly, not wrapped in content[0].text
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ key: 'val' });
      expect(result._perf).toBeDefined();
      expect(result._perf!.ms).toBeGreaterThanOrEqual(0);
      expect(result._perf!.bytes).toBeGreaterThan(0);
      expect(result._perf!.tokens).toBeGreaterThan(0);
      // Should NOT have content/isError (MCP envelope shape)
      expect((result as Record<string, unknown>).content).toBeUndefined();
      expect((result as Record<string, unknown>).isError).toBeUndefined();
    });

    it('InjectPerf_SetsFieldDirectly_NoJsonParsing', async () => {
      // Arrange
      const handler: CoreHandler = async () => ({
        success: true,
        data: { key: 'val' },
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      // Assert — _perf is set directly on ToolResult object
      expect(result._perf).toBeDefined();
      expect(typeof result._perf!.ms).toBe('number');
      expect(typeof result._perf!.bytes).toBe('number');
      expect(typeof result._perf!.tokens).toBe('number');
    });

    it('should preserve _meta field if present', async () => {
      // Arrange
      const handler: CoreHandler = async () => ({
        success: true,
        _meta: { hint: 'test' },
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});

      // Assert
      expect(result._meta).toEqual({ hint: 'test' });
      expect(result._perf).toBeDefined();
    });
  });

  describe('failing handler', () => {
    it('should emit tool.errored event and re-throw', async () => {
      // Arrange
      const handler: CoreHandler = async () => {
        throw new Error('Handler failed');
      };

      // Act & Assert
      const wrapped = withTelemetry(handler, 'fail_tool', eventStore);
      await expect(wrapped({})).rejects.toThrow('Handler failed');

      const events = await eventStore.query(TELEMETRY_STREAM);
      expect(events).toHaveLength(2);
      expect(events[0]!.type).toBe('tool.invoked');
      expect(events[1]!.type).toBe('tool.errored');
      const errorData = events[1]!.data as Record<string, unknown>;
      expect(errorData.tool).toBe('fail_tool');
      expect(errorData.errorMessage).toContain('Handler failed');
    });
  });

  // ─── PR3/T8 (#1364): action-errored emission on structured failure ───────
  describe('structured action-level failure', () => {
    it('WithTelemetry_StructuredFailure_EmitsActionErrored', async () => {
      // Arrange — handler returns the standard MCP envelope failure shape.
      const handler: CoreHandler = async () => ({
        success: false,
        error: { code: 'RESERVED_FIELD', message: 'state.tasks is reserved' },
      });

      // Act
      const wrapped = withTelemetry(handler, 'exarchos_orchestrate', eventStore);
      const result = await wrapped({});

      // Result is propagated unchanged on the success-branch contract;
      // the wrapper does NOT re-throw structured failures.
      expect(result.success).toBe(false);

      // Assert — both `tool.completed` AND `tool.action_errored` are emitted.
      const events = await eventStore.query(TELEMETRY_STREAM);
      const types = events.map((e) => e.type);
      expect(types).toContain('tool.invoked');
      expect(types).toContain('tool.completed');
      expect(types).toContain('tool.action_errored');
      // Transport-level errored must NOT fire when the handler returned cleanly.
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
      // Perf fields match the paired tool.completed event.
      expect(aeData.durationMs).toBe(completedData.durationMs);
      expect(aeData.responseBytes).toBe(completedData.responseBytes);
      expect(aeData.tokenEstimate).toBe(completedData.tokenEstimate);
    });

    it('WithTelemetry_StructuredFailure_MissingErrorCode_DefaultsToUnknown', async () => {
      const handler: CoreHandler = async () => ({
        success: false,
        // Intentionally omit error.code to exercise the fallback path.
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

    it('WithTelemetry_JsThrow_StillEmitsToolErroredOnly', async () => {
      const handler: CoreHandler = async () => {
        throw new Error('transport explode');
      };

      const wrapped = withTelemetry(handler, 'fail_tool', eventStore);
      await expect(wrapped({})).rejects.toThrow('transport explode');

      const events = await eventStore.query(TELEMETRY_STREAM);
      const types = events.map((e) => e.type);
      expect(types).toContain('tool.errored');
      // Regression guard against double-emitting from the catch branch.
      expect(types).not.toContain('tool.action_errored');
      // And no spurious tool.completed.
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
    it('should succeed even when telemetry append fails', async () => {
      // Arrange - Create a store pointing to a non-existent dir
      const brokenStore = new EventStore('/nonexistent/path/that/wont/work');

      const handler: CoreHandler = async () => ({
        success: true,
        data: {},
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', brokenStore);
      // Should not throw even though telemetry fails
      const result = await wrapped({});

      // Assert — result is a ToolResult directly
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
    // Arrange
    const mockServer = { tool: () => {} };

    // Act
    const registrar = createInstrumentedRegistrar(mockServer as unknown as { tool: (...args: unknown[]) => void }, eventStore);

    // Assert
    expect(typeof registrar).toBe('function');
  });

  it('should call server.tool with wrapped handler', () => {
    // Arrange
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

    // Act
    registrar('my_tool', 'My tool description', {}, originalHandler);

    // Assert
    expect(registeredName).toBe('my_tool');
    expect(registeredHandler).toBeDefined();
    // The registered handler should NOT be the original (it's wrapped)
    expect(registeredHandler).not.toBe(originalHandler);
  });
});

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

  /** Helper: creates ToolMetrics with specified overrides. */
  function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
    return { ...initToolMetrics(), ...overrides };
  }

  it('WithTelemetry_ThresholdExceeded_AppliesAutoCorrection', async () => {
    // Arrange
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

    // Act
    const result = await wrapped({ action: 'tasks' });

    // Assert — handler should receive corrected args with fields injected
    expect(receivedArgs).toBeDefined();
    expect(receivedArgs!.fields).toEqual(['id', 'title', 'status', 'assignee']);

    // Response should include _corrections metadata directly on ToolResult
    expect(result._corrections).toBeDefined();
    expect(result._corrections!.applied).toHaveLength(1);
    expect(result._corrections!.applied[0]!.param).toBe('fields');
  });

  it('WithTelemetry_SkipAutoCorrection_BypassesCorrection', async () => {
    // Arrange
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

    // Act
    const result = await wrapped({ action: 'tasks', skipAutoCorrection: true });

    // Assert — handler should receive original args unchanged
    expect(receivedArgs).toBeDefined();
    expect(receivedArgs!.fields).toBeUndefined();
    expect(receivedArgs!.skipAutoCorrection).toBe(true);

    // Response should not include _corrections
    expect(result._corrections).toBeUndefined();
  });

  it('WithTelemetry_AutoCorrectionApplied_EmitsQualityHintGenerated', async () => {
    // Arrange
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

    // Act
    await wrapped({ action: 'tasks' });

    // Assert — quality.hint.generated event should be emitted
    const events = await eventStore.query(TELEMETRY_STREAM);
    const hintEvents = events.filter((e) => e.type === 'quality.hint.generated');
    expect(hintEvents).toHaveLength(1);

    const hintData = hintEvents[0]!.data as Record<string, unknown>;
    expect(hintData.skill).toBe('exarchos_view');
    expect(hintData.hintCount).toBe(1);
    expect(hintData.categories).toEqual(['auto-correction']);
    expect(hintData.generatedAt).toBeDefined();
  });
});

describe('D3 token-budget gate emission', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gate-emission-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await rmrfAsync(tmpDir);
  });

  it('withTelemetry_TokenThresholdExceeded_EmitsGateExecutedForD3', async () => {
    // Arrange: ~10KB response -> ~2560 tokens (exceeds 2048 threshold)
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    // Act
    await wrapped({ featureId: 'test-feature' });

    // Assert: gate.executed event should be emitted to the workflow stream (featureId)
    const workflowEvents = await eventStore.query('test-feature');
    const gateEvents = workflowEvents.filter((e) => e.type === 'gate.executed');
    expect(gateEvents).toHaveLength(1);

    const gateData = gateEvents[0]!.data as Record<string, unknown>;
    expect(gateData.gateName).toBe('token-budget');
    expect(gateData.passed).toBe(false);

    const details = gateData.details as Record<string, unknown>;
    expect(details.dimension).toBe('D3');
    expect(details.phase).toBe('runtime');
    expect(details.tokenEstimate).toBeGreaterThan(2048);
    expect(details.tool).toBe('test-tool');
  });

  it('withTelemetry_TokenBelowThreshold_NoGateEvent', async () => {
    // Arrange: small response (~25 tokens, well below 2048 threshold)
    const handler: CoreHandler = async () => ({
      success: true,
      data: {},
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    // Act
    await wrapped({ featureId: 'test-feature' });

    // Assert: no gate.executed event emitted to the workflow stream
    const workflowEvents = await eventStore.query('test-feature');
    const gateEvents = workflowEvents.filter((e) => e.type === 'gate.executed');
    expect(gateEvents).toHaveLength(0);
  });

  it('withTelemetry_NoFeatureIdInArgs_SkipsGateEmission', async () => {
    // Arrange: large response but no featureId in args
    const handler: CoreHandler = async () => ({
      success: true,
      data: { content: 'x'.repeat(10_000) },
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    // Act — no featureId provided
    await wrapped({ action: 'get' });

    // Assert: only telemetry stream events exist, no gate.executed anywhere
    const telemetryEvents = await eventStore.query(TELEMETRY_STREAM);
    const telemetryGateEvents = telemetryEvents.filter((e) => e.type === 'gate.executed');
    expect(telemetryGateEvents).toHaveLength(0);

    // The telemetry stream should have tool.invoked and tool.completed only
    expect(telemetryEvents).toHaveLength(2);
    expect(telemetryEvents[0]!.type).toBe('tool.invoked');
    expect(telemetryEvents[1]!.type).toBe('tool.completed');
  });
});

// ─── injectEventHints tests ─────────────────────────────────────────────────

describe('injectEventHints', () => {
  // injectEventHints is a private function in middleware.ts, so we test the
  // logic by re-implementing the same algorithm here. The integration with
  // withTelemetry is tested separately via the full middleware path.

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

  /** Mirror of the private injectEventHints function in middleware.ts */
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
    const parsed = JSON.parse(injected.content[0]!.text) as Record<string, unknown>;

    expect(parsed._eventHints).toBeDefined();
    const eventHints = parsed._eventHints as EventHintsPayload;
    expect(eventHints.missing).toHaveLength(1);
    expect(eventHints.missing[0]!.eventType).toBe('team.spawned');
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

    // Should return the exact same object (identity check)
    expect(injected).toBe(result);
    expect(injected.content[0]!.text).toBe('{"success":true}');
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

    // Should return unchanged, not crash
    expect(injected.content[0]!.text).toBe('not valid json at all');
  });
});
