/**
 * Setup file of the `process` vitest project.
 * It fails before the first test if `exarchos` is not on PATH or has the wrong version.
 * After each test, it fails if a tracked child process is still alive.
 */
import { afterEach } from 'vitest';
import { expectNoLeakedProcesses } from './leak-detector.js';
import { assertExarchosOnPath, assertExarchosVersion } from './preflight.js';

await assertExarchosOnPath();
await assertExarchosVersion();

afterEach(async () => {
  await expectNoLeakedProcesses();
});
