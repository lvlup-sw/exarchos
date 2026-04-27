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

describe('Token Economy Benchmarks', () => {
  let stateDir: string;
  let store: EventStore;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-bench-'));
    store = new EventStore(stateDir);
    resetMaterializerCache();
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it('telemetry view compact response should be under 400 tokens for 5 tools', async () => {
    // Arrange — seed events for 5 different tools
    const tools = ['workflow_get', 'event_append', 'view_tasks', 'view_pipeline', 'workflow_set'];
    for (const tool of tools) {
      for (let i = 0; i < 3; i++) {
        await store.append(TELEMETRY_STREAM, {
          type: 'tool.completed',
          data: { tool, durationMs: 10 + i, responseBytes: 200, tokenEstimate: 50 },
        });
      }
    }

    // Act
    const result = await handleViewTelemetry({ compact: true }, stateDir, store);

    // Assert
    expect(result.success).toBe(true);
    const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    const tokenEstimate = Math.ceil(responseBytes / 4);
    expect(tokenEstimate).toBeLessThan(400); // Conservative budget for 5 tools
  });

  it('telemetry view with tool filter should be under 150 tokens', async () => {
    // Arrange
    for (let i = 0; i < 10; i++) {
      await store.append(TELEMETRY_STREAM, {
        type: 'tool.completed',
        data: { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
      });
    }

    // Act
    const result = await handleViewTelemetry({ tool: 'workflow_get', compact: true }, stateDir, store);

    // Assert
    expect(result.success).toBe(true);
    const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf-8');
    const tokenEstimate = Math.ceil(responseBytes / 4);
    expect(tokenEstimate).toBeLessThan(150);
  });

  it('_perf field adds less than 15 tokens overhead per response', async () => {
    // Arrange
    const mockHandler = async () => formatResult({ success: true, data: { key: 'value' } });
    const instrumented = withTelemetry(mockHandler, 'overhead_test', store);

    // Act
    const withPerf = await instrumented({});
    const withoutPerf = await mockHandler({});

    // Assert
    const withPerfBytes = Buffer.byteLength(withPerf.content[0].text, 'utf-8');
    const withoutPerfBytes = Buffer.byteLength(withoutPerf.content[0].text, 'utf-8');
    const overheadBytes = withPerfBytes - withoutPerfBytes;
    const overheadTokens = Math.ceil(overheadBytes / 4);
    expect(overheadTokens).toBeLessThan(15);
  });
});
