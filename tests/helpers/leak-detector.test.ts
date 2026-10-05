import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  register,
  listAlive,
  clear,
} from './process-tracker.js';
import { expectNoLeakedProcesses } from './leak-detector.js';

/** Spawns a child that stays alive until a kill. `setInterval` keeps its event loop alive. */
function spawnLongLived(): ChildProcess {
  return spawn('node', ['-e', 'setInterval(()=>{}, 1000)']);
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });
}

describe('expectNoLeakedProcesses', () => {
  /** Kills each surviving child and clears the tracker, so no state passes to the next test. */
  afterEach(async () => {
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
      await waitForExit(child);
    }
    clear();
  });

  it('ExpectNoLeakedProcesses_NoAliveChildren_Passes', async () => {
    await expect(expectNoLeakedProcesses()).resolves.toBeUndefined();
  });

  /** The helper awaits the kill, so the child is gone when the promise rejects. */
  it('ExpectNoLeakedProcesses_LiveChildRemaining_ThrowsAndForceKills', async () => {
    const child = spawnLongLived();
    register(child);

    expect(listAlive()).toContain(child);

    await expect(expectNoLeakedProcesses()).rejects.toThrow();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  /** The helper kills the child and clears the registry. Then `listAlive()` must be empty. */
  it('ExpectNoLeakedProcesses_AfterKill_TrackerIsEmpty', async () => {
    const child = spawnLongLived();
    register(child);

    await expectNoLeakedProcesses().catch(() => {
    });

    expect(listAlive()).toEqual([]);
  });

  /**
   * The message names the pid, so a reader can find the process in the OS logs.
   * It also names the command, so a reader can find the spawn that leaked.
   */
  it('ExpectNoLeakedProcesses_ErrorMessage_IncludesChildPidAndCommand', async () => {
    const child = spawnLongLived();
    register(child);
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');

    let caught: unknown;
    try {
      await expectNoLeakedProcesses();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain(String(pid));
    expect(message).toContain('node');
    expect(message).toContain('setInterval');

    await waitForExit(child);
  });
});
