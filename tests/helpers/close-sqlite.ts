import { afterAll, beforeEach, onTestFinished } from 'vitest';
import { closeOpenDatabases } from '../../src/storage/__shims__/bun-sqlite-node.js';

// tinypool tears down the isolate before Node `beforeExit`/`exit` hooks run,
// which aborts better-sqlite3's Statement destructor. Close every tracked
// handle from vitest's own teardown, which still has a live isolate.
//
// `onTestFinished` runs before the test file's `afterEach`, so Windows
// fixtures can `fs.rm` their temp dir without hitting EBUSY on an open
// `exarchos.db` / `-wal` / `-shm` handle.
beforeEach(() => {
  onTestFinished(() => {
    closeOpenDatabases();
  });
});

afterAll(() => {
  closeOpenDatabases();
});
