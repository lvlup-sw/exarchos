import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';

import { makeTempDir, rmrf } from './temp-dir.js';
import { EventStore } from '../../src/events/store.js';
import { SqliteBackend } from '../../src/storage/sqlite-backend.js';

/**
 * The `EBUSY` symptom occurs only on NTFS. The handle lifecycle that prevents
 * it does not depend on the platform, so these tests run on the Linux CI host.
 */
describe('temp-dir helper + SQLite handle lifecycle (#1620)', () => {
  /**
   * The test does not close `store`. This is the leaked handle that blocks
   * the removal on Windows.
   */
  it('Rmrf_ClosesLeakedSqliteHandleUnderDir_ThenRemoves', async () => {
    const dir = makeTempDir('exarchos-rmrf-leak-');
    const store = new EventStore(dir);
    await store.initialize();
    await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });

    const openWhileLeaked = SqliteBackend.openHandleCount();
    expect(openWhileLeaked).toBeGreaterThanOrEqual(1);

    rmrf(dir);

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
      expect(() => store.close()).not.toThrow();
      expect(SqliteBackend.openHandleCount()).toBe(before - 1);
    } finally {
      rmrf(dir);
    }
  });

  /** `close()` releases only the connection. It never loses committed data. */
  it('EventStoreClose_PreservesDurability_ReopenReadsCommittedEvents', async () => {
    const dir = makeTempDir('exarchos-close-durable-');
    try {
      const store = new EventStore(dir);
      await store.initialize();
      await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });
      store.close();

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
      SqliteBackend.closeOpenUnder(dirA);
      expect(SqliteBackend.openHandleCount()).toBe(before - 1);

      const events = await storeB.query('s');
      expect(events).toHaveLength(1);
      storeB.close();
    } finally {
      rmrf(dirA);
      rmrf(dirB);
    }
  });
});
