import type { ChildProcess } from 'node:child_process';

/**
 * Module-global registry of spawned child processes.
 *
 * Module-scoped mutable state is acceptable here because vitest provides
 * per-worker process isolation — each worker loads this module fresh and the
 * registry is scoped to that worker's spawned children only.
 *
 * Consumed internally by runCli, spawnMcpClient, and expectNoLeakedProcesses.
 * Not re-exported from the public fixture barrel.
 */
const registry: Set<ChildProcess> = new Set();

/**
 * Original command (argv[0..n]) captured at register() time, for use in
 * leak-detector error messages once the child has already been killed and
 * `spawnargs` may be unreliable. Stored as a weak-keyed side channel.
 */
const commandByChild: WeakMap<ChildProcess, readonly string[]> = new WeakMap();

/** Register a spawned child process for later lifecycle management. Idempotent. */
export function register(child: ChildProcess): void {
  if (registry.has(child)) {
    return;
  }
  registry.add(child);
  // Capture the original command so later error messages can reference it
  // even if the ChildProcess is force-killed or drained.
  if (Array.isArray(child.spawnargs)) {
    commandByChild.set(child, [...child.spawnargs]);
  }
}

/** Remove a child from the registry, e.g. on clean exit. */
export function unregister(child: ChildProcess): void {
  registry.delete(child);
}

/**
 * Return every registered child that is still running (has not exited).
 * Children that exit naturally are filtered out but remain in the registry
 * until unregister() or clear() is called.
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
 * Send SIGTERM to every alive child, wait up to `timeoutMs` for them to exit,
 * then SIGKILL any survivors. Resolves once all registered children have exited.
 */
export async function killAll({ timeoutMs = 3000 }: { timeoutMs?: number } = {}): Promise<void> {
  const alive = listAlive();
  if (alive.length === 0) {
    return;
  }

  // Set up exit listeners before signalling so we don't miss fast exits.
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

  // SIGTERM phase.
  for (const child of alive) {
    try {
      child.kill('SIGTERM');
    } catch {
      // Child may already be exiting; ignore.
    }
  }

  // Wait for graceful exit up to the timeout.
  await Promise.race([
    Promise.all(exitPromises),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);

  // SIGKILL survivors.
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
      // ignore
    }
  }

  // Wait for survivors to actually exit after SIGKILL.
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

/** Empty the registry without touching process state. Test-setup hook. */
export function clear(): void {
  registry.clear();
}

/**
 * Internal accessor for the original command associated with a child at
 * register() time. Used by leak-detector error messages.
 */
export function getRegisteredCommand(child: ChildProcess): readonly string[] | undefined {
  return commandByChild.get(child);
}
