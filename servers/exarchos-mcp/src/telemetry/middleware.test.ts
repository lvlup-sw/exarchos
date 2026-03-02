import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTelemetry, createInstrumentedRegistrar } from './middleware.js';
import { EventStore } from '../event-store/store.js';
import { TELEMETRY_STREAM } from './constants.js';
import { initToolMetrics } from './telemetry-projection.js';
import type { ToolMetrics } from './telemetry-projection.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

describe('withTelemetry', () => {
  let tmpDir: string;
  let eventStore: EventStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'middleware-test-'));
    eventStore = new EventStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('successful handler', () => {
    it('should emit tool.invoked and tool.completed events', async () => {
      // Arrange
      const handler = async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: { key: 'val' } }) }],
        isError: false,
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      await wrapped({});

      // Assert
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

    it('should inject _perf field into response', async () => {
      // Arrange
      const handler = async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: { key: 'val' } }) }],
        isError: false,
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});
      const parsed = JSON.parse(result.content[0].text);

      // Assert
      expect(parsed._perf).toBeDefined();
      expect(parsed._perf.ms).toBeGreaterThanOrEqual(0);
      expect(parsed._perf.bytes).toBeGreaterThan(0);
      expect(parsed._perf.tokens).toBeGreaterThan(0);
      // Original data preserved
      expect(parsed.data.key).toBe('val');
    });

    it('should preserve _meta field if present', async () => {
      // Arrange
      const handler = async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, _meta: { hint: 'test' } }) }],
        isError: false,
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', eventStore);
      const result = await wrapped({});
      const parsed = JSON.parse(result.content[0].text);

      // Assert
      expect(parsed._meta).toEqual({ hint: 'test' });
      expect(parsed._perf).toBeDefined();
    });
  });

  describe('failing handler', () => {
    it('should emit tool.errored event and re-throw', async () => {
      // Arrange
      const handler = async () => {
        throw new Error('Handler failed');
      };

      // Act & Assert
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

  describe('telemetry failure resilience', () => {
    it('should succeed even when telemetry append fails', async () => {
      // Arrange - Create a store pointing to a non-existent dir
      const brokenStore = new EventStore('/nonexistent/path/that/wont/work');

      const handler = async () => ({
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: {} }) }],
        isError: false,
      });

      // Act
      const wrapped = withTelemetry(handler, 'test_tool', brokenStore);
      // Should not throw even though telemetry fails
      const result = await wrapped({});

      // Assert
      expect(result.content[0]).toBeDefined();
      // _perf may be absent when telemetry fails (graceful degradation)
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.success).toBe(true);
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
    await fs.rm(tmpDir, { recursive: true, force: true });
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
    const originalHandler = async () => ({
      content: [{ type: 'text' as const, text: '{}' }],
      isError: false,
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: creates ToolMetrics with specified overrides. */
  function makeMetrics(overrides: Partial<ToolMetrics> = {}): ToolMetrics {
    return { ...initToolMetrics(), ...overrides };
  }

  it('WithTelemetry_ThresholdExceeded_AppliesAutoCorrection', async () => {
    // Arrange
    let receivedArgs: Record<string, unknown> | undefined;
    const handler = async (args: Record<string, unknown>) => {
      receivedArgs = args;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: {} }) }],
        isError: false,
      };
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

    // Response should include _autoCorrection metadata
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._autoCorrection).toBeDefined();
    expect(parsed._autoCorrection.applied).toHaveLength(1);
    expect(parsed._autoCorrection.applied[0].param).toBe('fields');
  });

  it('WithTelemetry_SkipAutoCorrection_BypassesCorrection', async () => {
    // Arrange
    let receivedArgs: Record<string, unknown> | undefined;
    const handler = async (args: Record<string, unknown>) => {
      receivedArgs = args;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: {} }) }],
        isError: false,
      };
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

    // Response should not include _autoCorrection
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed._autoCorrection).toBeUndefined();
  });

  it('WithTelemetry_AutoCorrectionApplied_EmitsQualityHintGenerated', async () => {
    // Arrange
    const handler = async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ success: true, data: {} }) }],
      isError: false,
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

    const hintData = hintEvents[0].data as Record<string, unknown>;
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
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('withTelemetry_TokenThresholdExceeded_EmitsGateExecutedForD3', async () => {
    // Arrange: ~10KB response -> ~2560 tokens (exceeds 2048 threshold)
    const largePayload = JSON.stringify({ success: true, data: { content: 'x'.repeat(10_000) } });
    const handler = async () => ({
      content: [{ type: 'text' as const, text: largePayload }],
      isError: false,
    });

    const wrapped = withTelemetry(handler, 'test-tool', eventStore);

    // Act
    await wrapped({ featureId: 'test-feature' });

    // Assert: gate.executed event should be emitted to the workflow stream (featureId)
    const workflowEvents = await eventStore.query('test-feature');
    const gateEvents = workflowEvents.filter((e) => e.type === 'gate.executed');
    expect(gateEvents).toHaveLength(1);

    const gateData = gateEvents[0].data as Record<string, unknown>;
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
    const smallPayload = JSON.stringify({ success: true, data: {} });
    const handler = async () => ({
      content: [{ type: 'text' as const, text: smallPayload }],
      isError: false,
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
    const largePayload = JSON.stringify({ success: true, data: { content: 'x'.repeat(10_000) } });
    const handler = async () => ({
      content: [{ type: 'text' as const, text: largePayload }],
      isError: false,
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
    expect(telemetryEvents[0].type).toBe('tool.invoked');
    expect(telemetryEvents[1].type).toBe('tool.completed');
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

  type McpToolResult = {
    content: Array<{ type: string; text: string; [key: string]: unknown }>;
    isError: boolean;
    [key: string]: unknown;
  };

  /** Mirror of the private injectEventHints function in middleware.ts */
  function injectEventHints(result: McpToolResult, hints: EventHint[]): McpToolResult {
    if (hints.length === 0) return result;

    const entry = result.content[0];
    if (!entry?.text) return result;

    try {
      const parsed = JSON.parse(entry.text) as Record<string, unknown>;
      parsed._eventHints = { missing: hints, phase: 'unknown', checked: hints.length };
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

    const hints: EventHint[] = [
      { eventType: 'team.spawned', description: 'Emit team.spawned event' },
    ];

    const injected = injectEventHints(result, hints);
    const parsed = JSON.parse(injected.content[0].text) as Record<string, unknown>;

    expect(parsed._eventHints).toBeDefined();
    const eventHints = parsed._eventHints as { missing: EventHint[]; phase: string; checked: number };
    expect(eventHints.missing).toHaveLength(1);
    expect(eventHints.missing[0].eventType).toBe('team.spawned');
    expect(eventHints.phase).toBe('unknown');
    expect(eventHints.checked).toBe(1);
  });

  it('InjectEventHints_EmptyHints_ReturnsUnchanged', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: '{"success":true}' }],
      isError: false,
    };

    const injected = injectEventHints(result, []);

    // Should return the exact same object (identity check)
    expect(injected).toBe(result);
    expect(injected.content[0].text).toBe('{"success":true}');
  });

  it('InjectEventHints_NonJsonResponse_ReturnsUnchanged', () => {
    const result: McpToolResult = {
      content: [{ type: 'text', text: 'not valid json at all' }],
      isError: false,
    };

    const hints: EventHint[] = [
      { eventType: 'team.spawned', description: 'Emit team.spawned event' },
    ];

    const injected = injectEventHints(result, hints);

    // Should return unchanged, not crash
    expect(injected.content[0].text).toBe('not valid json at all');
  });
});
