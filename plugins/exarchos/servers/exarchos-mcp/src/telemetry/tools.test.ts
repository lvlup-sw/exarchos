import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../event-store/store.js';
import { handleViewTelemetry, registerTelemetryTools } from './tools.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../views/tools.js';
import { TELEMETRY_VIEW } from './telemetry-projection.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ─── Test Helpers ────────────────────────────────────────────────────────────

async function createTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'telemetry-tools-test-'));
}

async function seedTelemetryEvents(
  stateDir: string,
  events: Array<{
    tool: string;
    durationMs: number;
    responseBytes: number;
    tokenEstimate: number;
  }>,
): Promise<void> {
  const store = new EventStore(stateDir);
  for (const e of events) {
    await store.append('telemetry', {
      type: 'tool.completed',
      data: e,
    });
  }
}

describe('handleViewTelemetry', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  describe('compact mode (default)', () => {
    it('should return summary without rolling window arrays', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'workflow_get', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
      ]);

      // Act
      const result = await handleViewTelemetry({}, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        session: { start: string; totalInvocations: number; totalTokens: number };
        tools: Array<Record<string, unknown>>;
        hints: unknown[];
      };
      expect(data.session.totalInvocations).toBe(2);
      expect(data.session.totalTokens).toBe(150);
      expect(data.tools).toHaveLength(1);
      expect(data.tools[0].tool).toBe('workflow_get');
      expect(data.tools[0].invocations).toBe(2);
      // Compact mode: rolling window arrays should be stripped
      expect(data.tools[0]).not.toHaveProperty('durations');
      expect(data.tools[0]).not.toHaveProperty('sizes');
      expect(data.tools[0]).not.toHaveProperty('tokenEstimates');
    });
  });

  describe('full mode', () => {
    it('should include durations/sizes/tokenEstimates arrays', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'event_query', durationMs: 15, responseBytes: 300, tokenEstimate: 75 },
      ]);

      // Act
      const result = await handleViewTelemetry({ compact: false }, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<Record<string, unknown>>;
      };
      expect(data.tools[0]).toHaveProperty('durations');
      expect(data.tools[0]).toHaveProperty('sizes');
      expect(data.tools[0]).toHaveProperty('tokenEstimates');
      expect(data.tools[0].durations).toEqual([15]);
      expect(data.tools[0].sizes).toEqual([300]);
      expect(data.tools[0].tokenEstimates).toEqual([75]);
    });
  });

  describe('filter by tool', () => {
    it('should return only the specified tool', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'event_query', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
        { tool: 'view_tasks', durationMs: 30, responseBytes: 600, tokenEstimate: 150 },
      ]);

      // Act
      const result = await handleViewTelemetry({ tool: 'event_query' }, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<{ tool: string }>;
      };
      expect(data.tools).toHaveLength(1);
      expect(data.tools[0].tool).toBe('event_query');
    });
  });

  describe('sort by tokens', () => {
    it('should sort tools descending by total tokens', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'small', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'large', durationMs: 10, responseBytes: 800, tokenEstimate: 200 },
        { tool: 'medium', durationMs: 8, responseBytes: 400, tokenEstimate: 100 },
      ]);

      // Act
      const result = await handleViewTelemetry({ sort: 'tokens' }, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<{ tool: string; totalTokens: number }>;
      };
      expect(data.tools[0].tool).toBe('large');
      expect(data.tools[1].tool).toBe('medium');
      expect(data.tools[2].tool).toBe('small');
    });
  });

  describe('sort by invocations', () => {
    it('should sort tools descending by invocation count', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'few', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'some', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'some', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
      ]);

      // Act
      const result = await handleViewTelemetry({ sort: 'invocations' }, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<{ tool: string; invocations: number }>;
      };
      expect(data.tools[0].tool).toBe('many');
      expect(data.tools[0].invocations).toBe(3);
      expect(data.tools[1].tool).toBe('some');
      expect(data.tools[1].invocations).toBe(2);
      expect(data.tools[2].tool).toBe('few');
      expect(data.tools[2].invocations).toBe(1);
    });
  });

  describe('sort by duration', () => {
    it('should sort tools descending by total duration', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'fast', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'slow', durationMs: 100, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'mid', durationMs: 50, responseBytes: 100, tokenEstimate: 25 },
      ]);

      // Act
      const result = await handleViewTelemetry({ sort: 'duration' }, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<{ tool: string; totalDurationMs: number }>;
      };
      expect(data.tools[0].tool).toBe('slow');
      expect(data.tools[1].tool).toBe('mid');
      expect(data.tools[2].tool).toBe('fast');
    });
  });

  describe('limit results', () => {
    it('should return only top N tools', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'a', durationMs: 10, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'b', durationMs: 20, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'c', durationMs: 30, responseBytes: 300, tokenEstimate: 75 },
        { tool: 'd', durationMs: 40, responseBytes: 400, tokenEstimate: 100 },
      ]);

      // Act
      const result = await handleViewTelemetry(
        { sort: 'tokens', limit: 2 },
        stateDir,
      );

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        tools: Array<{ tool: string }>;
      };
      expect(data.tools).toHaveLength(2);
      expect(data.tools[0].tool).toBe('d');
      expect(data.tools[1].tool).toBe('c');
    });
  });

  describe('empty state', () => {
    it('should return empty tools when no events exist', async () => {
      // Act
      const result = await handleViewTelemetry({}, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        session: { totalInvocations: number; totalTokens: number };
        tools: unknown[];
        hints: unknown[];
      };
      expect(data.session.totalInvocations).toBe(0);
      expect(data.session.totalTokens).toBe(0);
      expect(data.tools).toHaveLength(0);
      expect(data.hints).toHaveLength(0);
    });
  });

  describe('hints included', () => {
    it('should include hints when thresholds are exceeded', async () => {
      // Arrange — seed with large responses to trigger view_tasks hint
      const largeEvents = Array.from({ length: 5 }, () => ({
        tool: 'view_tasks',
        durationMs: 10,
        responseBytes: 2000,
        tokenEstimate: 500,
      }));
      await seedTelemetryEvents(stateDir, largeEvents);

      // Act
      const result = await handleViewTelemetry({}, stateDir);

      // Assert
      expect(result.success).toBe(true);
      const data = result.data as {
        hints: Array<{ tool: string; hint: string }>;
      };
      expect(data.hints.length).toBeGreaterThan(0);
      expect(data.hints[0].tool).toBe('view_tasks');
    });
  });

  describe('error handling', () => {
    it('should return error result when materializer throws', async () => {
      // Arrange — create a materializer that will fail by corrupting event data
      const badDir = await createTempDir();
      resetMaterializerCache();

      // Write a corrupt JSONL file that will fail JSON.parse during query
      const corruptFile = path.join(badDir, 'telemetry.events.jsonl');
      await fs.mkdir(badDir, { recursive: true });
      await fs.writeFile(corruptFile, '{not valid json\n', 'utf-8');

      // Act
      const result = await handleViewTelemetry({}, badDir);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('VIEW_ERROR');
    });
  });
});

describe('Telemetry projection registered in materializer', () => {
  beforeEach(() => {
    resetMaterializerCache();
  });

  it('should have telemetry view registered after materializer creation', () => {
    // Act — create a materializer (which calls createMaterializer internally)
    const materializer = getOrCreateMaterializer('/tmp/test-mat-telemetry');

    // Assert
    expect(materializer.hasProjection(TELEMETRY_VIEW)).toBe(true);
  });
});

describe('registerTelemetryTools', () => {
  it('should register exarchos_view_telemetry tool on the server', () => {
    // Arrange
    const toolNames: string[] = [];
    const mockServer = {
      tool: (name: string, ..._rest: unknown[]) => {
        toolNames.push(name);
      },
    } as unknown as McpServer;
    const store = new EventStore('/tmp/test-reg');

    // Act
    registerTelemetryTools(mockServer, '/tmp/test-reg', store);

    // Assert
    expect(toolNames).toContain('exarchos_view_telemetry');
  });
});
