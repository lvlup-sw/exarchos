import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

import { makeTempDir, rmrf } from './temp-dir.js';
import { EventStore } from '../event-store/store.js';
import { SqliteBackend } from '../storage/sqlite-backend.js';

/**
 * These assert the *mechanism* behind the Windows-portability fix (#1620).
 * The EPERM/EBUSY symptom only reproduces on NTFS, but the handle-lifecycle
 * logic these cover — registry add/remove, idempotent close, durability
 * across close, and `rmrf` closing leaked handles before removal — is
 * platform-independent and therefore verifiable on the Linux CI host.
 */
describe('temp-dir helper + SQLite handle lifecycle (#1620)', () => {
  it('Rmrf_ClosesLeakedSqliteHandleUnderDir_ThenRemoves', async () => {
    const dir = makeTempDir('exarchos-rmrf-leak-');
    const store = new EventStore(dir);
    await store.initialize();
    // Force the SQLite handle open via a write; the test deliberately does
    // NOT close `store` — this is the leaked-handle case that blocks rm on
    // Windows.
    await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });

    const openWhileLeaked = SqliteBackend.openHandleCount();
    expect(openWhileLeaked).toBeGreaterThanOrEqual(1);

    rmrf(dir);

    // rmrf must have closed the leaked handle (count drops) and removed the dir.
    expect(SqliteBackend.openHandleCount()).toBe(openWhileLeaked - 1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('EventStoreClose_IsIdempotent_AndDeregistersHandle', async () => {
    const dir = makeTempDir('exarchos-close-idem-');
    try {
      const store = new EventStore(dir);
      await store.initialize();
      await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });

      const before = SqliteBackend.openHandleCount();
      store.close();
      expect(SqliteBackend.openHandleCount()).toBe(before - 1);
      // Second close must not throw (no double driver close).
      expect(() => store.close()).not.toThrow();
      expect(SqliteBackend.openHandleCount()).toBe(before - 1);
    } finally {
      rmrf(dir);
    }
  });

  it('EventStoreClose_PreservesDurability_ReopenReadsCommittedEvents', async () => {
    const dir = makeTempDir('exarchos-close-durable-');
    try {
      const store = new EventStore(dir);
      await store.initialize();
      await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });
      store.close();

      // A fresh store against the same dir must still read the committed event
      // — proving close() only releases the connection, never data (INV-1).
      const reopened = new EventStore(dir);
      await reopened.initialize();
      const events = await reopened.query('s1');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('task.assigned');
      reopened.close();
    } finally {
      rmrf(dir);
    }
  });

  it('CloseOpenUnder_LeavesHandlesOutsideDirUntouched', async () => {
    const dirA = makeTempDir('exarchos-scope-a-');
    const dirB = makeTempDir('exarchos-scope-b-');
    try {
      const storeA = new EventStore(dirA);
      const storeB = new EventStore(dirB);
      await storeA.initialize();
      await storeB.initialize();
      await storeA.append('s', { type: 'task.assigned', data: { taskId: 'a' } });
      await storeB.append('s', { type: 'task.assigned', data: { taskId: 'b' } });

      const before = SqliteBackend.openHandleCount();
      // Closing under dirA must not touch the handle under dirB.
      SqliteBackend.closeOpenUnder(dirA);
      expect(SqliteBackend.openHandleCount()).toBe(before - 1);

      // storeB still usable.
      const events = await storeB.query('s');
      expect(events).toHaveLength(1);
      storeB.close();
    } finally {
      rmrf(dirA);
      rmrf(dirB);
    }
  });
});
