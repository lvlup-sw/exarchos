import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  register,
  unregister,
  listAlive,
  killAll,
  clear,
} from './process-tracker.js';

/** Spawns a child that stays alive: a 1 s interval keeps its event loop busy. */
function spawnLongLived(): ChildProcess {
  return spawn('node', ['-e', 'setInterval(()=>{}, 1000)']);
}

/** Spawns a child that exits immediately. */
function spawnQuickExit(): ChildProcess {
  return spawn('node', ['-e', '']);
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

describe('process-tracker', () => {
  /** Kills each child that is still alive, so a test cannot leak a process into the next one. */
  afterEach(async () => {
    for (const child of listAlive()) {
      try {
        child.kill('SIGKILL');
      } catch {
      }
    }
    clear();
  });

  it('ProcessTracker_Register_AddsChildToList', async () => {
    const child = spawnLongLived();
    register(child);
    try {
      expect(listAlive()).toContain(child);
    } finally {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
  });

  it('ProcessTracker_Unregister_RemovesChild', async () => {
    const child = spawnLongLived();
    register(child);
    unregister(child);
    expect(listAlive()).not.toContain(child);
    child.kill('SIGKILL');
    await waitForExit(child);
  });

  it('ProcessTracker_ListAlive_OnlyReturnsRunningChildren', async () => {
    const alive = spawnLongLived();
    const done = spawnQuickExit();
    register(alive);
    register(done);

    await waitForExit(done);

    const runningOnly = listAlive();
    expect(runningOnly).toContain(alive);
    expect(runningOnly).not.toContain(done);

    alive.kill('SIGKILL');
    await waitForExit(alive);
  });

  it('ProcessTracker_KillAll_SendsSigtermThenSigkill', async () => {
    const child1 = spawnLongLived();
    const child2 = spawnLongLived();
    register(child1);
    register(child2);

    await killAll({ timeoutMs: 1000 });

    expect(child1.exitCode !== null || child1.signalCode !== null).toBe(true);
    expect(child2.exitCode !== null || child2.signalCode !== null).toBe(true);
  });

  it('ProcessTracker_Clear_EmptiesList', async () => {
    const child = spawnLongLived();
    register(child);
    clear();
    expect(listAlive()).toHaveLength(0);
    child.kill('SIGKILL');
    await waitForExit(child);
  });

  it('ProcessTracker_RegisterSameChildTwice_Idempotent', async () => {
    const child = spawnLongLived();
    register(child);
    register(child);
    const alive = listAlive();
    const occurrences = alive.filter((c) => c === child).length;
    expect(occurrences).toBe(1);
    child.kill('SIGKILL');
    await waitForExit(child);
  });
});
