import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventStore } from '../../events/store.js';
import { handleViewTelemetry } from './tools.js';
import { getOrCreateMaterializer, resetMaterializerCache } from '../views/tools.js';
import { TELEMETRY_VIEW } from './telemetry-projection.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

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

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  describe('compact mode (default)', () => {
    it('should return summary without rolling window arrays', async () => {
      // Arrange
      await seedTelemetryEvents(stateDir, [
        { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
        { tool: 'workflow_get', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
      ]);

      // Act
      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({ compact: false }, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({ tool: 'event_query' }, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({ sort: 'tokens' }, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({ sort: 'invocations' }, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({ sort: 'duration' }, stateDir, new EventStore(stateDir));

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
      new EventStore(stateDir),
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
      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

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
      const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

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
      // v2.11 Phase 3 (substrate-cut): the previous fixture planted a
      // corrupt `*.events.jsonl` file to provoke a JSON.parse failure
      // inside the JSONL read path. That path is gone — the SQLite
      // substrate stores rows, not lines, and there is no analogous
      // "corrupt this file to make the read throw" affordance. Stub the
      // materializer's query path directly to force the handler's
      // error branch instead.
      const badDir = await createTempDir();
      resetMaterializerCache();

      try {
        const store = new EventStore(badDir);
        // Force `query()` to throw so handleViewTelemetry's catch path
        // surfaces a structured error result.
        const queryStub = vi
          .spyOn(store, 'query')
          .mockRejectedValue(new Error('synthetic materializer failure'));

        const result = await handleViewTelemetry({}, badDir, store);

        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
        expect(result.error?.code).toBe('VIEW_ERROR');

        queryStub.mockRestore();
      } finally {
        // Don't leak temp dirs across runs — see CR review 4178011813.
        await rmrfAsync(badDir);
      }
    });
  });
});

// DR-8 / B-4 (Task 014) — the audit found `view telemetry --compact` was a
// no-op: it measured ~85 tok whether or not `--compact` was passed, because the
// telemetry handler was already compact-by-default and only the counter-
// intuitive legacy `compact: false` restored the heavy rolling-window arrays.
// The fix aligns the handler to the 013/024 view contract: `detail: true` is
// the explicit full-restore path, so `compact: true` measurably reduces output
// relative to the `detail: true` response on a populated store.
describe('DR-8 / B-4 — telemetry --compact reduces output (Task 014)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  // Populate the store so the per-tool rolling-window arrays
  // (durations/sizes/tokenEstimates) hold enough entries to make the full
  // response measurably heavier than the compact one.
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

  it('viewTelemetry_CompactFlag_ReducesMeasuredOutput', async () => {
    // Arrange
    await seedPopulated();

    // Act — the `detail: true` response is the full baseline; `compact: true`
    // is the flag under test.
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

    // Assert — both succeed, and compact is strictly smaller (the no-op fixed).
    expect(full.success).toBe(true);
    expect(compact.success).toBe(true);
    expect(measureTokens(compact)).toBeLessThan(measureTokens(full));

    // The heavy rolling-window arrays are the sub-structure that shrinks:
    // present under detail, stripped under compact.
    const fullTools = (full.data as { tools: Array<Record<string, unknown>> }).tools;
    const compactTools = (compact.data as { tools: Array<Record<string, unknown>> }).tools;
    expect(fullTools[0]).toHaveProperty('durations');
    expect(compactTools[0]).not.toHaveProperty('durations');

    // Verdict/summary fields survive the compaction unchanged (only detail
    // volume differs).
    const fullSession = (full.data as { session: Record<string, unknown> }).session;
    const compactSession = (compact.data as { session: Record<string, unknown> }).session;
    expect(compactSession).toEqual(fullSession);
  });

  it('viewTelemetry_DefaultAndCompact_AreEquivalentCompactByDefault', async () => {
    // Compact-by-default: passing no flag is the same lean shape as `compact: true`.
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

// Sentry follow-up on PR #1393: the registered `TelemetryViewOutputSchema`
// requires `actionErrors` (number) and `actionErrorBreakdown` (record) on
// every tool entry, but the `toToolEntry` builder forgot to copy these
// from the projection metrics. The omission would cause
// `validateAgainstActionSchema` to surface
// INTERNAL_ERROR/outputSchemaViolation for any `view.telemetry` call that
// returned at least one tool entry, swallowing the telemetry payload.
describe('toToolEntry — action-error fields (Sentry follow-up #1364)', () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('handleViewTelemetry_CompactEntry_IncludesActionErrorFields', async () => {
    await seedTelemetryEvents(stateDir, [
      { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
    ]);

    const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

    expect(result.success).toBe(true);
    const data = result.data as { tools: Array<Record<string, unknown>> };
    expect(data.tools).toHaveLength(1);
    // No action errors seeded → both fields present, but zero-valued.
    expect(data.tools[0]).toHaveProperty('actionErrors');
    expect(data.tools[0].actionErrors).toBe(0);
    expect(data.tools[0]).toHaveProperty('actionErrorBreakdown');
    expect(data.tools[0].actionErrorBreakdown).toEqual({});
  });

  it('handleViewTelemetry_CompactEntry_ConformsToTelemetryViewOutputSchema', async () => {
    await seedTelemetryEvents(stateDir, [
      { tool: 'workflow_get', durationMs: 10, responseBytes: 200, tokenEstimate: 50 },
      { tool: 'workflow_get', durationMs: 20, responseBytes: 400, tokenEstimate: 100 },
    ]);

    const result = await handleViewTelemetry({}, stateDir, new EventStore(stateDir));

    expect(result.success).toBe(true);

    // The registered TelemetryViewOutputSchema is the load-bearing
    // contract — if any required field is missing, the dispatch
    // pipeline's validateAgainstActionSchema will return
    // INTERNAL_ERROR/outputSchemaViolation. Round-trip through a
    // properly-shaped envelope so the assertion catches missing entry
    // fields without false positives on optional envelope members.
    const { TelemetryViewOutputSchema } = await import('../../registry.js');
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

// ─── Wave 5 / Task 13 (#1437) — telemetry view honors correlation filters ─
//
// The telemetry handler differs from the other Group A actions in that it
// does NOT go through `queryDeltaEvents` — it reads the telemetry stream
// directly via `store.query(TELEMETRY_STREAM)`. The Wave 4 filter API extends
// `EventStore.query`'s second arg; this suite pins that `handleViewTelemetry`
// threads the new `operationId / correlationId / causationId` args into that
// call so callers can slice telemetry rollups by dispatch boundary.
describe('Wave 5 — handleViewTelemetry honors correlation filters (#1437)', () => {
  let stateDir: string;
  const TELEMETRY_STREAM_NAME = 'telemetry'; // mirror constants.ts

  beforeEach(async () => {
    stateDir = await createTempDir();
    resetMaterializerCache();
  });

  afterEach(async () => {
    await rmrfAsync(stateDir);
  });

  it('handleViewTelemetry_WithCorrelationIdFilter_RolsUpOnlyMatchingEvents', async () => {
    // GIVEN: telemetry events for two correlation boundaries. Pre-filter, the
    // view would aggregate both tools; post-filter it should aggregate only
    // the cor-X tool.
    const store = new EventStore(stateDir);
    // cor-X: two invocations of `tool_X`
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
    // cor-Y: one invocation of `tool_Y`
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

    // WHEN: handler invoked with a correlationId filter
    const result = await handleViewTelemetry(
      { correlationId: 'cor-X' },
      stateDir,
      store,
    );

    // THEN: only tool_X is rolled up; tool_Y is absent.
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
    // Act — create a materializer (which calls createMaterializer internally)
    const materializer = getOrCreateMaterializer('/tmp/test-mat-telemetry');

    // Assert
    expect(materializer.hasProjection(TELEMETRY_VIEW)).toBe(true);
  });
});

