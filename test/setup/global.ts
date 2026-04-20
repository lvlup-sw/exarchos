import { afterEach } from 'vitest';
import { expectNoLeakedProcesses } from '../fixtures/leak-detector.js';
import { assertExarchosMcpOnPath } from './preflight.js';

// Fail fast before any test in the `process` project runs.
// Vitest does NOT execute setupFiles when zero tests are discovered, so this
// correctly stays dormant until PR 2 adds the first process-fidelity test.
assertExarchosMcpOnPath();

afterEach(() => {
  expectNoLeakedProcesses();
});
