import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PIPELINE_VIEW, PIPELINE_SNAPSHOT_NAME } from './pipeline-view.js';
import { EVENT_SCHEMA_VERSION } from '../../events/event-migration.js';

// Track writeFile and rename calls from inside snapshot-store
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

// Import AFTER mock setup
const { SnapshotStore } = await import('./snapshot-store.js');

// ─── Atomic Snapshot Write Tests ──────────────────────────────────────────────

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
    await rm(tempDir, { recursive: true, force: true });
  });

  it('snapshotSave_CrashDuringWrite_DoesNotCorruptExistingSnapshot', async () => {
    // Arrange: save a valid snapshot first
    const originalData = { status: 'good', count: 42 };
    await store.save('test-stream', 'myview', originalData, 5);

    // Verify the original file exists and is valid
    const filePath = path.join(tempDir, 'test-stream.myview.snapshot.json');
    const originalContent = await readFile(filePath, 'utf-8');
    const originalParsed = JSON.parse(originalContent);
    expect(originalParsed.view).toEqual(originalData);

    // Clear tracked calls to focus on the second save
    writeFileCalls.length = 0;

    // Act: make rename fail to simulate crash after write but before rename
    renameFailOnce = true;

    try {
      await store.save('test-stream', 'myview', { status: 'corrupted' }, 10);
    } catch {
      // Expected to throw if using atomic pattern
    }

    // Assert: the original file must NOT be corrupted.
    // If save() writes directly to the target file (current buggy behavior),
    // the original content is already overwritten.
    // If save() uses tmp+rename (desired atomic behavior), the original is preserved.
    const afterContent = await readFile(filePath, 'utf-8');
    const afterParsed = JSON.parse(afterContent);
    expect(afterParsed.view).toEqual(originalData);
    expect(afterParsed.highWaterMark).toBe(5);

    // Verify the write went to a tmp file, not the target directly
    expect(writeFileCalls.length).toBeGreaterThan(0);
    const lastWrite = writeFileCalls[writeFileCalls.length - 1];
    expect(lastWrite.path).not.toBe(filePath);
    expect(lastWrite.path).toContain('.tmp');
  });
});

// ─── DR-5/DR-6: versioned pipeline snapshot lineage ──────────────────────────

describe('SnapshotStore pipeline v2 lineage', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'snapshot-lineage-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('PipelineSnapshot_V1LineageFile_IgnoredAndFullyRefolded', async () => {
    const streamId = 'feat-lineage';

    // A pre-upgrade server persisted a v1 pipeline snapshot under the
    // un-namespaced projection name (no repoRoot on the cached view).
    const v1Store = new SnapshotStore(tempDir);
    await v1Store.save(streamId, PIPELINE_VIEW, { featureId: streamId, stale: true }, 7);
    const v1Path = path.join(tempDir, `${streamId}.${PIPELINE_VIEW}.snapshot.json`);
    await expect(readFile(v1Path, 'utf-8')).resolves.toContain('stale');

    // A new server reads the pipeline view through the v2 namespace map.
    const v2Store = new SnapshotStore(tempDir, { [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME });
    const loaded = await v2Store.load(streamId, PIPELINE_VIEW);

    // The stale v1 snapshot is NOT consulted — load misses, so the materializer
    // re-folds the stream from init (picking up repoRoot) instead of resuming a
    // pre-upgrade fold that lacks it.
    expect(loaded).toBeUndefined();
  });

  it('PipelineSnapshot_WritesV2LineageName', async () => {
    const streamId = 'feat-writes-v2';

    const v2Store = new SnapshotStore(tempDir, { [PIPELINE_VIEW]: PIPELINE_SNAPSHOT_NAME });
    await v2Store.save(streamId, PIPELINE_VIEW, { featureId: streamId, repoRoot: '/r' }, 3);

    const files = await readdir(tempDir);
    // Snapshots land under the versioned filename, never the legacy one.
    expect(files).toContain(`${streamId}.${PIPELINE_SNAPSHOT_NAME}.snapshot.json`);
    expect(files).not.toContain(`${streamId}.${PIPELINE_VIEW}.snapshot.json`);

    // Round-trips through the same namespaced store.
    const loaded = await v2Store.load(streamId, PIPELINE_VIEW);
    expect(loaded?.view).toEqual({ featureId: streamId, repoRoot: '/r' });
  });

  it('EventSchemaVersion_Untouched_Remains1_0', () => {
    // The round-2 refuted mechanism bumped EVENT_SCHEMA_VERSION to force
    // snapshot re-folds. The v2 snapshot lineage replaces that entirely: this
    // constant drives event migration / upcasting, NOT view snapshots, and MUST
    // stay put. (The primary pin lives in event-migration.test.ts; this guards
    // the constant from the view-side change specifically.)
    expect(EVENT_SCHEMA_VERSION).toBe('1.0');
  });
});
