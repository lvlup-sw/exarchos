import type { ChildProcess } from 'node:child_process';

/**
 * The child processes that this worker spawned. Each vitest worker has its own
 * copy of this module, so the registry holds only the children of that worker.
 * `runCli`, `spawnMcpClient` and `expectNoLeakedProcesses` use it. The fixture
 * barrel does not export it.
 */
const registry: Set<ChildProcess> = new Set();

/**
 * The command of each child, copied when `register` runs. The leak detector
 * names the command in its error after the child is dead, when `spawnargs`
 * can be unreliable.
 */
const commandByChild: WeakMap<ChildProcess, readonly string[]> = new WeakMap();

/** Registers a spawned child and copies its command. A second call for the same child does nothing. */
export function register(child: ChildProcess): void {
  if (registry.has(child)) {
    return;
  }
  registry.add(child);
  if (Array.isArray(child.spawnargs)) {
    commandByChild.set(child, [...child.spawnargs]);
  }
}

/** Removes a child from the registry, for example after a clean exit. */
export function unregister(child: ChildProcess): void {
  registry.delete(child);
}

/**
 * Returns each registered child that did not exit. A child that exits stays in
 * the registry until `unregister` or `clear` removes it.
 */
export function listAlive(): ChildProcess[] {
  const alive: ChildProcess[] = [];
  for (const child of registry) {
    if (child.exitCode === null && child.signalCode === null) {
      alive.push(child);
    }
  }
  return alive;
}

/**
 * Sends SIGTERM to each live child and waits at most `timeoutMs` for the exits.
 * Then it sends SIGKILL to each survivor and waits for those exits. It attaches
 * the exit listeners before the first signal, so it does not miss a fast exit.
 * It ignores a `kill` error, because the child can be in its exit already.
 */
export async function killAll({ timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<void> {
  const alive = listAlive();
  if (alive.length === 0) {
    return;
  }

  const exitPromises = alive.map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once('exit', () => resolve());
      }),
  );

  for (const child of alive) {
    try {
      child.kill('SIGTERM');
    } catch {
    }
  }

  await Promise.race([
    Promise.all(exitPromises),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  const survivors = alive.filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  if (survivors.length === 0) {
    return;
  }

  for (const child of survivors) {
    try {
      child.kill('SIGKILL');
    } catch {
    }
  }

  await Promise.all(
    survivors.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
        }),
    ),
  );
}

/** Empties the registry. It does not signal a child. */
export function clear(): void {
  registry.clear();
}

/** Returns the command that `register` copied for `child`. The leak detector prints it. */
export function getRegisteredCommand(child: ChildProcess): readonly string[] | undefined {
  return commandByChild.get(child);
}
