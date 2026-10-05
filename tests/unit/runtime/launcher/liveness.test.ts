/**
 * Tests for the two launcher liveness emitters.
 *
 * Each test calls the emitters on a real `EventStore` and reads the persisted `worktrees` stream.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../../../../src/events/store.js';
import { rmrfAsync } from '../../../../tools/test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../../../../src/verbs/worktree/manager.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
  LAUNCH_EXECUTING_STARTED,
  LAUNCH_EXECUTED,
} from '../../../../src/runtime/launcher/liveness.js';

const stateDirs: string[] = [];

async function createStore(): Promise<EventStore> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'wlm-liveness-'));
  stateDirs.push(stateDir);
  const eventStore = new EventStore(stateDir);
  await eventStore.initialize();
  return eventStore;
}

afterEach(async () => {
  while (stateDirs.length > 0) {
    const dir = stateDirs.pop();
    if (dir) await rmrfAsync(dir);
  }
});

const WT_ID = '/srv/wt/launch-a';

describe('launcher liveness emitters (DR-2)', () => {
  /** Each emitter writes one row on the `worktrees` stream. The first terminal call reports `appended: true`. */
  it('Liveness_EmitsStartedAndExecuted', async () => {
    const eventStore = await createStore();

    await emitLaunchExecutingStarted(eventStore, {
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });
    const executed = await emitLaunchExecuted(eventStore, {
      worktreeId: WT_ID,
      exitCode: 0,
    });

    const events = await eventStore.query(WORKTREES_STREAM);
    const started = events.filter((e) => e.type === LAUNCH_EXECUTING_STARTED);
    const terminal = events.filter((e) => e.type === LAUNCH_EXECUTED);

    expect(started).toHaveLength(1);
    expect(started[0].streamId).toBe(WORKTREES_STREAM);
    expect(started[0].data).toMatchObject({
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    expect(terminal).toHaveLength(1);
    expect(terminal[0].streamId).toBe(WORKTREES_STREAM);
    expect(terminal[0].data).toMatchObject({ worktreeId: WT_ID, exitCode: 0 });

    expect(executed).toEqual({ appended: true, worktreeId: WT_ID, exitCode: 0 });
  });

  /**
   * A signal path and a teardown path each emit the terminal for one launch.
   * One row persists with the first exit code, and the second call reports `appended: false`.
   */
  it('Liveness_TerminalSeam_Idempotent', async () => {
    const eventStore = await createStore();

    const first = await emitLaunchExecuted(eventStore, {
      worktreeId: WT_ID,
      exitCode: null,
    });
    const second = await emitLaunchExecuted(eventStore, {
      worktreeId: WT_ID,
      exitCode: 0,
    });

    const events = await eventStore.query(WORKTREES_STREAM);
    const terminals = events.filter((e) => e.type === LAUNCH_EXECUTED);

    expect(terminals).toHaveLength(1);
    expect(terminals[0].data).toMatchObject({ worktreeId: WT_ID, exitCode: null });

    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
  });
});
