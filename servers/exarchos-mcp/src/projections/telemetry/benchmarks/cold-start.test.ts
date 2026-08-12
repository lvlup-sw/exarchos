import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ViewMaterializer } from '../../views/materializer.js';
import { SnapshotStore } from '../../views/snapshot-store.js';
import {
  workflowStatusProjection,
  WORKFLOW_STATUS_VIEW,
} from '../../views/workflow-status-view.js';
import { generateWorkflowEvents } from './cold-start.js';

const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === 'true';

// ─── Benchmark Suite ──────────────────────────────────────────────────────

describe('Cold-Start Latency Benchmarks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cold-start-bench-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Full Replay (No Snapshot) ────────────────────────────────────────

  describe('full replay (no snapshot)', () => {
    for (const eventCount of [10, 50, 100, 500]) {
      it.skipIf(!RUN_BENCHMARKS)(
        `materialize_ColdStartNoSnapshot_${eventCount}Events_CompletesWithinThreshold`,
        async () => {
          // Arrange
          const streamId = 'bench-replay';
          const events = generateWorkflowEvents(streamId, eventCount);
          const materializer = new ViewMaterializer();
          materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);

          // Act
          const start = performance.now();
          const view = materializer.materialize(
            streamId,
            WORKFLOW_STATUS_VIEW,
            events,
          );
          const elapsed = performance.now() - start;

          // Assert — view was materialized correctly
          expect(view.featureId).toBe(streamId);
          expect(view.workflowType).toBe('feature');

          // Log for baseline documentation
          console.log(
            `[cold-start] full-replay ${eventCount} events: ${elapsed.toFixed(3)}ms`,
          );

          // Generous threshold — establishing baselines
          const threshold = eventCount <= 100 ? 200 : 500;
          expect(elapsed).toBeLessThan(threshold);
        },
      );
    }
  });

  // ─── 2. Snapshot-Assisted Cold Start ─────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'materialize_SnapshotAssisted100Events_CompletesUnderThreshold',
    async () => {
      // Arrange
      const streamId = 'bench-snapshot';
      const allEvents = generateWorkflowEvents(streamId, 100);
      const snapshotEvents = allEvents.slice(0, 50);
      const remainingEvents = allEvents;

      const snapshotStore = new SnapshotStore(tmpDir);

      // Phase 1: Build snapshot by materializing first 50 events
      const setupMaterializer = new ViewMaterializer({
        snapshotStore,
        snapshotInterval: 50,
      });
      setupMaterializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);
      setupMaterializer.materialize(
        streamId,
        WORKFLOW_STATUS_VIEW,
        snapshotEvents,
      );

      // Wait for fire-and-forget snapshot save to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify snapshot was actually saved
      const snapshotData = await snapshotStore.load(streamId, WORKFLOW_STATUS_VIEW);
      expect(snapshotData).toBeDefined();
      expect(snapshotData!.highWaterMark).toBe(50);

      // Phase 2: Cold start with snapshot
      const freshMaterializer = new ViewMaterializer({ snapshotStore });
      freshMaterializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);

      const start = performance.now();
      const loaded = await freshMaterializer.loadFromSnapshot(
        streamId,
        WORKFLOW_STATUS_VIEW,
      );
      const view = freshMaterializer.materialize(
        streamId,
        WORKFLOW_STATUS_VIEW,
        remainingEvents,
      );
      const snapshotElapsed = performance.now() - start;

      expect(loaded).toBe(true);
      expect(view.featureId).toBe(streamId);

      // Phase 3: Full replay for comparison
      const replayMaterializer = new ViewMaterializer();
      replayMaterializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);

      const replayStart = performance.now();
      replayMaterializer.materialize(
        streamId,
        WORKFLOW_STATUS_VIEW,
        allEvents,
      );
      const replayElapsed = performance.now() - replayStart;

      // Log for baseline documentation
      console.log(
        `[cold-start] snapshot-assisted 100 events (50 from snapshot): ${snapshotElapsed.toFixed(3)}ms`,
      );
      console.log(
        `[cold-start] full-replay 100 events (comparison): ${replayElapsed.toFixed(3)}ms`,
      );

      // Generous threshold — snapshot-assisted should be under 100ms
      expect(snapshotElapsed).toBeLessThan(100);
    },
  );

  // ─── 3. Warm Cache Hit ───────────────────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'materialize_WarmCacheHit_NearZeroLatency',
    async () => {
      // Arrange
      const streamId = 'bench-warm';
      const events = generateWorkflowEvents(streamId, 100);
      const materializer = new ViewMaterializer();
      materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);

      // First materialization (cold)
      const coldStart = performance.now();
      materializer.materialize(streamId, WORKFLOW_STATUS_VIEW, events);
      const coldElapsed = performance.now() - coldStart;

      // Act — second materialization (warm, same events)
      const warmStart = performance.now();
      const view = materializer.materialize(
        streamId,
        WORKFLOW_STATUS_VIEW,
        events,
      );
      const warmElapsed = performance.now() - warmStart;

      // Assert
      expect(view.featureId).toBe(streamId);

      // Log for baseline documentation
      console.log(
        `[cold-start] warm-cache cold: ${coldElapsed.toFixed(3)}ms, warm: ${warmElapsed.toFixed(3)}ms`,
      );

      // Warm hit should be near-zero — events filtered by high-water mark
      expect(warmElapsed).toBeLessThan(5);
    },
  );

  // ─── 4. Snapshot Load Overhead ───────────────────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'loadSnapshot_RawDiskLoad_CompletesUnder50ms',
    async () => {
      // Arrange — save a snapshot to disk
      const streamId = 'bench-snap-load';
      const snapshotStore = new SnapshotStore(tmpDir);

      // Build a view state to snapshot
      const materializer = new ViewMaterializer({
        snapshotStore,
        snapshotInterval: 1, // Force snapshot on first materialization
      });
      materializer.register(WORKFLOW_STATUS_VIEW, workflowStatusProjection);

      const events = generateWorkflowEvents(streamId, 50);
      materializer.materialize(streamId, WORKFLOW_STATUS_VIEW, events);

      // Wait for fire-and-forget snapshot save
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify snapshot exists
      const verifyData = await snapshotStore.load(streamId, WORKFLOW_STATUS_VIEW);
      expect(verifyData).toBeDefined();

      // Act — measure raw snapshot load (fresh store instance)
      const freshSnapshotStore = new SnapshotStore(tmpDir);
      const start = performance.now();
      const data = await freshSnapshotStore.load(streamId, WORKFLOW_STATUS_VIEW);
      const elapsed = performance.now() - start;

      // Assert
      expect(data).toBeDefined();
      expect(data!.highWaterMark).toBe(50);

      // Log for baseline documentation
      console.log(
        `[cold-start] snapshot-load: ${elapsed.toFixed(3)}ms`,
      );

      expect(elapsed).toBeLessThan(50);
    },
  );
});
