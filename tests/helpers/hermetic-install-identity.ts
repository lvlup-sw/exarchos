import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isMainThread } from 'node:worker_threads';

/**
 * Keep the install-identity TOFU lock out of the developer's real home.
 *
 * The lock is keyed to the INSTALLATION rather than to the event store, so it
 * no longer follows a test's temp `stateDir` the way it used to. That is the
 * point — freshness must not vary with `WORKFLOW_STATE_DIR` — but it means any
 * test that dispatches a mutating action under an "installed" posture would
 * otherwise publish a lock into `~/.exarchos/install`.
 *
 * A checkout of THIS repo on a machine that also has the Exarchos plugin
 * installed detects as `installed` (posture keys on the plugin cache existing,
 * not on whether the running code IS that install), so this is the ordinary
 * developer configuration, not an exotic one.
 *
 * ONE directory PER RUN, keyed on the vitest host process and the run id the
 * host minted in `vitest.config.ts`. Setup files are
 * evaluated per test file under vitest's isolation, so `mkdtemp` here meant a
 * directory per file: a single full run left 6,795 of them in `/tmp`, none ever
 * removed. A single fixed path closed that leak but shared the lock ACROSS
 * runs: the lock records the identity the gate then compares against what is
 * installed, so a lock recorded by an earlier run against an earlier plugin
 * install reads as "stale" in the next run and blocks the mutating dispatches
 * that inherit the installed posture. Every file of one run shares its
 * directory, which is safe because nothing asserts on its contents — every
 * test that cares about the lock stubs `EXARCHOS_INSTALL_STATE_DIR` to its own
 * directory with `vi.stubEnv`, which runs after this module and is undone on
 * teardown — and no other run ever reads it.
 *
 * Cleanup is the next run's job: a setup file has no end-of-run hook, so each
 * evaluation sweeps sibling directories whose host process is gone. A live
 * run's directory is never touched, because its host is alive. The run id
 * covers the one case liveness cannot: an exited host's pid handed to this
 * host, whose earlier directory would otherwise be alive by pid and reused,
 * lock and all. A directory carrying this host's pid under a different run id
 * is an earlier incarnation's and is swept too.
 *
 * Set UNCONDITIONALLY. Honouring a caller-supplied value would let a stray
 * export in a shell or a CI job point the whole suite at a real directory.
 */
export const INSTALL_IDENTITY_SCRATCH_PREFIX = 'exarchos-test-install-identity-';

/**
 * The process that owns this vitest run. Under `pool: 'forks'` a worker is a
 * child process of the vitest host, so `ppid` names the run; under a threads
 * pool the worker IS the host process.
 */
export function runHostPid(): number {
  return isMainThread ? process.ppid : process.pid;
}

/** The scratch name for a host incarnation: `<host pid>-<run id>`. */
export function scratchNameFor(hostPid: number, runId: string): string {
  return `${INSTALL_IDENTITY_SCRATCH_PREFIX}${hostPid}-${runId}`;
}

const SCRATCH_NAME_SUFFIX = /^([1-9]\d*)(?:-[A-Za-z0-9]+)?$/;

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Remove every scratch directory under `tmp` whose owning host process no
 * longer exists, plus any that carries THIS host's pid under another run id
 * (an earlier incarnation of a reused pid), leaving `keep` and every directory
 * of a live run alone. Returns the names it removed. Failures are swallowed:
 * a sibling worker's sweep may have won the race, and a directory that cannot
 * be removed now is simply left for the next run.
 *
 * `isAlive` is injectable so the sweep's decision can be pinned without a
 * test depending on a real pid staying dead — a reaped pid can be recycled.
 */
export function sweepOrphanInstallIdentityDirs(
  tmp: string,
  keep: string,
  hostPid: number,
  isAlive: (pid: number) => boolean = isProcessAlive,
): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(INSTALL_IDENTITY_SCRATCH_PREFIX) || entry === keep) continue;
    // Only `<pid>` or `<pid>-<run id>` names a run; anything else (an older
    // layout's random suffix, a stray file) is not this module's to remove.
    const match = SCRATCH_NAME_SUFFIX.exec(entry.slice(INSTALL_IDENTITY_SCRATCH_PREFIX.length));
    if (match?.[1] === undefined) continue;
    const pid = Number.parseInt(match[1], 10);
    if (pid !== hostPid && isAlive(pid)) continue;
    try {
      fs.rmSync(path.join(tmp, entry), { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // Left for the next run.
    }
  }
  return removed;
}

const TMP = os.tmpdir();
const HOST_PID = runHostPid();
// Minted by `vitest.config.ts` in the host; a worker only ever inherits it.
const RUN_ID = process.env['EXARCHOS_TEST_RUN_ID'] ?? 'unstamped';
const SCRATCH_NAME = scratchNameFor(HOST_PID, RUN_ID);
const SCRATCH = path.join(TMP, SCRATCH_NAME);
sweepOrphanInstallIdentityDirs(TMP, SCRATCH_NAME, HOST_PID);
fs.mkdirSync(SCRATCH, { recursive: true });
process.env['EXARCHOS_INSTALL_STATE_DIR'] = SCRATCH;
