import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../../../src/events/store.js';
import { handleViewTelemetry } from '../../../../src/projections/telemetry/tools.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../../../../src/projections/views/tools.js';
import { TELEMETRY_VIEW } from '../../../../src/projections/telemetry/telemetry-projection.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

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

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  describe('compact mode (default)', () => {
    it('should return summary without rolling window arrays', async () => {
      await seedTelemetryEvents(stateDir, [
        { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'workflow_get', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
      ]);

      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

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
      expect(data.tools[0]).not.toHaveProperty('durations');
      expect(data.tools[0]).not.toHaveProperty('sizes');
      expect(data.tools[0]).not.toHaveProperty('tokenEstimates');
    });
  });

  describe('full mode', () => {
    it('should include durations/sizes/tokenEstimates arrays', async () => {
      await seedTelemetryEvents(stateDir, [
        { tool: 'event_query', durationMs: 15, responseBytes: 300, tokenEstimate: 75 },
      ]);

      const result = await handleViewTelemetry({ compact: false }, stateDir, new EventStore(stateDir));

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
      await seedTelemetryEvents(stateDir, [
        { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'event_query', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
        { tool: 'view_tasks', durationMs: 30, responseBytes: 600, tokenEstimate: 150 },
      ]);

      const result = await handleViewTelemetry({ tool: 'event_query' }, stateDir, new EventStore(stateDir));

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
      await seedTelemetryEvents(stateDir, [
        { tool: 'small', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'large', durationMs: 10, responseBytes: 800, tokenEstimate: 200 },
        { tool: 'medium', durationMs: 8, responseBytes: 400, tokenEstimate: 100 },
      ]);

      const result = await handleViewTelemetry({ sort: 'tokens' }, stateDir, new EventStore(stateDir));

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
      await seedTelemetryEvents(stateDir, [
        { tool: 'few', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'many', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'some', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'some', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
      ]);

      const result = await handleViewTelemetry({ sort: 'invocations' }, stateDir, new EventStore(stateDir));

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
      await seedTelemetryEvents(stateDir, [
        { tool: 'fast', durationMs: 5, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'slow', durationMs: 100, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'mid', durationMs: 50, responseBytes: 100, tokenEstimate: 25 },
      ]);

      const result = await handleViewTelemetry({ sort: 'duration' }, stateDir, new EventStore(stateDir));

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
      await seedTelemetryEvents(stateDir, [
        { tool: 'a', durationMs: 10, responseBytes: 100, tokenEstimate: 25 },
        { tool: 'b', durationMs: 20, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'c', durationMs: 30, responseBytes: 300, tokenEstimate: 75 },
        { tool: 'd', durationMs: 40, responseBytes: 400, tokenEstimate: 100 },
      ]);

      const result = await handleViewTelemetry(
        { sort: 'tokens', limit: 2 },
        stateDir,
      new EventStore(stateDir),
      );

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
      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

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
    /** The `view_tasks` responses of 2000 bytes put `p95Bytes` over the 1200-byte hint threshold. */
    it('should include hints when thresholds are exceeded', async () => {
      const largeEvents = Array.from({ length: 5 }, () => ({
        tool: 'view_tasks',
        durationMs: 10,
        responseBytes: 2000,
        tokenEstimate: 500,
      }));
      await seedTelemetryEvents(stateDir, largeEvents);

      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

      expect(result.success).toBe(true);
      const data = result.data as {
        hints: Array<{ tool: string; hint: string }>;
      };
      expect(data.hints.length).toBeGreaterThan(0);
      expect(data.hints[0].tool).toBe('view_tasks');
    });
  });

  describe('error handling', () => {
    /** A stub makes `store.query` reject, so the handler takes its error branch. */
    it('should return error result when materializer throws', async () => {
      const badDir = await createTempDir();
      resetMaterializerCache();

      try {
        const store = new EventStore(badDir);
        const queryStub = vi
          .spyOn(store, 'query')
          .mockRejectedValue(new Error('synthetic materializer failure'));

        const result = await handleViewTelemetry({}, badDir, store);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('VIEW_ERROR');

        queryStub.mockRestore();
      } finally {
        await rmrfAsync(badDir);
      }
    });
  });
});

/**
 * The telemetry view is compact by default, and `detail: true` adds the
 * rolling-window arrays. On a populated store, a `compact: true` response must be
 * smaller than a `detail: true` response.
 */
describe('DR-8 / B-4 — telemetry --compact reduces output (Task 014)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  async function seedPopulated(): Promise<void> {
    const tools = ['workflow_get', 'event_append', 'view_tasks'];
    const events = [];
    for (const tool of tools) {
      for (let i = 0; i < 40; i++) {
        events.push({
          tool,
          durationMs: 10 + i,
          responseBytes: 200 + i * 7,
          tokenEstimate: 50 + i,
        });
      }
    }
    await seedTelemetryEvents(stateDir, events);
  }

  function measureTokens(result: unknown): number {
    return Math.ceil(Buffer.byteLength(JSON.stringify(result), 'utf-8') / 4);
  }

  /**
   * `seedPopulated` gives each tool 40 window entries, so the full response is
   * measurably larger. The session summary must be equal in both responses.
   */
  it('viewTelemetry_CompactFlag_ReducesMeasuredOutput', async () => {
    await seedPopulated();

    const full = await handleViewTelemetry(
      { detail: true },
      stateDir,
      new EventStore(stateDir),
    );
    const compact = await handleViewTelemetry(
      { compact: true },
      stateDir,
      new EventStore(stateDir),
    );

    expect(full.success).toBe(true);
    expect(compact.success).toBe(true);
    expect(measureTokens(compact)).toBeLessThan(measureTokens(full));

    const fullTools = (full.data as { tools: Array<Record<string, unknown>> }).tools;
    const compactTools = (compact.data as { tools: Array<Record<string, unknown>> }).tools;
    expect(fullTools[0]).toHaveProperty('durations');
    expect(compactTools[0]).not.toHaveProperty('durations');

    const fullSession = (full.data as { session: Record<string, unknown> }).session;
    const compactSession = (compact.data as { session: Record<string, unknown> }).session;
    expect(compactSession).toEqual(fullSession);
  });

  /** With no flag, the tool rows equal the `compact: true` rows. */
  it('viewTelemetry_DefaultAndCompact_AreEquivalentCompactByDefault', async () => {
    await seedPopulated();

    const bare = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));
    const compact = await handleViewTelemetry(
      { compact: true },
      stateDir,
      new EventStore(stateDir),
    );

    expect(bare.success).toBe(true);
    expect(compact.success).toBe(true);
    expect((bare.data as { tools: unknown[] }).tools).toEqual(
      (compact.data as { tools: unknown[] }).tools,
    );
  });
});

