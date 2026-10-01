// Every vitest project loads this setup file (#2029).
//
// The runner does not yield to the event loop between tests. So synchronous
// work adds up across a whole file: four tests that each block for 17 s keep
// the worker's loop blocked for 68 s, and its `onTaskUpdate` call then fails
// with no test named. These hooks yield before and after each test, so a
// blocked stretch ends with the test that caused it. The loop then reads the
// reply, and the RPC timer is cleared.
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
