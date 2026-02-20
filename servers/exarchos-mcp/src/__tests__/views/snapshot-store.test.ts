import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SnapshotStore } from '../../views/snapshot-store.js';
import type { SnapshotData } from '../../views/snapshot-store.js';

// ─── Snapshot Store Tests ──────────────────────────────────────────────────

describe('SnapshotStore', () => {
  let tempDir: string;
  let store: SnapshotStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'snapshot-store-test-'));
    store = new SnapshotStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // ─── 1. save_ValidData_WritesJsonFile ──────────────────────────────────

  describe('save_ValidData_WritesJsonFile', () => {
    it('should save a snapshot and write a valid JSON file to disk', async () => {
      const viewData = { status: 'active', count: 42 };

      await store.save('test-stream', 'workflow', viewData, 5);

      const filePath = path.join(tempDir, 'test-stream.workflow.snapshot.json');
      const content = await readFile(filePath, 'utf-8');
      const parsed = JSON.parse(content) as SnapshotData<typeof viewData>;

      expect(parsed.view).toEqual(viewData);
      expect(parsed.highWaterMark).toBe(5);
      expect(parsed.savedAt).toBeDefined();
      expect(typeof parsed.savedAt).toBe('string');
    });
  });

  // ─── 2. load_ExistingSnapshot_ReturnsData ──────────────────────────────

  describe('load_ExistingSnapshot_ReturnsData', () => {
    it('should load a previously saved snapshot with correct roundtrip data integrity', async () => {
      const viewData = { phase: 'delegate', tasks: ['a', 'b', 'c'] };

      await store.save('my-feature', 'taskview', viewData, 10);

      const loaded = await store.load<typeof viewData>('my-feature', 'taskview');

      expect(loaded).toBeDefined();
      expect(loaded!.view).toEqual(viewData);
      expect(loaded!.highWaterMark).toBe(10);
      expect(loaded!.savedAt).toBeDefined();
    });
  });

  // ─── 3. load_MissingFile_ReturnsUndefined ──────────────────────────────

  describe('load_MissingFile_ReturnsUndefined', () => {
    it('should return undefined when loading a snapshot that does not exist', async () => {
      const result = await store.load('nonexistent-stream', 'noview');

      expect(result).toBeUndefined();
    });
  });

  // ─── 4. load_CorruptJson_ReturnsUndefined ──────────────────────────────

  describe('load_CorruptJson_ReturnsUndefined', () => {
    it('should return undefined when the snapshot file contains invalid JSON', async () => {
      const filePath = path.join(tempDir, 'corrupt-stream.badview.snapshot.json');
      await writeFile(filePath, '{ this is not valid json !!!', 'utf-8');

      const result = await store.load('corrupt-stream', 'badview');

      expect(result).toBeUndefined();
    });
  });

  // ─── 5. load_MissingHighWaterMark_ReturnsUndefined ─────────────────────

  describe('load_MissingHighWaterMark_ReturnsUndefined', () => {
    it('should return undefined when the snapshot file is missing the highWaterMark field', async () => {
      const filePath = path.join(tempDir, 'incomplete-stream.partial.snapshot.json');
      const incompleteData = {
        view: { some: 'data' },
        savedAt: new Date().toISOString(),
        // highWaterMark intentionally omitted
      };
      await writeFile(filePath, JSON.stringify(incompleteData), 'utf-8');

      const result = await store.load('incomplete-stream', 'partial');

      expect(result).toBeUndefined();
    });
  });

  // ─── 6. getSnapshotPath_InvalidStreamId_ThrowsError ────────────────────

  describe('getSnapshotPath_InvalidStreamId_ThrowsError', () => {
    it('should throw an error when streamId contains unsafe characters', async () => {
      await expect(
        store.save('invalid_stream!', 'view', {}, 0),
      ).rejects.toThrow(/Invalid streamId/);
    });

    it('should throw an error when streamId contains uppercase letters', async () => {
      await expect(
        store.save('InvalidStream', 'view', {}, 0),
      ).rejects.toThrow(/Invalid streamId/);
    });

    it('should throw an error when streamId contains spaces', async () => {
      await expect(
        store.save('stream with spaces', 'view', {}, 0),
      ).rejects.toThrow(/Invalid streamId/);
    });
  });

  // ─── 7. getSnapshotPath_InvalidViewName_ThrowsError ────────────────────

  describe('getSnapshotPath_InvalidViewName_ThrowsError', () => {
    it('should throw an error when viewName contains unsafe characters', async () => {
      await expect(
        store.save('valid-stream', 'bad/view', {}, 0),
      ).rejects.toThrow(/Invalid viewName/);
    });

    it('should throw an error when viewName contains dots', async () => {
      await expect(
        store.save('valid-stream', 'view.name', {}, 0),
      ).rejects.toThrow(/Invalid viewName/);
    });
  });

  // ─── 8. getSnapshotPath_PathTraversal_ThrowsError ──────────────────────

  describe('getSnapshotPath_PathTraversal_ThrowsError', () => {
    it('should throw when streamId contains path traversal sequence', async () => {
      await expect(
        store.save('../escape', 'view', {}, 0),
      ).rejects.toThrow(/Invalid streamId/);
    });

    it('should throw when viewName contains path traversal sequence', async () => {
      await expect(
        store.save('valid-stream', '../escape', {}, 0),
      ).rejects.toThrow(/Invalid viewName/);
    });

    it('should throw when streamId is an empty string', async () => {
      await expect(
        store.save('', 'view', {}, 0),
      ).rejects.toThrow(/Invalid streamId/);
    });

    it('should throw when viewName is an empty string', async () => {
      await expect(
        store.save('valid-stream', '', {}, 0),
      ).rejects.toThrow(/Invalid viewName/);
    });
  });

  // ─── 9. save_CreatesDirectory_IfMissing ────────────────────────────────

  describe('save_CreatesDirectory_IfMissing', () => {
    it('should create the directory recursively when it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'deep', 'dir');
      const nestedStore = new SnapshotStore(nestedDir);

      await nestedStore.save('stream-id', 'viewname', { key: 'value' }, 3);

      const loaded = await nestedStore.load<{ key: string }>('stream-id', 'viewname');
      expect(loaded).toBeDefined();
      expect(loaded!.view).toEqual({ key: 'value' });
      expect(loaded!.highWaterMark).toBe(3);
    });
  });

  // ─── 10. load_HighWaterMarkPreserved_AcrossRoundtrip ───────────────────

  describe('load_HighWaterMarkPreserved_AcrossRoundtrip', () => {
    it('should preserve the exact highWaterMark value through save and load', async () => {
      const highWaterMarks = [0, 1, 100, 999999];

      for (const hwm of highWaterMarks) {
        await store.save('hwm-stream', 'hwmview', { data: hwm }, hwm);

        const loaded = await store.load<{ data: number }>('hwm-stream', 'hwmview');

        expect(loaded).toBeDefined();
        expect(loaded!.highWaterMark).toBe(hwm);
        expect(loaded!.view.data).toBe(hwm);
      }
    });
  });

  // ─── 11. save_OverwritesExistingSnapshot ───────────────────────────────

  describe('save_OverwritesExistingSnapshot', () => {
    it('should overwrite a previous snapshot when saving to the same stream and view', async () => {
      await store.save('overwrite-stream', 'myview', { version: 1 }, 5);
      await store.save('overwrite-stream', 'myview', { version: 2 }, 10);

      const loaded = await store.load<{ version: number }>('overwrite-stream', 'myview');

      expect(loaded).toBeDefined();
      expect(loaded!.view).toEqual({ version: 2 });
      expect(loaded!.highWaterMark).toBe(10);
    });
  });

  // ─── 12. load_ValidJson_MissingViewField_ReturnsUndefined ──────────────

  describe('load_ValidJson_MissingViewField_ReturnsUndefined', () => {
    it('should return undefined when the snapshot has a valid highWaterMark but view is undefined', async () => {
      const filePath = path.join(tempDir, 'noview-stream.noview.snapshot.json');
      const dataWithoutView = {
        highWaterMark: 5,
        savedAt: new Date().toISOString(),
        // view intentionally omitted
      };
      await writeFile(filePath, JSON.stringify(dataWithoutView), 'utf-8');

      const result = await store.load('noview-stream', 'noview');

      expect(result).toBeUndefined();
    });
  });

  // ─── 13. save_savedAt_IsISOString ──────────────────────────────────────

  describe('save_savedAt_IsISOString', () => {
    it('should write a valid ISO 8601 timestamp in the savedAt field', async () => {
      await store.save('time-stream', 'timeview', { x: 1 }, 1);

      const loaded = await store.load<{ x: number }>('time-stream', 'timeview');

      expect(loaded).toBeDefined();
      expect(loaded!.savedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });
  });

  // ─── 14. load_NonNumberHighWaterMark_ReturnsUndefined ──────────────────

  describe('load_NonNumberHighWaterMark_ReturnsUndefined', () => {
    it('should return undefined when highWaterMark is a string instead of a number', async () => {
      const filePath = path.join(tempDir, 'bad-hwm.badtype.snapshot.json');
      const badData = {
        view: { ok: true },
        highWaterMark: 'not-a-number',
        savedAt: new Date().toISOString(),
      };
      await writeFile(filePath, JSON.stringify(badData), 'utf-8');

      const result = await store.load('bad-hwm', 'badtype');

      expect(result).toBeUndefined();
    });
  });

  // ─── 15. delete_ExistingSnapshot_RemovesFile ──────────────────────────────

  describe('delete_ExistingSnapshot_RemovesFile', () => {
    it('should remove an existing snapshot file so load returns undefined', async () => {
      await store.save('del-stream', 'myview', { x: 1 }, 5);

      // Confirm it exists
      const before = await store.load('del-stream', 'myview');
      expect(before).toBeDefined();

      // Delete it
      await store.delete('del-stream', 'myview');

      // Confirm it's gone
      const after = await store.load('del-stream', 'myview');
      expect(after).toBeUndefined();
    });
  });

  // ─── 16. delete_NonExistentSnapshot_NoError ───────────────────────────────

  describe('delete_NonExistentSnapshot_NoError', () => {
    it('should not throw when deleting a snapshot that does not exist', async () => {
      // Should be idempotent — no error
      await expect(
        store.delete('nonexistent-stream', 'noview'),
      ).resolves.toBeUndefined();
    });
  });

  // ─── 17. deleteAllForStream_MultipleSnapshots_RemovesAll ──────────────────

  describe('deleteAllForStream_MultipleSnapshots_RemovesAll', () => {
    it('should remove all snapshots for a given stream across different views', async () => {
      await store.save('multi-stream', 'viewa', { a: 1 }, 1);
      await store.save('multi-stream', 'viewb', { b: 2 }, 2);
      await store.save('multi-stream', 'viewc', { c: 3 }, 3);

      await store.deleteAllForStream('multi-stream');

      expect(await store.load('multi-stream', 'viewa')).toBeUndefined();
      expect(await store.load('multi-stream', 'viewb')).toBeUndefined();
      expect(await store.load('multi-stream', 'viewc')).toBeUndefined();
    });
  });

  // ─── 18. deleteAllForStream_DoesNotTouchOtherStreams ───────────────────────

  describe('deleteAllForStream_DoesNotTouchOtherStreams', () => {
    it('should not delete snapshots belonging to other streams', async () => {
      await store.save('stream-a', 'myview', { a: 1 }, 1);
      await store.save('stream-b', 'myview', { b: 2 }, 2);

      await store.deleteAllForStream('stream-a');

      expect(await store.load('stream-a', 'myview')).toBeUndefined();
      expect(await store.load('stream-b', 'myview')).toBeDefined();
    });
  });

  // ─── 19. deleteAllForStream_ReturnsDeletedFileNames ───────────────────────

  describe('deleteAllForStream_ReturnsDeletedFileNames', () => {
    it('should return the array of deleted file names', async () => {
      await store.save('ret-stream', 'viewa', { a: 1 }, 1);
      await store.save('ret-stream', 'viewb', { b: 2 }, 2);

      const deleted = await store.deleteAllForStream('ret-stream');

      expect(deleted).toHaveLength(2);
      expect(deleted.sort()).toEqual([
        'ret-stream.viewa.snapshot.json',
        'ret-stream.viewb.snapshot.json',
      ]);
    });
  });

  // ─── 20. deleteAllForStream_ExactPrefixMatch_NoFalsePositives ─────────────

  describe('deleteAllForStream_ExactPrefixMatch_NoFalsePositives', () => {
    it('should not delete snapshots for streams with a matching prefix but different id', async () => {
      await store.save('my-feature', 'myview', { a: 1 }, 1);
      await store.save('my-feature-2', 'myview', { b: 2 }, 2);

      await store.deleteAllForStream('my-feature');

      expect(await store.load('my-feature', 'myview')).toBeUndefined();
      expect(await store.load('my-feature-2', 'myview')).toBeDefined();
    });
  });
});