/**
 * `TelemetryViewOutputSchema` requires `actionErrors` and `actionErrorBreakdown` on
 * each tool entry. If `toToolEntry` omits them, `validateAgainstActionSchema` rejects
 * each telemetry response that holds a tool entry.
 */
describe('toToolEntry — action-error fields (Sentry follow-up #1364)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  /** No action error is seeded, so both fields are present with zero values. */
  it('handleViewTelemetry_CompactEntry_IncludesActionErrorFields', async () => {
    await seedTelemetryEvents(stateDir, [
      { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
    ]);

    const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

    expect(result.success).toBe(true);
    const data = result.data as { tools: Array<Record<string, unknown>> };
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0]).toHaveProperty('actionErrors');
    expect(data.tools[0].actionErrors).toBe(0);
    expect(data.tools[0]).toHaveProperty('actionErrorBreakdown');
    expect(data.tools[0].actionErrorBreakdown).toEqual({});
  });

  /** The test wraps `result.data` in a complete envelope, so the parse fails only for a fault in the data. */
  it('handleViewTelemetry_CompactEntry_ConformsToTelemetryViewOutputSchema', async () => {
    await seedTelemetryEvents(stateDir, [
      { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
      { tool: 'workflow_get', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
    ]);

    const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

    expect(result.success).toBe(true);

    const { TelemetryViewOutputSchema } = await import('../../../../src/registry.js');
    const envelope = {
      success: true as const,
      data: result.data,
      next_actions: [],
      _meta: {},
      _perf: { ms: 0, bytes: 0, tokens: 0 },
    };
    const parsed = TelemetryViewOutputSchema.safeParse(envelope);
    expect(parsed.success).toBe(true);
  });
});

