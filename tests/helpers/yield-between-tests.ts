// Every vitest project loads this setup file (#2029).
//
// The runner does not yield to the event loop between tests, so synchronous
// work adds up across a file. Four tests that each block for 17 seconds block
// the loop of the worker for 68 seconds. The `onTaskUpdate` call of the worker
// then fails and names no test. These hooks yield before and after each test,
// so a blocked stretch ends with the test that caused it. The loop then reads
// the reply and clears the RPC timer.
//
// The yield uses `node:timers/promises`, which fake timers do not replace.
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { afterEach, beforeEach } from 'vitest';

beforeEach(async () => {
  await yieldToEventLoop();
});

afterEach(async () => {
  await yieldToEventLoop();
});
