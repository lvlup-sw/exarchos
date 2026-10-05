/**
 * The hermetic install-identity setup file: one scratch directory per vitest
 * run, shared by every file of that run, swept once its host process is gone.
 *
 * @oracle-sources: ./hermetic-install-identity.ts
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INSTALL_IDENTITY_SCRATCH_PREFIX,
  isProcessAlive,
  runHostPid,
  scratchNameFor,
  sweepOrphanInstallIdentityDirs,
} from './hermetic-install-identity.js';
import { rmrf } from '../../tools/test-helpers/temp-dir.js';

describe('hermetic install identity scratch directory', () => {
  /**
   * `vitest.config.ts` sets the run id in the host process, and the worker inherits it.
   * An absent value shows that the run id did not cross the fork.
   */
  it('InstallIdentityScratch_IsKeyedOnThisRunsHostProcessAndRunId', () => {
    const dir = process.env['EXARCHOS_INSTALL_STATE_DIR'];
    const runId = process.env['EXARCHOS_TEST_RUN_ID'];

    expect(runId, 'the run id did not reach the worker').toMatch(/^[a-z0-9]+$/);
    expect(dir).toBeDefined();
    expect(path.basename(dir ?? '')).toBe(scratchNameFor(runHostPid(), runId ?? ''));
    expect(fs.existsSync(dir ?? '')).toBe(true);
  });

  /** The test uses the real predicate on the one pid that exists during the assertion. */
  it('InstallIdentityLiveness_ThisProcessIsAlive', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  /**
   * The test injects liveness. The OS can give the pid of an exited child to a new
   * process, so a real dead pid is not reliable. The subject is the decision of the sweep.
   */
  it('InstallIdentitySweep_RemovesADeadRunsDirectoryAndKeepsLiveOnes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-identity-sweep-'));
    try {
      const deadPid = 4_000_001;
      const livePid = 4_000_002;
      const hostPid = 4_000_003;
      const alive = (pid: number) => pid === livePid || pid === hostPid;
      const dead = scratchNameFor(deadPid, 'run1');
      const live = scratchNameFor(livePid, 'run2');
      const ours = scratchNameFor(hostPid, 'run3');
      const unrelated = 'exarchos-test-install-identity';
      const randomSuffix = `${INSTALL_IDENTITY_SCRATCH_PREFIX}3TLy7g`;
      for (const name of [dead, live, ours, unrelated, randomSuffix]) {
        fs.mkdirSync(path.join(tmp, name));
        fs.writeFileSync(path.join(tmp, name, 'lock.json'), '{}');
      }

      const removed = sweepOrphanInstallIdentityDirs(tmp, ours, hostPid, alive);

      expect(removed).toEqual([dead]);
      expect(fs.existsSync(path.join(tmp, dead))).toBe(false);
      expect(fs.existsSync(path.join(tmp, live)), 'a live run\'s directory was swept').toBe(true);
      expect(fs.existsSync(path.join(tmp, ours)), 'the current run\'s directory was swept').toBe(true);
      expect(fs.existsSync(path.join(tmp, unrelated)), 'a non-scratch entry was swept').toBe(true);
      expect(
        fs.existsSync(path.join(tmp, randomSuffix)),
        'a non-numeric suffix was parsed as a pid and swept',
      ).toBe(true);
    } finally {
      rmrf(tmp);
    }
  });

  /**
   * The pid of an exited host can go to this host, so the earlier directory reads as alive.
   * Only the run id separates the two. The sweep must remove a directory that holds this
   * pid under another run id or under the bare-pid name. If it stays, this run inherits its lock.
   */
  it('InstallIdentitySweep_AnEarlierIncarnationOfThisHostsPid_IsSweptNotReused', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-identity-reuse-'));
    try {
      const hostPid = 4_000_004;
      const alive = () => true;
      const ours = scratchNameFor(hostPid, 'thisrun');
      const earlier = scratchNameFor(hostPid, 'lastrun');
      const barePid = `${INSTALL_IDENTITY_SCRATCH_PREFIX}${hostPid}`;
      for (const name of [ours, earlier, barePid]) {
        fs.mkdirSync(path.join(tmp, name));
        fs.writeFileSync(path.join(tmp, name, 'lock.json'), '{}');
      }

      const removed = sweepOrphanInstallIdentityDirs(tmp, ours, hostPid, alive);

      expect(removed.sort()).toEqual([earlier, barePid].sort());
      expect(fs.existsSync(path.join(tmp, ours)), 'the current run\'s directory was swept').toBe(true);
    } finally {
      rmrf(tmp);
    }
  });
});
