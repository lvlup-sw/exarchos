import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../event-store/store.js';
import { handleViewTelemetry } from '../tools.js';
import { withTelemetry } from '../middleware.js';
import { formatResult } from '../../format.js';
import { resetMaterializerCache } from '../../views/tools.js';
import { TELEMETRY_STREAM } from '../constants.js';

const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === 'true';

describe('Latency Benchmarks', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'latency-bench-'));
    store = new EventStore(stateDir);
    resetMaterializerCache();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.skipIf(!RUN_BENCHMARKS)('withTelemetry wrapper adds less than 10ms overhead', async () => {
    // Arrange
    const mockHandler = async () => formatResult({ success: true, data: {} });
    const instrumented = withTelemetry(mockHandler, 'latency_test', store);

    // Warm up
    await instrumented({});
    resetMaterializerCache();

    // Act — measure multiple runs
    const overheads: number[] = [];
    for (let i = 0; i < 10; i++) {
      const bareStart = performance.now();
      await mockHandler({});
      const bareTime = performance.now() - bareStart;

      const instrStart = performance.now();
      await instrumented({});
      const instrTime = performance.now() - instrStart;

      overheads.push(instrTime - bareTime);
    }

    // Assert — median overhead should be < 10ms
    overheads.sort((a, b) => a - b);
    const medianOverhead = overheads[Math.floor(overheads.length / 2)];
    expect(medianOverhead).toBeLessThan(10);
  });

  it.skipIf(!RUN_BENCHMARKS)('telemetry view materialization completes under 100ms for 100 events', async () => {
    // Arrange
    for (let i = 0; i < 100; i++) {
      await store.append(TELEMETRY_STREAM, {
        type: 'tool.completed',
        data: { tool: `tool_${i % 10}`, durationMs: i, responseBytes: 100 * i, tokenEstimate: 25 * i },
      });
    }

    // Act
    const start = performance.now();
    const result = await handleViewTelemetry({}, stateDir);
    const elapsed = performance.now() - start;

    // Assert
    expect(result.success).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});
