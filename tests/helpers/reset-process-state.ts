// Setup file that resets `process.env` and the working directory at every
// test file boundary.
//
// Vitest runs this module again before each test file, so the snapshot is
// the state that the file starts with. The hook runs after the `afterAll`
// hooks of the file, so a file can set env for itself in `beforeAll`.
// This is the first setup file of every project, and a config test pins that.
// The hook first undoes the stubs of `vi.stubEnv`, so the stub registry
// cannot carry a value into the next file.

import { afterAll, vi } from 'vitest';
import { restoreProcessState, snapshotProcessState } from './process-state.js';

const atFileStart = snapshotProcessState();

afterAll(() => {
  vi.unstubAllEnvs();
  restoreProcessState(atFileStart);
});
