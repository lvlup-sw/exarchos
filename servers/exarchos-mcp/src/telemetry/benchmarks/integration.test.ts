import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../event-store/store.js';
import { resetMaterializerCache } from '../../views/tools.js';
import { TELEMETRY_STREAM } from '../constants.js';

describe('Telemetry Integration', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-integration-'));
    resetMaterializerCache();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('should include telemetry metrics in view response when events exist', async () => {
    // Arrange
    const store = new EventStore(stateDir);
    await store.append(TELEMETRY_STREAM, {
      type: 'tool.completed',
      data: { tool: 'test_tool', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
    });

    // Act — call the telemetry view handler
    const { handleViewTelemetry } = await import('../tools.js');
    const result = await handleViewTelemetry({}, stateDir, store);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      session: { totalInvocations: number };
      tools: Array<{ tool: string }>;
    };
    expect(data.session.totalInvocations).toBe(1);
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('test_tool');
  });

  it('should emit tool.invoked and tool.completed events when instrumented handler runs', async () => {
    // Arrange
    const store = new EventStore(stateDir);
    const { withTelemetry } = await import('../middleware.js');
    const { formatResult } = await import('../../format.js');

    const mockHandler = async () => formatResult({ success: true, data: { test: true } });
    const instrumented = withTelemetry(mockHandler, 'test_handler', store);

    // Act
    await instrumented({});

    // Assert — check telemetry stream
    const events = await store.query(TELEMETRY_STREAM);
    const types = events.map(e => e.type);
    expect(types).toContain('tool.invoked');
    expect(types).toContain('tool.completed');

    const completed = events.find(e => e.type === 'tool.completed');
    expect(completed?.data).toMatchObject({
      tool: 'test_handler',
      durationMs: expect.any(Number),
      responseBytes: expect.any(Number),
      tokenEstimate: expect.any(Number),
    });
  });

  it('should materialize telemetry view from event stream', async () => {
    // Arrange
    const store = new EventStore(stateDir);

    // Seed multiple tool.completed events
    for (let i = 0; i < 5; i++) {
      await store.append(TELEMETRY_STREAM, {
        type: 'tool.completed',
        data: { tool: 'workflow_get', durationMs: 10 + i, responseBytes: 200, tokenEstimate: 50 },
      });
    }

    // Act
    const { handleViewTelemetry } = await import('../tools.js');
    const result = await handleViewTelemetry({}, stateDir, store);

    // Assert
    expect(result.success).toBe(true);
    const data = result.data as {
      session: { totalInvocations: number; totalTokens: number };
      tools: Array<{ tool: string; invocations: number; p50DurationMs: number; p95DurationMs: number }>;
    };
    expect(data.session.totalInvocations).toBe(5);
    expect(data.session.totalTokens).toBe(250);
    expect(data.tools[0].invocations).toBe(5);
    expect(data.tools[0].p50DurationMs).toBeGreaterThan(0);
    expect(data.tools[0].p95DurationMs).toBeGreaterThanOrEqual(data.tools[0].p50DurationMs);
  });
});
