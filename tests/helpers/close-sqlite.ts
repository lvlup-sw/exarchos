import { afterAll } from 'vitest';
import { closeOpenDatabases } from '../../src/storage/__shims__/bun-sqlite-node.js';

// tinypool tears down the isolate before Node `beforeExit`/`exit` hooks run,
// which aborts better-sqlite3's Statement destructor. Close every tracked
// handle from vitest's own teardown, which still has a live isolate.
afterAll(() => {
  closeOpenDatabases();
});
