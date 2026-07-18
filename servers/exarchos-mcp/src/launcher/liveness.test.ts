// ─── Launcher liveness emitter tests (DR-2) ──────────────────────────────────
//
// Drive the two emitters directly over a real EventStore (no git spawn, no OS
// process probe) and assert against the persisted `worktrees` stream, so the
// contract is pinned at the event-log level the reducer folds.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { EventStore } from '../event-store/store.js';
import { rmrfAsync } from '../test-helpers/temp-dir.js';
import { WORKTREES_STREAM } from '../orchestrate/worktree/manager.js';
import {
  emitLaunchExecutingStarted,
  emitLaunchExecuted,
  LAUNCH_EXECUTING_STARTED,
  LAUNCH_EXECUTED,
} from './liveness.js';

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

    // Exactly one of each, both on the singleton worktrees stream, both carrying
    // the schema-required liveness fields.
    expect(started).toHaveLength(1);
    expect(started[0]!.streamId).toBe(WORKTREES_STREAM);
    expect(started[0]!.data).toMatchObject({
      worktreeId: WT_ID,
      holderPid: 4242,
      holderStartedAt: 'boot-4242',
    });

    expect(terminal).toHaveLength(1);
    expect(terminal[0]!.streamId).toBe(WORKTREES_STREAM);
    expect(terminal[0]!.data).toMatchObject({ worktreeId: WT_ID, exitCode: 0 });

    // The first terminal emission reports it wrote the row.
    expect(executed).toEqual({ appended: true, worktreeId: WT_ID, exitCode: 0 });
  });

  it('Liveness_TerminalSeam_Idempotent', async () => {
    const eventStore = await createStore();

    // A signal path fires the terminal (exitCode null)…
    const first = await emitLaunchExecuted(eventStore, {
      worktreeId: WT_ID,
      exitCode: null,
    });
    // …then a teardown path fires it AGAIN for the same launch (exitCode 0).
    const second = await emitLaunchExecuted(eventStore, {
      worktreeId: WT_ID,
      exitCode: 0,
    });

    const events = await eventStore.query(WORKTREES_STREAM);
    const terminals = events.filter((e) => e.type === LAUNCH_EXECUTED);

    // At most ONE launch.executed persisted for the launch — the terminal seam
    // is idempotent across the signal + teardown paths.
    expect(terminals).toHaveLength(1);
    // The first terminal wins; its exitCode is the one that persisted.
    expect(terminals[0]!.data).toMatchObject({ worktreeId: WT_ID, exitCode: null });

    // The first call wrote it; the second short-circuited on the existing terminal.
    expect(first.appended).toBe(true);
    expect(second.appended).toBe(false);
  });
});
