// ─── T-23 mutation adequacy — `synced` must be EARNED by the real fsync call ──
//
// A mutant that deletes `fs.fsyncSync(fd)` inside `fsyncDirSync` (or
// `handle.sync()` inside `fsyncDir`) but still returns `{ status: 'synced' }`
// survived the entire utils+install suite: every existing test observes only
// the RETURNED outcome, and a directory fsync has no filesystem-visible effect
// a test could read back. These tests close that gap at the only observable
// seam there is — the module boundary to `node:fs` / `node:fs/promises` —
// verifying the syscall wrapper is actually INVOKED, on the fd opened on the
// directory, and that `synced` is claimed only when that call succeeded.
//
// The mocks below are strict passthroughs (every un-instrumented member is the
// real implementation); the instrumented members RECORD and then delegate,
// except when a test injects an errno to drive the error arms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const control = vi.hoisted(() => ({
  /** Every fd handed to the real `fs.fsyncSync` wrapper, in call order. */
  syncFdCalls: [] as number[],
  /** Injected error thrown by the `fs.fsyncSync` wrapper INSTEAD of syncing. */
  syncError: undefined as Error | undefined,
  /** fd → path for every `fs.openSync`, so "the fd opened on the parent directory" is checkable. */
  openedSyncPaths: new Map<number, string>(),
  /** `FileHandle.sync()` invocations observed through the promises seam. */
  handleSyncCalls: 0,
  /** Injected error thrown by the `FileHandle.sync()` wrapper. */
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

// Imported AFTER the mocks so the module under test binds the instrumented seam.
import { mkdtempSync } from 'node:fs';
import {
  DIRECTORY_SYNC_UNSUPPORTED_CODES,
  fsyncDir,
  fsyncDirSync,
} from './atomic-write.js';

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
  // win32 has no directory fsync (the REAL call fails EPERM), so the
  // synced-success arm only exists on POSIX. The call-verification itself is
  // platform-independent and covered by the tests below.
  it.skipIf(IS_WIN32)(
    'FsyncDirSync_Synced_IsClaimedOnlyAfterFsyncingTheDirectoryFd',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));

      const outcome = fsyncDirSync(dir);

      // The claim…
      expect(outcome).toEqual({ directory: dir, status: 'synced' });
      // …was EARNED: exactly one real fsync, on the fd that was opened on the
      // parent directory itself. A mutant that skips the fsync but still
      // returns `synced` fails HERE — zero recorded calls.
      expect(control.syncFdCalls.length).toBe(1);
      expect(control.openedSyncPaths.get(control.syncFdCalls[0]!)).toBe(dir);
    },
  );

  it('FsyncDirSync_FsyncFailsWithRealFault_PropagatesInsteadOfClaimingSynced', () => {
    // EIO is deliberately OUTSIDE the closed unsupported set: a real fault
    // must surface, never be laundered into `synced` (or `unsupported`).
    expect(DIRECTORY_SYNC_UNSUPPORTED_CODES).not.toContain('EIO');
    const dir = mkdtempSync(join(tmpdir(), 'fsync-adequacy-'));
    control.syncError = errno('EIO');

    expect(() => fsyncDirSync(dir)).toThrow(/injected EIO/);
    // The failure came from the REAL seam being exercised, not a shortcut.
    expect(control.syncFdCalls.length).toBe(1);
  });

  it('FsyncDirSync_FsyncDeclinedByHost_DegradesToExplicitUnsupported', () => {
    // The other arm of the same call: an errno from the CLOSED set is an
    // explicit refusal, carried on the outcome — still never `synced`.
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
