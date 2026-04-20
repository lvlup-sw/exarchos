import type { ChildProcess } from 'node:child_process';
import {
  listAlive,
  killAll,
  clear,
  getRegisteredCommand,
} from './process-tracker.js';

/**
 * Assert that no children spawned via the process-tracker remain alive.
 *
 * Intended to run as a global `afterEach` hook in the `process` vitest
 * project (see design §5.5). Consumed only by `test/setup/global.ts`; tests
 * should not call this directly.
 *
 * Behavior:
 * - If no children are alive: returns silently.
 * - If children are alive: force-kills them via `processTracker.killAll`,
 *   clears the registry, then throws an Error whose message lists each
 *   leaked child's PID and its original spawn command. The force-kill is
 *   fire-and-forget (the surrounding test already failed — we just need to
 *   ensure the leaks don't persist into the next test).
 *
 * Not async: vitest's `afterEach` accepts either a sync or async callback,
 * but keeping this sync keeps the API surface in design §5.5 honest and lets
 * callers `expect(() => expectNoLeakedProcesses()).toThrow()`.
 */
export function expectNoLeakedProcesses(): void {
  const leaked = listAlive();
  if (leaked.length === 0) {
    return;
  }

  // Snapshot PID + command BEFORE force-killing, since killAll may drain the
  // ChildProcess and spawnargs can become unreliable on some platforms.
  const descriptions = leaked.map((child) => describeLeak(child));

  // Kick off force-kill before clearing the registry: killAll() is async but
  // reads `listAlive()` synchronously on entry and sends SIGTERM before its
  // first await, so the kill dispatch happens in this microtask.
  const killPromise = killAll({ timeoutMs: 3000 });

  // Clear the registry synchronously so the next test starts with a fresh
  // tracker regardless of whether the caller awaits the SIGTERM→SIGKILL dance.
  clear();

  // Fire-and-forget: the test has already failed. The OS reap can finish on
  // its own schedule; the test runner is about to move on.
  void killPromise;

  const lines = descriptions.map((d) => `  - ${d}`).join('\n');
  throw new Error(
    `Leaked child process(es) detected after test:\n${lines}\n` +
      `These were force-killed. Ensure every spawn() is paired with a terminate()/unregister() call.`,
  );
}

function describeLeak(child: ChildProcess): string {
  const pid = child.pid ?? '<unknown-pid>';
  const command = getRegisteredCommand(child) ?? child.spawnargs;
  const commandStr = Array.isArray(command) && command.length > 0 ? command.join(' ') : '<unknown-command>';
  return `pid=${pid} command=${commandStr}`;
}
