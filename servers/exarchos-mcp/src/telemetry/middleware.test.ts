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
