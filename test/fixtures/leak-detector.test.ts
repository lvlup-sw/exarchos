import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  register,
  listAlive,
  clear,
} from './process-tracker.js';
import { expectNoLeakedProcesses } from './leak-detector.js';

// Long-lived child (setInterval keeps the event loop alive until killed).
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
  afterEach(async () => {
    // Force-kill any survivors so state doesn't bleed between tests.
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      await waitForExit(child);
    }
    clear();
  });

  it('ExpectNoLeakedProcesses_NoAliveChildren_Passes', () => {
    // Empty registry -> must not throw.
    expect(() => expectNoLeakedProcesses()).not.toThrow();
  });

  it('ExpectNoLeakedProcesses_LiveChildRemaining_ThrowsAndForceKills', async () => {
    const child = spawnLongLived();
    register(child);

    // Sanity: child is alive before we assert.
    expect(listAlive()).toContain(child);

    expect(() => expectNoLeakedProcesses()).toThrow();

    // After the throw, the leak detector should have force-killed the child.
    await waitForExit(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('ExpectNoLeakedProcesses_AfterKill_TrackerIsEmpty', async () => {
    const child = spawnLongLived();
    register(child);

    try {
      expectNoLeakedProcesses();
    } catch {
      // expected
    }

    // Registry must be cleared so subsequent tests start clean.
    await waitForExit(child);
    expect(listAlive()).toEqual([]);
  });

  it('ExpectNoLeakedProcesses_ErrorMessage_IncludesChildPidAndCommand', async () => {
    const child = spawnLongLived();
    register(child);
    const pid = child.pid;
    expect(pid).toBeTypeOf('number');

    let caught: unknown;
    try {
      expectNoLeakedProcesses();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    // Error message must surface the PID so the user can correlate to OS logs.
    expect(message).toContain(String(pid));
    // And must surface the original command so the user knows which spawn leaked.
    expect(message).toContain('node');
    expect(message).toContain('setInterval');

    await waitForExit(child);
  });
});
