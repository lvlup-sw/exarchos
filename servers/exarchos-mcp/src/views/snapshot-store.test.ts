import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

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
