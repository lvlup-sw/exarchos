import type { ChildProcess } from 'node:child_process';
import {
  listAlive,
  killAll,
  clear,
  getRegisteredCommand,
} from './process-tracker.js';

/**
 * Throws if a child that the process tracker registered is still alive.
 * `tests/helpers/global.ts` awaits it after each test of the `process` vitest project.
 *
 * The function records the pid and the command of each leaked child before the kill,
 * because `spawnargs` can be unreliable after it. Then it awaits `killAll`, so the next
 * test starts with no live child. It clears the registry in `finally`, so a kill error
 * leaves no stale entry. The error lists each leaked child.
 */
export async function expectNoLeakedProcesses(): Promise<void> {
  const leaked = listAlive();
  if (leaked.length === 0) {
    return;
  }

  const descriptions = leaked.map((child) => describeLeak(child));

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
