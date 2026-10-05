/**
 * Setup file that points `EXARCHOS_INSTALL_STATE_DIR` at a scratch directory, so no test
 * writes the install-identity lock into the real home of the developer.
 *
 * The lock belongs to the installation, not to the event store, so it does not follow the
 * temp `stateDir` of a test. A checkout on a machine that has the Exarchos plugin detects
 * as `installed`, so a mutating dispatch writes the lock.
 *
 * Each run has one directory, named with the pid of the vitest host and the run id from
 * `vitest.config.ts`. One directory for each test file leaks thousands of directories.
 * One fixed path shares the lock across runs, and a lock from an earlier plugin install
 * reads as stale and blocks mutating dispatches. A test that asserts on the lock stubs
 * the variable to its own directory.
 *
 * A setup file has no end-of-run hook, so each evaluation sweeps the directories of dead
 * hosts. The module always sets the variable, because a value from a shell or a CI job
 * can point the suite at a real directory.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMainThread } from 'node:worker_threads';

import { sweepOrphanScratchDirs } from '../../tools/test-helpers/scratch-sweep.js';

/** The name prefix of each scratch directory. */
export const INSTALL_IDENTITY_SCRATCH_PREFIX = 'exarchos-test-install-identity-';

/**
 * The pid of the process that owns this vitest run. Under `pool: 'forks'` a worker is a
 * child of the vitest host, so `ppid` names the run. Under a threads pool the worker runs
 * in the host process, so `pid` names the run.
 */
export function runHostPid(): number {
  return isMainThread ? process.ppid : process.pid;
}

/** The scratch name for a host incarnation: `<host pid>-<run id>`. */
export function scratchNameFor(hostPid: number, runId: string): string {
  return `${INSTALL_IDENTITY_SCRATCH_PREFIX}${hostPid}-${runId}`;
}

/** Only `ESRCH` counts as dead. `EPERM` shows a live process that belongs to another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Removes each scratch directory under `tmp` whose host process is gone. It also removes
 * a directory that holds the pid of this host under another run id. That directory is
 * from an earlier host with the same pid, and liveness alone reads it as alive.
 * The function keeps `keep` and the directories of live runs, and returns the removed names.
 * A directory that it cannot remove stays for the next run.
 *
 * `isAlive` is a parameter, so a test can set the result. A test cannot rely on a real
 * dead pid, because the OS can reuse the pid of an exited process.
 */
export function sweepOrphanInstallIdentityDirs(
  tmp: string,
  keep: string,
  hostPid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  return sweepOrphanScratchDirs(tmp, INSTALL_IDENTITY_SCRATCH_PREFIX, keep, hostPid, isAlive);
}

const TMP = os.tmpdir();
const HOST_PID = runHostPid();
/** `vitest.config.ts` sets the run id in the host process, and each worker inherits it. */
const RUN_ID = process.env['EXARCHOS_TEST_RUN_ID'] ?? 'unstamped';
const SCRATCH_NAME = scratchNameFor(HOST_PID, RUN_ID);
const SCRATCH = path.join(TMP, SCRATCH_NAME);
sweepOrphanInstallIdentityDirs(TMP, SCRATCH_NAME, HOST_PID);
fs.mkdirSync(SCRATCH, { recursive: true });
process.env['EXARCHOS_INSTALL_STATE_DIR'] = SCRATCH;
