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
 *   awaits the SIGTERM→SIGKILL sequence, clears the registry, then throws an
 *   Error whose message lists each leaked child's PID and its original spawn
 *   command.
 *
 * Async because the SIGTERM→SIGKILL dance must complete before the next test
 * starts; the previous fire-and-forget design risked unhandled rejections in
 * killAll and let stubborn children leak across tests. Vitest's `afterEach`
 * accepts an async callback, so the only adjustment for callers is to await
 * (or `return`) the promise — see `test/setup/global.ts`.
 */
export async function expectNoLeakedProcesses(): Promise<void> {
  const leaked = listAlive();
  if (leaked.length === 0) {
    return;
  }

  // Snapshot PID + command BEFORE force-killing, since killAll may drain the
  // ChildProcess and spawnargs can become unreliable on some platforms.
  const descriptions = leaked.map((child) => describeLeak(child));

  // Await the full SIGTERM→SIGKILL sequence so any rejection surfaces and the
  // next test starts with no live children. `clear()` runs in `finally` so
  // registry state never strands on a kill error.
  try {
    await killAll({ timeoutMs: 3000 });
  } finally {
    clear();
  }

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
