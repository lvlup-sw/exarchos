// A `close()` on an event store must release each handle on `exarchos.db`. Without the close
// barrier, an in-flight append reaches the lazy open after the close and opens a handle with no
// owner. On Windows that handle keeps the file locked, and the removal of the temp directory
// fails with EBUSY. These tests run on each platform because they count open handles and not
// file locks.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventStore } from '../../../src/events/store.js';
import { AtomicAppender, AppenderClosedError } from '../../../src/events/atomic-appender.js';
import { SqliteBackend } from '../../../src/storage/sqlite-backend.js';
import { rmrfAsync } from '../../../tools/test-helpers/temp-dir.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'appender-close-barrier-'));
});

afterEach(async () => {
  await rmrfAsync(dir);
});

describe('a closed event store opens no SQLite handle (#2026)', () => {
  /** The refused-transition shape: an append is still in flight when the owner closes. */
  it('InFlightAppend_StoreClosedBeforeItReachesTheBackend_OpensNoHandle', async () => {
    const store = new EventStore(dir);
    await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });

    const inFlight = store.append('s2', { type: 'task.assigned', data: { taskId: 't2' } });
    store.close();
    const openAfterClose = SqliteBackend.openHandleCount();
    const outcome = await inFlight.then(
      () => 'landed',
      (err: unknown) => err,
    );

    expect(SqliteBackend.openHandleCount()).toBe(openAfterClose);
    expect(outcome).toBeInstanceOf(AppenderClosedError);
  });

  it('ClosedAppender_ReadBackendRequested_ThrowsInsteadOfOpening', () => {
    const appender = new AtomicAppender({ stateDir: dir });
    appender.close();
    const before = SqliteBackend.openHandleCount();

    expect(() => appender.ensureSqliteBackendSync()).toThrow(AppenderClosedError);
    expect(SqliteBackend.openHandleCount()).toBe(before);
  });

  it('ClosedBackend_InitializeCalledAgain_ThrowsInsteadOfOpening', () => {
    const backend = new SqliteBackend(path.join(dir, 'exarchos.db'));
    backend.initialize();
    backend.close();
    const before = SqliteBackend.openHandleCount();

    expect(() => backend.initialize()).toThrow(/is closed/);
    expect(SqliteBackend.openHandleCount()).toBe(before);
  });

  /** A later call on the store itself still works: the store makes a new appender it owns. */
  it('ClosedStore_LaterCall_OpensAFreshHandleTheStoreOwns', async () => {
    const store = new EventStore(dir);
    await store.append('s1', { type: 'task.assigned', data: { taskId: 't1' } });
    store.close();
    const openAfterClose = SqliteBackend.openHandleCount();

    const events = await store.query('s1');
    expect(events.map((e) => e.type)).toEqual(['task.assigned']);
    expect(SqliteBackend.openHandleCount()).toBe(openAfterClose + 1);

    store.close();
    expect(SqliteBackend.openHandleCount()).toBe(openAfterClose);
  });
});
