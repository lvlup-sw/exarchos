import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PIPELINE_VIEW, PIPELINE_SNAPSHOT_NAME } from '../../../../src/projections/views/pipeline-view.js';
import { EVENT_SCHEMA_VERSION } from '../../../../src/events/event-migration.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';

/** The `writeFile` calls that the mock records. */
const writeFileCalls: { path: string; data: string }[] = [];
let renameFailOnce = false;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    writeFile: vi.fn(async (filePath: string, data: string, encoding?: string) => {
      writeFileCalls.push({ path: filePath, data: typeof data === 'string' ? data : '' });
      return actual.writeFile(filePath, data, encoding as BufferEncoding);
    }),
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (renameFailOnce) {
        renameFailOnce = false;
        throw new Error('Simulated crash during rename');
      }
      return actual.rename(oldPath, newPath);
    }),
  };
});

/** A dynamic import, so the module loads after the mock setup. */
const { SnapshotStore } = await import('../../../../src/projections/views/snapshot-store.js');

describe('SnapshotStore atomic writes', () => {
  let tempDir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'snapshot-atomic-test-'));
    store = new SnapshotStore(tempDir);
    writeFileCalls.length = 0;
    renameFailOnce = false;
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * A rename that fails must leave the existing snapshot intact. The mock fails `rename` one time,
   * after `save` writes the temporary file. The last write must go to a `.tmp` path.
   */
  it('snapshotSave_CrashDuringWrite_DoesNotCorruptExistingSnapshot', async () => {
    const originalData = { status: 'good', count: 42 };
    await store.save('test-stream', 'myview', originalData, 5);

    const filePath = path.join(tempDir, 'test-stream.myview.snapshot.json');
    const originalContent = await readFile(filePath, 'utf-8');
    const originalParsed = JSON.parse(originalContent);
    expect(originalParsed.view).toEqual(originalData);

    writeFileCalls.length = 0;

    renameFailOnce = true;

    try {
      await store.save('test-stream', 'myview', { status: 'corrupted' }, 10);
    } catch {
    }

    const afterContent = await readFile(filePath, 'utf-8');
    const afterParsed = JSON.parse(afterContent);
    expect(afterParsed.view).toEqual(originalData);
    expect(afterParsed.highWaterMark).toBe(5);

    expect(writeFileCalls.length).toBeGreaterThan(0);
    const lastWrite = writeFileCalls[writeFileCalls.length - 1];
    expect(lastWrite.path).not.toBe(filePath);
    expect(lastWrite.path).toContain('.tmp');
  });

  /** Two saves in one millisecond once shared a temp path, so the second rename found it gone. */
  it('snapshotSave_TwoSavesInOneMillisecond_BothResolveAndTheLastIsPublished', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const results = await Promise.allSettled([
        store.save('test-stream', 'myview', { writer: 'a' }, 1),
        store.save('test-stream', 'myview', { writer: 'b' }, 2),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const saved = JSON.parse(
        await readFile(path.join(tempDir, 'test-stream.myview.snapshot.json'), 'utf-8'),
      );
      expect(saved.view).toEqual({ writer: 'b' });
    } finally {
      now.mockRestore();
    }
  });
});

describe('SnapshotStore pipeline v2 lineage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'snapshot-lineage-test-'));
  });

  afterEach(async () => {
    await rmrfAsync(tempDir);
  });

  /**
   * A snapshot under the plain `PIPELINE_VIEW` name holds no `repoRoot`. A store with the namespace
   * map does not read it. Thus `load` misses, and the materializer folds the stream from `init`.
   */
  it('PipelineSnapshot_V1LineageFile_IgnoredAndFullyRefolded', async () => {
    const streamId = 'feat-lineage';

    const v1Store = new SnapshotStore(tempDir);
    await v1Store.save(streamId, PIPELINE_VIEW, { featureId: streamId, stale: true }, 7);
    const v1Path = path.join(tempDir, `${streamId}.${PIPELINE_VIEW}.snapshot.json`);
    await expect(readFile(v1Path, 'utf-8')).resolves.toContain('stale');

    const v2Store = new SnapshotStore(tempDir, { [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME });
    const loaded = await v2Store.load(streamId, PIPELINE_VIEW);

    expect(loaded).toBeUndefined();
  });

  /** A store with the namespace map writes only the `PIPELINE_SNAPSHOT_NAME` file, and loads it back. */
  it('PipelineSnapshot_WritesV2LineageName', async () => {
    const streamId = 'feat-writes-v2';

    const v2Store = new SnapshotStore(tempDir, { [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME });
    await v2Store.save(streamId, PIPELINE_VIEW, { featureId: streamId, repoRoot: '/r' }, 3);

    const files = await readdir(tempDir);
    expect(files).toContain(`${streamId}.${PIPELINE_SNAPSHOT_NAME}.snapshot.json`);
    expect(files).not.toContain(`${streamId}.${PIPELINE_VIEW}.snapshot.json`);

    const loaded = await v2Store.load(streamId, PIPELINE_VIEW);
    expect(loaded?.view).toEqual({ featureId: streamId, repoRoot: '/r' });
  });

  /**
   * `EVENT_SCHEMA_VERSION` controls event migration, not view snapshots. A change to the snapshot
   * name must not move it. `event-migration.test.ts` holds the primary pin.
   */
  it('EventSchemaVersion_Untouched_Remains1_0', () => {
    expect(EVENT_SCHEMA_VERSION).toBe('1.0');
  });
});
