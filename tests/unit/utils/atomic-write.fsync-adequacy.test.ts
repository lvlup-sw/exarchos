/**
 * Mutation adequacy for `fsyncDirSync` and `fsyncDir`: a `synced` outcome needs a real fsync call.
 * A directory fsync leaves nothing on the filesystem that a test can read back.
 * So the mocks of `node:fs` and `node:fs/promises` record each fsync call.
 * Each mock passes all other members through to the real module.
 * A test can inject an errno to reach the error arms.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The record that the mocks fill and the tests read.
 * `syncFdCalls` holds each fd that the `fs.fsyncSync` wrapper receives, in call order.
 * `openedSyncPaths` maps each fd from `fs.openSync` to its path.
 * `handleSyncCalls` counts the `FileHandle.sync()` calls.
 * When `syncError` or `handleSyncError` is set, the wrapper throws it and does not sync.
 */
const control = vi.hoisted(() => ({
  syncFdCalls: [] as number[],
  syncError: undefined as Error | undefined,
  openedSyncPaths: new Map<number, string>(),
  handleSyncCalls: 0,
  handleSyncError: undefined as Error | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const openSync = (...args: Parameters<typeof actual.openSync>): number => {
    const fd = actual.openSync(...args);
    control.openedSyncPaths.set(fd, String(args[0]));
    return fd;
  };
  const fsyncSync = (fd: number): void => {
    control.syncFdCalls.push(fd);
    if (control.syncError !== undefined) throw control.syncError;
    actual.fsyncSync(fd);
  };
  return { ...actual, openSync, fsyncSync };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (
    ...args: Parameters<typeof actual.open>
  ): ReturnType<typeof actual.open> => {
    const handle = await actual.open(...args);
    const realSync = handle.sync.bind(handle);
    Object.defineProperty(handle, 'sync', {
      configurable: true,
      value: async (): Promise<void> => {
        control.handleSyncCalls += 1;
        if (control.handleSyncError !== undefined) throw control.handleSyncError;
        return realSync();
      },
    });
    return handle;
  };
  return { ...actual, open };
});

import { mkdtempSync } from 'node:fs';
import {
  DIRECTORY_SYNC_UNSUPPORTED_CODES,
  fsyncDir,
  fsyncDirSync,
} from '../../../src/utils/atomic-write.js';

function errno(code: string): NodeJS.ErrnoException {
  const err = new Error(`injected ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

const IS_WIN32 = process.platform === 'win32';

beforeEach(() => {
  control.syncFdCalls.length = 0;
  control.syncError = undefined;
  control.openedSyncPaths.clear();
  control.handleSyncCalls = 0;
  control.handleSyncError = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fsyncDirSync — the syscall is call-verified, not assumed', () => {
  /**
   * win32 cannot fsync a directory, so the `synced` arm exists only on POSIX.
   * The test expects one fsync, on the fd that was opened on the directory.
   * A mutant that skips the fsync and still returns `synced` records zero calls.
   */
  it.skipIf(IS_WIN32)(
    'FsyncDirSync_Synced_IsClaimedOnlyAfterFsyncingTheDirectoryFd',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));

      const outcome = fsyncDirSync(dir);

      expect(outcome).toEqual({ directory: dir, status: 'synced' });
      expect(control.syncFdCalls.length).toBe(1);
      expect(control.openedSyncPaths.get(control.syncFdCalls[0]!)).toBe(dir);
    },
  );

  /** `EIO` is not in the unsupported set, so it is a real fault and must propagate. */
  it('FsyncDirSync_FsyncFailsWithRealFault_PropagatesInsteadOfClaimingSynced', () => {
    expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).not.toContain('EIO');
    const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));
    control.syncError = errno('EIO');

    expect(() => fsyncDirSync(dir)).toThrow(/injected EIO/);
    expect(control.syncFdCalls.length).toBe(1);
  });

  /** `ENOSYS` is in the unsupported set, so the outcome carries the code and is not `synced`. */
  it('FsyncDirSync_FsyncDeclinedByHost_DegradesToExplicitUnsupported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));
    control.syncError = errno('ENOSYS');

    const outcome = fsyncDirSync(dir);

    expect(outcome).toEqual({ directory: dir, status: 'unsupported', code: 'ENOSYS' });
    expect(control.syncFdCalls.length).toBe(1);
  });
});

describe('fsyncDir — the async twin is call-verified through FileHandle.sync()', () => {
  it.skipIf(IS_WIN32)(
    'FsyncDir_Synced_IsClaimedOnlyAfterTheHandleSyncCall',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));

      const outcome = await fsyncDir(dir);

      expect(outcome).toEqual({ directory: dir, status: 'synced' });
      expect(control.handleSyncCalls).toBe(1);
    },
  );

  it('FsyncDir_SyncFailsWithRealFault_PropagatesInsteadOfClaimingSynced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));
    control.handleSyncError = errno('EIO');

    await expect(fsyncDir(dir)).rejects.toThrow(/injected EIO/);
    expect(control.handleSyncCalls).toBe(1);
  });

  it('FsyncDir_SyncDeclinedByHost_DegradesToExplicitUnsupported', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));
    control.handleSyncError = errno('EOPNOTSUPP');

    const outcome = await fsyncDir(dir);

    expect(outcome).toEqual({
      directory: dir,
      status: 'unsupported',
      code: 'EOPNOTSUPP',
    });
    expect(control.handleSyncCalls).toBe(1);
  });
});