/**
 * With a correlation filter, `handleViewTelemetry` passes `operationId`,
 * `correlationId` and `causationId` to `EventStore.query` on the telemetry stream.
 * The view then folds only the events of that dispatch boundary.
 * `TELEMETRY_STREAM_NAME` copies `TELEMETRY_STREAM` of `constants.ts`.
 */
describe('Wave 5 — handleViewTelemetry honors correlation filters (#1437)', () => {
  let stateDir: string;
  const TELEMETRY_STREAM_NAME = 'telemetry';

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('handleViewTelemetry_WithCorrelationIdFilter_RolsUpOnlyMatchingEvents', async () => {
    const store = new EventStore(stateDir);
    for (let i = 1; i <= 2; i++) {
      await store.append(TELEMETRY_STREAM_NAME, {
        streamId: TELEMETRY_STREAM_NAME,
        sequence: i,
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
    }
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 3,
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

    const result = await handleViewTelemetry(
      { correlationId: 'cor-X' },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as {
      session: { totalInvocations: number; totalTokens: number };
      tools: Array<{ tool: string; invocations: number }>;
    };
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('tool_X');
    expect(data.tools[0].invocations).toBe(2);
    expect(data.session.totalInvocations).toBe(2);
  });

  it('handleViewTelemetry_WithOperationIdFilter_RolsUpOnlyMatchingEvents', async () => {
    const store = new EventStore(stateDir);
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-A',
      correlationId: 'cor-shared',
      data: { tool: 'tool_A', durationMs: 10, responseBytes: 100, tokenEstimate: 25 },
      schemaVersion: '1.0',
    });
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      operationId: 'op-B',
      correlationId: 'cor-shared',
      data: { tool: 'tool_B', durationMs: 20, responseBytes: 200, tokenEstimate: 50 },
      schemaVersion: '1.0',
    });

    const result = await handleViewTelemetry(
      { operationId: 'op-A' },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { tools: Array<{ tool: string }> };
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('tool_A');
  });

  it('handleViewTelemetry_WithCausationIdFilter_RolsUpOnlyMatchingEvents', async () => {
    const store = new EventStore(stateDir);
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      causationId: 'cause-A',
      correlationId: 'cor-shared',
      data: { tool: 'tool_A', durationMs: 10, responseBytes: 100, tokenEstimate: 25 },
      schemaVersion: '1.0',
    });
    await store.append(TELEMETRY_STREAM_NAME, {
      streamId: TELEMETRY_STREAM_NAME,
      sequence: 2,
      timestamp: new Date().toISOString(),
      type: 'tool.completed',
      causationId: 'cause-B',
      correlationId: 'cor-shared',
      data: { tool: 'tool_B', durationMs: 20, responseBytes: 200, tokenEstimate: 50 },
      schemaVersion: '1.0',
    });

    const result = await handleViewTelemetry(
      { causationId: 'cause-A' },
      stateDir,
      store,
    );

    expect(result.success).toBe(true);
    const data = result.data as { tools: Array<{ tool: string }> };
    expect(data.tools).toHaveLength(1);
    expect(data.tools[0].tool).toBe('tool_A');
  });
});

describe('Telemetry projection registered in materializer', () => {
  beforeEach(() => {
    resetMaterializerCache();
  });

  it('should have telemetry view registered after materializer creation', () => {
    const materializer = getOrCreateMaterializer('/tmp/test-mat-telemetry');

    expect(materializer.hasProjection(TELEMETRY_VIEW)).toBe(true);
  });
});

