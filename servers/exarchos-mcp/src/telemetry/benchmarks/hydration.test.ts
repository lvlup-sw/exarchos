import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { hydrateStream, hydrateAll } from '../../storage/hydration.js';
import { SqliteBackend } from '../../storage/sqlite-backend.js';
import { generateWorkflowEvents } from './cold-start.js';

const RUN_BENCHMARKS = process.env.RUN_BENCHMARKS === 'true';

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeJsonlFile(dir: string, streamId: string, events: unknown[]): void {
  const filePath = path.join(dir, `${streamId}.events.jsonl`);
  const content = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(filePath, content, 'utf-8');
}

// ─── Benchmark Suite ────────────────────────────────────────────────────────

describe('Hydration Benchmarks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydration-bench-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── 1. Single Stream Hydration (100 Events) ─────────────────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'hydrateStream_100Events_CompletesWithinThreshold',
    async () => {
      // Arrange
      const streamId = 'bench-hydrate';
      const events = generateWorkflowEvents(streamId, 100);
      writeJsonlFile(tmpDir, streamId, events);

      const backend = new SqliteBackend(':memory:');
      backend.initialize();

      // Act
      const start = performance.now();
      await hydrateStream(backend, tmpDir, streamId);
      const elapsed = performance.now() - start;

      // Assert — all events were hydrated
      const hydrated = backend.queryEvents(streamId);
      expect(hydrated).toHaveLength(100);

      console.log(`[hydration] single-stream 100 events: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(500);

      backend.close();
    },
  );

  // ─── 2. Delta Hydration (100 Events, 50 Already in DB) ───────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'hydrateStream_DeltaHydration50New_CompletesWithinThreshold',
    async () => {
      // Arrange — pre-populate backend with first 50 events
      const streamId = 'bench-delta';
      const allEvents = generateWorkflowEvents(streamId, 100);
      writeJsonlFile(tmpDir, streamId, allEvents);

      const backend = new SqliteBackend(':memory:');
      backend.initialize();

      // Insert first 50 events directly into backend
      for (const event of allEvents.slice(0, 50)) {
        backend.appendEvent(streamId, event);
      }

      // Verify pre-population
      const prePop = backend.queryEvents(streamId);
      expect(prePop).toHaveLength(50);

      // Act — hydrate should only process events 51-100
      const start = performance.now();
      await hydrateStream(backend, tmpDir, streamId);
      const elapsed = performance.now() - start;

      // Assert — all 100 events now in backend
      const hydrated = backend.queryEvents(streamId);
      expect(hydrated).toHaveLength(100);

      console.log(`[hydration] delta 50 new events: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(300);

      backend.close();
    },
  );

  // ─── 3. Multi-Stream Hydration (10 Streams x 20 Events) ──────────────────

  it.skipIf(!RUN_BENCHMARKS)(
    'hydrateAll_10Streams20Events_CompletesWithinThreshold',
    async () => {
      // Arrange — write 10 JSONL files, each with 20 events
      for (let i = 0; i < 10; i++) {
        const streamId = `bench-multi-${i}`;
        const events = generateWorkflowEvents(streamId, 20);
        writeJsonlFile(tmpDir, streamId, events);
      }

      const backend = new SqliteBackend(':memory:');
      backend.initialize();

      // Act
      const start = performance.now();
      await hydrateAll(backend, tmpDir);
      const elapsed = performance.now() - start;

      // Assert — all 10 streams hydrated with 20 events each
      const streams = backend.listStreams();
      expect(streams).toHaveLength(10);
      for (const streamId of streams) {
        const events = backend.queryEvents(streamId);
        expect(events).toHaveLength(20);
      }

      console.log(`[hydration] multi-stream 10x20 events: ${elapsed.toFixed(3)}ms`);
      expect(elapsed).toBeLessThan(1000);

      backend.close();
    },
  );
});
