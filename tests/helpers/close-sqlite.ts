import { afterAll } from 'vitest';
import { closeOpenDatabases } from '../../src/storage/__shims__/bun-sqlite-node.js';

/**
 * tinypool removes the isolate before the Node `beforeExit` and `exit` hooks run, which
 * aborts the `Statement` destructor of better-sqlite3. Thus this hook closes every tracked
 * handle in the vitest teardown, while the isolate is live.
 *
 * The hook is `afterAll` and not `afterEach`, because a suite that opens a store in
 * `beforeAll` uses that handle in each of its tests.
 */
afterAll(() => {
  closeOpenDatabases();
});
