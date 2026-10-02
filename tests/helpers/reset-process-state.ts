// Setup file: reset `process.env` and the working directory at every test
// file boundary.
//
// Vitest runs this module again before each test file, so the snapshot is
// the state the file starts with. The hook runs after the file's own
// `afterAll` hooks, so a file may still set env for itself in `beforeAll`.
// It is the first setup file of every project; a config test pins that.
// Stubs made with `vi.stubEnv` are undone first, so the stub registry
// cannot carry a value from this file into the next.

import { afterAll, vi } from 'vitest';
import { restoreProcessState, snapshotProcessState } from './process-state.js';

const atFileStart = snapshotProcessState();

afterAll(() => {
  vi.unstubAllEnvs();
  restoreProcessState(atFileStart);
});
